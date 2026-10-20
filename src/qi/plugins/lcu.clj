(ns qi.plugins.lcu
  "LCU desktop provider using the installed official shared client."
  (:require [babashka.fs :as fs]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.cancellation :as cancellation]
            [qi.computer-use-mcp :as computer]
            [qi.kernel :as kernel]
            [qi.mcp-stdio :as mcp]))

(defn- default-home []
  (or (System/getenv "LCU_HOME")
      (if (= "Linux" (System/getProperty "os.name"))
        "/opt/lcu/current"
        (str (fs/path (System/getProperty "user.home") ".local/share/lcu/current")))))

(defn- bridge-path []
  ;; Resolve against the installed source, not the user's execution workspace.
  (str (fs/normalize (fs/path (fs/parent (io/file (io/resource "qi/plugins/lcu.clj")))
                              "../../../scripts/lcu/bridge.mjs"))))

(defn- surfaces [{:keys [lcu-args] :or {lcu-args []}}]
  ;; Do not inherit a browser/audio opt-in from an unrelated host process.
  ;; This adapter has no interactive browser-origin or microphone consent.
  (when-not (contains? #{[] ["--chrome"]} lcu-args)
    (throw (ex-info "LCU :lcu-args supports only [] or [\"--chrome\"]; audio and setup commands are unsupported" {})))
  (if (seq lcu-args) ["browser" "computer"] ["computer"]))

(defn- approval! [ctx {:keys [method params]} {:keys [cancel-token]}]
  (if (not= "qi/approval" method)
    {:choice "cancel"}
    (let [prompt (kernel/service ctx :ui/prompt)
          {:keys [message resource choices]} params]
      ;; Runtime app consent is a separate human decision. :approval :allow
      ;; and saved tool grants must never silently accept an app prompt.
      (if (and prompt (or (nil? (:active? prompt)) ((:active? prompt)))
               (string? message) (string? resource) (vector? choices))
        (let [values {"once" :allow "session" :allow-session "decline" :deny}
              items (into [] (keep (fn [{:keys [value label]}]
                             (when-let [mapped (get values value)]
                               {:label label :value mapped}))) choices)
              choice ((:select! prompt)
                      {:title (str "Computer use: " resource)
                       :message message :cancel-token cancel-token
                       :items items :default :deny})
              original (get {:allow "once" :allow-session "session" :deny "decline"} choice)]
          {:choice (if (and (not (cancellation/cancelled? cancel-token))
                           (some #(= original (:value %)) choices)) original "cancel")})
        {:choice "cancel"}))))

(defn- connect! [ctx {:keys [lcu-home lcu-args node-command]
                     :or {lcu-args []}} options]
  (let [home (str (fs/absolutize (or lcu-home (default-home))))
        node-file (fs/path home "node-path")
        node (or node-command (when (fs/exists? node-file) (str/trim (slurp (str node-file))))
                 (some-> (fs/which "node") str))
        _ (when-not (and node (fs/exists? (fs/path home "adapters/client.mjs"))
                         (fs/exists? (fs/path home "bin/lcu")))
            (throw (ex-info "Install an LCU release first; configure :lcu-home or LCU_HOME (see docs/lcu.md)"
                            {:lcu-home home})))
        enabled-surfaces (str/join "," (surfaces {:lcu-args lcu-args}))
        connection (mcp/connect! (assoc options
                                  :command (into [node (bridge-path) home] lcu-args)
                                  :env (assoc (:env options {}) "CUA_REPL_ENABLED_SURFACES" enabled-surfaces
                                              "SKY_ENABLE_AUDIO" "0" "NODE_REPL_ENABLE_AUDIO" "0")
                                  :startup-timeout-ms (max 120000 (:startup-timeout-ms options))
                                  :shutdown-timeout-ms 10000
                                  :client-capabilities {:elicitation {}}
                                  :pause-timeout-on-server-request true
                                  :on-request (partial approval! ctx)))
        turn (atom nil)
        cleanup-error (atom nil)
        end! (fn [event]
               (when @turn
                 (try
                   ((:request! connection) "qi/turn-ended" {:event event} {:timeout-ms 130000})
                   (kernel/emit! ctx :computer-use/turn-ended
                                 {:provider "lcu" :turn-id @turn :event event})
                   (reset! turn nil)
                   (catch Throwable error
                     (reset! cleanup-error error)
                     ((:close! connection))
                     (kernel/emit! ctx :computer-use/cleanup-failed
                                   {:provider "lcu" :message (ex-message error)})))))
        dispose-listener (kernel/on! ctx :agent.run/end
                                     (fn [_ event]
                                       (when (= @turn (:run-id event))
                                         (end! (if (= :completed (:status event)) "Stop" "Interrupt")))))]
    (when (str/blank? (:instructions connection))
      (dispose-listener)
      ((:close! connection))
      (throw (ex-info "LCU did not supply its required initialization instructions" {})))
    (assoc connection
           :failure (fn [] (when-let [error @cleanup-error]
                             {:uncertain true :reason :cleanup-failed :message (ex-message error)}))
           :instructions (str (:instructions connection)
                              "\nIn qì, invoke the original js/js_reset tools as computer_js/computer_js_reset.")
           :close! (fn [] (dispose-listener) ((:close! connection)))
           :request!
           (fn [method params execution]
             (when @cleanup-error
               (throw (ex-info "LCU turn cleanup failed; use /computer reconnect" {:uncertain true})))
             (let [params
                   (if (= method "tools/call")
                     (let [session-id (:session-id (kernel/require-service ctx :session/store))
                           state ((:state (kernel/require-service ctx :agent/session)))
                           turn-id (:run-id state)]
                       (when-not (and session-id turn-id)
                         (throw (ex-info "LCU requires an active agent session and turn" {})))
                       (reset! turn turn-id)
                       (assoc params :_meta {"qi/turn" {:sessionId session-id :turnId turn-id
                                                      :toolCallId (:call-id execution)}}))
                     params)]
               (try
                 ((:request! connection) method params execution)
                 (catch Throwable error
                   ;; An SDK/bridge exception may follow partially delivered
                   ;; input. It is not a definite upstream isError result.
                   (throw (if (= method "tools/call")
                            (ex-info (ex-message error) (assoc (ex-data error) :uncertain true) error)
                            error)))))))))

(def plugin
  (update
   (computer/provider-plugin
    {:id :computer-use/lcu :provider-name "lcu"
     :description "Opt-in LCU desktop provider with native app consent and turn cleanup."
     :capabilities (fn [config] {:surfaces (surfaces config)
                                :browser-origin-consent :unsupported
                                :native-app-consent :interactive
                                :system-permissions :unverified})
     :tool-guidance ""
     :uncertain-on-error true
     :connect! connect!})
   :requires conj :session/store))
