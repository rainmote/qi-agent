(ns qi.plugins.lcu
  "LCU desktop provider using the installed official shared client."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.cancellation :as cancellation]
            [qi.computer-use-mcp :as computer]
            [qi.kernel :as kernel]
            [qi.secure-files :as secure]
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
  ;; Microphone consent is not implemented.
  (when-not (contains? #{[] ["--chrome"]} lcu-args)
    (throw (ex-info "LCU :lcu-args supports only [] or [\"--chrome\"]; audio and setup commands are unsupported" {})))
  (if (seq lcu-args) ["browser" "computer"] ["computer"]))

(defn- approval! [ctx expected-scope active? {:keys [id method params]} {:keys [cancel-token]}]
  (if (not= "qi/approval" method)
    {:choice "cancel"}
    (let [prompt (kernel/service ctx :ui/prompt)
          {:keys [message resource choices kind scope]} params
          browser? (= "browser-origin" kind)
          current? (fn []
                     (and @active? (not (cancellation/cancelled? cancel-token))
                          (= expected-scope (select-keys scope [:sessionId :workspace :generation]))
                          (= (:sessionId scope) (:session-id (kernel/service ctx :session/store)))
                          (= (:workspace scope) (some-> (kernel/service ctx :execution/world) :root io/file .getCanonicalPath))
                          (= (:turnId scope) (when-let [session (kernel/service ctx :agent/session)]
                                              (:run-id ((:state session)))))
                          (= id (:approvalId scope))
                          (= (if browser? resource nil) (:origin scope))))]
      ;; Runtime app consent is a separate human decision. :approval :allow
      ;; and saved tool grants must never silently accept an app prompt.
      (if (and (contains? #{"native-app" "browser-origin"} kind) (current?)
               prompt (or (nil? (:active? prompt)) ((:active? prompt)))
               (string? message) (string? resource) (vector? choices))
        (let [values (if browser? {"once" :allow "decline" :deny}
                        {"once" :allow "session" :allow-session "decline" :deny})
              items (into [] (keep (fn [{:keys [value label]}]
                             (when-let [mapped (get values value)]
                               {:label label :value mapped}))) choices)
              choice ((:select! prompt)
                      {:title (str (if browser? "Browser site: " "Computer use: ") resource)
                       :message message :cancel-token cancel-token
                       :items items :default (if browser? :cancel :deny)})
              original (get {:allow "once" :allow-session "session" :deny "decline"} choice)]
          {:scope scope
           :choice (if (and (current?)
                            (contains? values original)
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
        scope {:sessionId (:session-id (kernel/require-service ctx :session/store))
               :workspace (.getCanonicalPath (io/file (:cwd options)))
               :generation (:connection-generation options)}
        active? (atom true)
        runtime-root (when (seq lcu-args) (fs/create-temp-dir {:prefix "qi-lcu-browser-"}))
        cleanup-lock (Object.)
        cleanup-error (atom nil)
        cleanup! (fn [] (locking cleanup-lock
                         (when (and runtime-root (fs/exists? runtime-root)) (fs/delete-tree runtime-root))))
        connection (try
                     (when runtime-root (secure/protect-directory! runtime-root))
                     (mcp/connect! (assoc options
                                  :command (into [node (bridge-path) home] lcu-args)
                                  :env (cond-> (assoc (:env options {}) "CUA_REPL_ENABLED_SURFACES" enabled-surfaces
                                                     "SKY_ENABLE_AUDIO" "0" "NODE_REPL_ENABLE_AUDIO" "0"
                                                     "QI_LCU_SCOPE" (json/generate-string scope))
                                         runtime-root (assoc "QI_LCU_RUNTIME_ROOT" (str runtime-root)))
                                  :startup-timeout-ms (max 120000 (:startup-timeout-ms options))
                                  :shutdown-timeout-ms 10000
                                  :client-capabilities {:elicitation {}}
                                  :pause-timeout-on-server-request true
                                  :on-request (partial approval! ctx scope active?)))
                     (catch Throwable error (reset! active? false) (cleanup!) (throw error)))
        close! (fn []
                 (reset! active? false)
                 (try
                   (try ((:close! connection))
                        (finally
                          ;; :alive? can become false before reaping completes.
                          ;; Remove owned state only after the bridge PID is gone.
                          (let [handle (java.lang.ProcessHandle/of (:pid connection))]
                            (if (and (.isPresent handle) (.isAlive (.get handle)))
                              (throw (ex-info "LCU bridge cleanup is incomplete" {:uncertain true}))
                              (cleanup!)))))
                   (catch Throwable error
                     (reset! cleanup-error error)
                     (kernel/emit! ctx :computer-use/cleanup-failed
                                   {:provider "lcu" :message (ex-message error)})
                     (throw error))))
        _ (when runtime-root
            ;; Also remove owned preferences after unexpected idle EOF. The
            ;; transport's promise resolves after its process teardown attempt.
            (future @(:closed connection) (try (close!) (catch Throwable _))))
        turn (atom nil)
        end! (fn [event]
               (when @turn
                 (try
                   ((:request! connection) "qi/turn-ended" {:event event} {:timeout-ms 130000})
                   (kernel/emit! ctx :computer-use/turn-ended
                                 {:provider "lcu" :turn-id @turn :event event})
                   (reset! turn nil)
                   (catch Throwable error
                     (reset! cleanup-error error)
                     (close!)
                     (kernel/emit! ctx :computer-use/cleanup-failed
                                   {:provider "lcu" :message (ex-message error)})))))
        dispose-listener (kernel/on! ctx :agent.run/end
                                     (fn [_ event]
                                       (when (= @turn (:run-id event))
                                         (end! (if (= :completed (:status event)) "Stop" "Interrupt")))))]
    (when (str/blank? (:instructions connection))
      (dispose-listener)
      (close!)
      (throw (ex-info "LCU did not supply its required initialization instructions" {})))
    (assoc connection
           :failure (fn [] (when-let [error @cleanup-error]
                             {:uncertain true :reason :cleanup-failed :message (ex-message error)}))
           :instructions (str (:instructions connection)
                              "\nIn qì, invoke the original js/js_reset tools as computer_js/computer_js_reset.")
           :close! (fn [] (dispose-listener) (close!))
           :request!
           (fn [method params execution]
             (when @cleanup-error
               (throw (ex-info "LCU turn cleanup failed; use /computer reconnect" {:uncertain true})))
             (let [params
                   (if (= method "tools/call")
                     (let [session-id (:session-id (kernel/require-service ctx :session/store))
                           state ((:state (kernel/require-service ctx :agent/session)))
                           turn-id (:run-id state)]
                       (when-not (and @active? (= session-id (:sessionId scope)) turn-id
                                      (= (:workspace scope) (some-> (kernel/service ctx :execution/world) :root io/file .getCanonicalPath)))
                         (throw (ex-info "LCU requires an active agent session and turn" {})))
                       (reset! turn turn-id)
                       (assoc params :_meta {"qi/turn" (assoc scope :turnId turn-id :toolCallId (:call-id execution))}))
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
     :description "Opt-in LCU provider with scoped browser-origin and separate native-app consent."
     :capabilities (fn [config] {:surfaces (surfaces config)
                                :browser-origin-consent (if (seq (:lcu-args config)) :interactive :disabled)
                                :native-app-consent :interactive
                                :system-permissions :unverified})
     :tool-guidance ""
     :uncertain-on-error true
     :connect! connect!})
   :requires conj :session/store))
