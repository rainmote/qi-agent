(ns qi.cli
  (:require [qi.command :as command]
            [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.protocol :as protocol]
            [qi.plugins.trust :as trust]
            [clojure.string :as str]))

(defn- session-plugin-index [plugins]
  (first
   (keep-indexed
    (fn [index spec]
      (when (= 'qi.plugins.session (:ns spec)) index))
    plugins)))

(def usage
  (let [command (or (qenv/get "QI_AGENT_COMMAND" "BB_AGENT_COMMAND") "qi-agent")]
    (str "Babashka plugin LLM agent\n\n"
         "  " command " [--config agent.edn] --once \"prompt\"\n"
         "  " command " [--config agent.edn] --provider PROVIDER --once \"prompt\"\n"
         "  " command " [--config agent.edn] --mode json --once \"prompt\"\n"
         "  " command " [--config agent.edn] --mode rpc\n"
         "  " command " [--config agent.edn] --mode rpc --approval-mode ask\n"
         "  " command " [--config agent.edn]\n"
         "  " command " [--config agent.edn] --list\n"
         "  " command " --session PATH [--once \"prompt\"]\n"
         "  " command " --session PATH --fork DESTINATION\n"
         "  " command " --session PATH --compact\n"
         "  " command " --session PATH --session-info\n")))

(defn- parse-args [args]
  (loop [remaining args
         options {:config "agent.edn"}]
    (if-let [argument (first remaining)]
      (case argument
        "--config" (if-let [path (second remaining)]
                     (recur (nnext remaining) (assoc options :config path))
                     (throw (ex-info "--config requires a path" {})))
        "--once" (if-let [prompt (second remaining)]
                   (recur (nnext remaining) (assoc options :prompt prompt))
                     (throw (ex-info "--once requires a prompt" {})))
        "--session" (if-let [path (second remaining)]
                      (recur (nnext remaining)
                             (assoc options :session path))
                      (throw (ex-info "--session requires a path" {})))
        "--fork" (if-let [path (second remaining)]
                   (recur (nnext remaining) (assoc options :fork path))
                   (throw (ex-info "--fork requires a destination" {})))
        "--compact" (recur (next remaining) (assoc options :compact true))
        "--session-info"
        (recur (next remaining) (assoc options :session-info true))
        "--provider" (if-let [id (second remaining)]
                       (recur (nnext remaining)
                              (assoc options :provider (keyword id)))
                       (throw (ex-info "--provider requires an id" {})))
        "--approval-mode" (if-let [mode (second remaining)]
                            (let [value (keyword mode)]
                              (when-not (contains? #{:allow :deny :ask} value)
                                (throw (ex-info
                                        "--approval-mode must be allow, deny, or ask"
                                        {:mode mode})))
                              (recur (nnext remaining)
                                     (assoc options :approval-mode value)))
                            (throw (ex-info
                                    "--approval-mode requires a value" {})))
        "--mode" (if-let [mode (second remaining)]
                   (let [value (keyword mode)]
                     (when-not (contains? #{:print :json :rpc} value)
                       (throw (ex-info "--mode must be print, json, or rpc"
                                       {:mode mode})))
                     (recur (nnext remaining) (assoc options :mode value)))
                   (throw (ex-info "--mode requires a value" {})))
        "--list" (recur (next remaining) (assoc options :list true))
        "--help" (assoc options :help true)
        "-h" (assoc options :help true)
        (throw (ex-info (str "Unknown argument: " argument) {})))
      options)))

(defn- with-session-path [config path]
  (if-not path
    config
    (let [plugins (:plugins config)
          index (session-plugin-index plugins)]
      (when-not index
        (throw (ex-info "Profile has no session plugin to configure" {})))
      (assoc-in config [:plugins index :config :path] path))))

(defn- for-mode [config mode]
  (update config :plugins
          (fn [plugins]
            (->> plugins
                 (remove #(and (contains? #{:json :rpc} mode)
                               (= 'qi.plugins.stream-console (:ns %))))
                 vec))))

(defn- approval-plugin-index [plugins]
  (first
   (keep-indexed
    (fn [index spec]
      (when (= 'qi.plugins.approval (:ns spec)) index))
    plugins)))

(defn- with-approval-mode [config mode]
  (if-not mode
    config
    (let [index (approval-plugin-index (:plugins config))]
      (when-not index
        (throw (ex-info "Profile has no approval plugin to configure" {})))
      (assoc-in config [:plugins index :config :mode] mode))))

(defn- with-remote-interaction [config mode]
  (if (not= :rpc mode)
    config
    (let [plugins (:plugins config)
          approval-index (approval-plugin-index plugins)]
      (if (or (nil? approval-index)
              (some #(= 'qi.plugins.remote-interaction (:ns %)) plugins))
        config
        (assoc config :plugins
               (vec (concat (subvec plugins 0 approval-index)
                            [{:ns 'qi.plugins.remote-interaction}]
                            (subvec plugins approval-index))))))))

(defn- print-inventory [ctx]
  (println "Plugins:")
  (doseq [{:keys [id description]} (kernel/loaded-plugins ctx)]
    (println " " id "-" description))
  (println "Tools:")
  (doseq [{:keys [name description]} (kernel/tools ctx)]
    (println " " name "-" description))
  (println "Commands:")
  (doseq [{:keys [name description]} (command/commands ctx)]
    (println (str " /" name " - " description))))

(defn- run-and-print! [ctx run prompt]
  (when-let [streaming (kernel/service ctx :output/streaming)]
    ((:reset! streaming)))
  (let [result (run prompt)
        streaming (kernel/service ctx :output/streaming)
        streamed? (and streaming ((:printed? streaming)))]
    (when-not streamed?
      (println (:content result)))
    result))

(defn- session-info [store]
  {:session-id (:session-id store)
   :path (:path store)
   :event-count (count ((:events store)))
   :message-count (count ((:messages store)))
   :diagnostics ((:diagnostics store))})

(defn- interactive! [ctx]
  (let [agent-session (kernel/require-service ctx :agent/session)
        store (kernel/require-service ctx :session/store)
        tasks (atom #{})
        submit!
        (fn [message]
          (when-let [streaming (kernel/service ctx :output/streaming)]
            ((:reset! streaming)))
          (let [{:keys [task result]} ((:submit! agent-session) message)]
            (swap! tasks conj task)
            (future
              (let [{:keys [ok value error]} @result
                    streaming (kernel/service ctx :output/streaming)
                    streamed? (and streaming ((:printed? streaming)))]
                (if ok
                  (when-not streamed? (println (:content value)))
                  (binding [*out* *err*]
                    (println "Error:" (ex-message error))))
                (swap! tasks disj task)
                (print "agent> ")
                (flush)))))]
    (println "Commands: /commands lists all available commands")
    (loop []
      (print "agent> ")
      (flush)
      (when-let [line (read-line)]
        (let [command (str/trim line)]
          (if (str/starts-with? command "/")
            (let [{:keys [quit? output error]} (command/dispatch! ctx command)]
              (cond
                quit? (do
                        ((:abort! agent-session))
                        (doseq [task @tasks] (deref task 1000 nil))
                        nil)
                :else (do
                        (when error (println error))
                        (when (some? output)
                          (println (if (string? output) output (pr-str output))))
                        (recur))))
            (do
              (when-not (str/blank? line)
                (try
                  (if (= :idle (:phase ((:state agent-session))))
                    (submit! line)
                    (do
                      ((:follow-up! agent-session) line)
                      (println "Follow-up queued.")))
                  (catch Throwable error
                    (binding [*out* *err*]
                      (println "Error:" (ex-message error))))))
              (recur))))))))

(defn -main [& args]
  (let [{profile-path :config
         session-info? :session-info
         :keys [prompt list help session fork compact provider mode
                approval-mode]}
        (parse-args args)]
    (if help
      (println usage)
      (let [mode (or mode :print)
            config (-> (plugin/read-config profile-path)
                       (with-session-path session)
                       (for-mode mode)
                       (with-remote-interaction mode)
                       (with-approval-mode approval-mode))
            allow-external-plugins (trust/trusted-root? ".")]
        (let [ctx (plugin/boot! config
                                {:allow-external-plugins
                                 allow-external-plugins})]
          (try
            (when provider
              ((:select! (kernel/require-service ctx :llm/registry))
               provider))
            (let [store (kernel/require-service ctx :session/store)]
              (cond
                list (print-inventory ctx)
                fork (println (pr-str ((:fork! store) fork)))
                compact (println (pr-str ((:compact! store))))
                session-info? (println (pr-str (session-info store)))
                (= :rpc mode) (protocol/rpc! ctx)
                (= :json mode)
                (if prompt
                  (protocol/json-once! ctx prompt)
                  (throw (ex-info "JSON mode requires --once PROMPT" {})))
                prompt (run-and-print!
                        ctx (kernel/require-service ctx :agent/run) prompt)
                :else (interactive! ctx)))
            (finally
              (kernel/dispose-all! ctx))))))))

(defn entrypoint
  "Command-line boundary with concise user-facing failures.

  Embedders should continue to call `-main` or `qi.api`; only this process
  boundary exits the JVM. Set QI_AGENT_DEBUG=1 to include a stack trace."
  [& args]
  (try
    (apply -main args)
    (catch Throwable error
      (binding [*out* *err*]
        (println "Error:" (or (ex-message error) (str error)))
        (when (= "1" (qenv/get "QI_AGENT_DEBUG" "BB_AGENT_DEBUG"))
          (.printStackTrace error *err*)))
      (System/exit 1))))
