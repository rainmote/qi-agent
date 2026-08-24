(ns agent.plugins.bb-repl
  "Persistent external Babashka process exposed as an execution service."
  (:require [agent.kernel :as kernel]
            [agent.sandbox :as sandbox]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(def ^:private seatbelt-profile
  (str "(version 1)\n"
       "(deny default)\n"
       "(allow process*)\n"
       "(allow signal)\n"
       "(allow sysctl-read)\n"
       "(allow mach-lookup)\n"
       "(allow ipc-posix-sem*)\n"
       "(allow ipc-posix-shm*)\n"
       ;; Babashka resolves classpath entries by walking their ancestors. Only
       ;; metadata is visible outside WORKSPACE; file contents remain denied.
       "(allow file-read-metadata (subpath \"/Users\"))\n"
       "(allow file-read*\n"
       "  (literal \"/\")\n"
       "  (literal \"/var\")\n"
       "  (literal \"/etc\")\n"
       "  (subpath \"/System\")\n"
       "  (subpath \"/usr\")\n"
       "  (subpath \"/bin\")\n"
       "  (subpath \"/sbin\")\n"
       "  (subpath \"/Library\")\n"
       "  (subpath \"/private\")\n"
       "  (subpath \"/dev\")\n"
       "  (subpath (param \"WORKSPACE\")))\n"
       "(allow file-write*\n"
       "  (subpath (param \"WRITABLE\"))\n"
       "  (subpath (param \"ARTIFACT\")))\n"))

(defn- absolute-classpath []
  (let [separator (System/getProperty "path.separator")
        cwd (fs/path (System/getProperty "user.dir"))]
    (->> (str/split (System/getProperty "java.class.path")
                    (re-pattern (java.util.regex.Pattern/quote separator)))
         (map #(let [path (fs/path %)]
                 (str (if (fs/absolute? path)
                        path
                        (fs/absolutize (fs/path cwd path))))))
         (str/join separator))))

(defn- worker-command [{:keys [command root sandbox writable-root artifact-root]}]
  (let [base [(str command) "-cp" (absolute-classpath)
              "-m" "agent.repl-worker"]]
    (case sandbox
      :none base
      :seatbelt (into ["/usr/bin/sandbox-exec"
                       "-D" (str "WORKSPACE=" root)
                       "-D" (str "WRITABLE=" writable-root)
                       "-D" (str "ARTIFACT=" artifact-root)
                       "-p" seatbelt-profile]
                      base))))

(defn- start-worker! [{:keys [root writable-root artifact-root agent-id
                              state-path outbox-path]
                       :as config}]
  (fs/create-dirs writable-root)
  (fs/create-dirs artifact-root)
  (let [child (process/process
               {:cmd (worker-command config)
                :dir (str root)
                :extra-env {"DAO_AGENT_ID" agent-id
                            "DAO_AGENT_ARTIFACT_ROOT" (str artifact-root)
                            "DAO_AGENT_STATE_PATH" (str state-path)
                            "DAO_AGENT_OUTBOX_PATH" (str outbox-path)}
                :err :inherit})]
    {:process child
     :writer (io/writer (:in child))
     :reader (io/reader (:out child))}))

(defn- stop-worker! [worker]
  (when worker
    (try (.close ^java.io.Writer (:writer worker)) (catch Throwable _))
    (try (.close ^java.io.Reader (:reader worker)) (catch Throwable _))
    (try (process/destroy-tree (:process worker)) (catch Throwable _)))
  nil)

(defn- worker-alive? [worker]
  (and worker (.isAlive ^Process (get-in worker [:process :proc]))))

(defn- repl-namespace [agent-id]
  (str "dao.agent." (str/replace agent-id #"[^A-Za-z0-9_-]" "-")))

(defn- failed-result [agent-id message]
  {:ok false
   :backend "bb-repl"
   :namespace (repl-namespace agent-id)
   :stdout ""
   :stderr ""
   :error message
   :truncated false
   :duration_ms 0})

(defn- load-replay-cells [path]
  (if-not (.isFile (io/file path))
    []
    (with-open [reader (io/reader path)]
      (->> (line-seq reader)
           (keep (fn [line]
                   (try
                     (let [cell (json/parse-string line true)]
                       (when (and (:replay_safe cell) (string? (:code cell)))
                         (:code cell)))
                     (catch Throwable _ nil))))
           vec))))

(defn- exchange! [worker config request]
  (.write ^java.io.Writer (:writer worker) (str (pr-str request) "\n"))
  (.flush ^java.io.Writer (:writer worker))
  (let [read-task (future (.readLine ^java.io.BufferedReader (:reader worker)))
        line (deref read-task (:timeout-ms config) ::timeout)]
    (cond
      (= ::timeout line)
      (do
        (future-cancel read-task)
        (throw (ex-info "REPL evaluation timed out" {:repl-timeout true})))

      (nil? line)
      (throw (ex-info "Babashka REPL process exited unexpectedly"
                      {:repl-exited true}))

      :else
      (let [response (edn/read-string line)]
        (when-not (= (:id request) (:id response))
          (throw (ex-info "Babashka REPL response id did not match" {})))
        (dissoc response :id)))))

(defn- start-and-replay! [state lifecycle config]
  (swap! lifecycle assoc :status :starting)
  (let [worker (start-worker! config)
        codes (load-replay-cells (:cells-path config))]
    (try
      (doseq [code codes]
        (let [response (exchange!
                        worker config
                        {:id (str (random-uuid))
                         :op :eval
                         :code code
                         :max-output-chars (:max-output-chars config)
                         :print-length (:print-length config)
                         :print-level (:print-level config)})]
          (when-not (:ok response)
            (throw (ex-info "A replay-safe REPL cell failed during recovery"
                            {:response response})))))
      (reset! state worker)
      (let [restarting? (:ever-started @lifecycle)
            reason (:restart-reason @lifecycle)]
        (swap! lifecycle assoc :status :ready
               :pid (some-> worker :process :proc .pid)
               :current-eval nil
               :last-error nil
               :ever-started true
               :restart-reason nil
               :replayed-cells (count codes))
        (when restarting?
          ((:on-restart config) {:reason reason
                                 :replayed-cells (count codes)
                                 :namespace (repl-namespace (:agent-id config))})))
      worker
      (catch Throwable error
        (stop-worker! worker)
        (swap! lifecycle assoc :status :failed :pid nil :current-eval nil
               :last-error (ex-message error))
        (throw error)))))

(defn- request! [state lock lifecycle config request]
  (locking lock
    (let [worker (if (worker-alive? @state)
                   @state
                   (start-and-replay! state lifecycle config))
          id (str (random-uuid))
          request (merge {:id id
                          :op :eval
                          :max-output-chars (:max-output-chars config)
                          :print-length (:print-length config)
                          :print-level (:print-level config)}
                         request)]
      (swap! lifecycle assoc :status :busy :current-eval id)
      (try
        (let [response (exchange! worker config request)]
          (swap! lifecycle assoc :status :ready :current-eval nil
                 :last-error (when-not (:ok response) (:error response)))
          response)
        (catch Throwable error
          (stop-worker! worker)
          (reset! state nil)
          (swap! lifecycle update :restart-count inc)
          (swap! lifecycle assoc :status :cold :pid nil :current-eval nil
                 :restart-reason (if (:repl-timeout (ex-data error))
                                   :timeout :crash)
                 :last-error (ex-message error))
          (failed-result
           (:agent-id config)
           (if (:repl-timeout (ex-data error))
             (str "Evaluation timed out after " (:timeout-ms config)
                  " ms; only this REPL was stopped")
             (ex-message error))))))))

(defn- replay-safe-definition? [code]
  (and (re-find #"(?s)^\s*\((def|defn|defmacro|defonce)\b" code)
       (not (re-find #"(?i)\b(spit|slurp|shell|process|http|load-file|eval|future)\b"
                     code))))

(defn- append-cell! [path cell]
  (when path
    (when-let [parent (.getParentFile (io/file path))] (.mkdirs parent))
    (spit path (str (json/generate-string cell) "\n") :append true)))

(def plugin
  {:id :execution/bb-repl
   :description "Persistent, restartable Babashka REPL execution backend."
   :provides #{:execution/repl}
   :start
   (fn [ctx {:keys [root command sandbox writable-dir timeout-ms max-code-chars
                    max-output-chars print-length print-level agent-id]
             :or {root "."
                  command "bb"
                  sandbox :auto
                  writable-dir ".bb-agent/sandbox"
                  timeout-ms 10000
                  max-code-chars 50000
                  max-output-chars 20000
                  print-length 200
                  print-level 20}}]
     (when-not (and (pos-int? timeout-ms)
                    (pos-int? max-code-chars)
                    (pos-int? max-output-chars)
                    (pos-int? print-length)
                    (pos-int? print-level))
       (throw (ex-info "Babashka REPL numeric limits must be positive integers"
                       {:timeout-ms timeout-ms
                        :max-code-chars max-code-chars
                        :max-output-chars max-output-chars})))
     (let [workspace-root (fs/real-path root)
           mode (sandbox/resolve-mode sandbox)]
       (if (= :unavailable mode)
         (do
           (kernel/register-service!
            ctx :execution/repl
            {:backend :unavailable
             :sandbox :unavailable
             :available? false
             :reason "No safe Babashka sandbox is available on this OS."})
           nil)
         (let [command-path
               (or (fs/which command)
                   (throw (ex-info "Babashka command was not found"
                                   {:command command})))
               store (kernel/service ctx :session/store)
               session-id (or (:session-id store) (System/getenv "DAO_AGENT_ID")
                              "ephemeral")
               agent-id (or agent-id (System/getenv "DAO_AGENT_ID") session-id)
               writable-root
               (fs/absolutize (fs/path workspace-root writable-dir agent-id))
               _ (when-not (fs/starts-with? writable-root workspace-root)
                   (throw
                    (ex-info
                     "Sandbox writable directory must be inside the project root"
                     {:writable-dir (str writable-root)})))
               state (atom nil)
               lock (Object.)
               lifecycle (atom {:status :cold
                                :pid nil
                                :current-eval nil
                                :restart-count 0
                                :last-error nil
                                :ever-started false
                                :replayed-cells 0})
               artifact-root (fs/path workspace-root ".bb-agent" "artifacts"
                                      session-id "agents" agent-id "repl")
               cells-path (str (fs/path artifact-root "cells.jsonl"))
               state-service (kernel/service ctx :agent/durable-state)
               state-path (or (:path state-service)
                              (str (fs/path artifact-root "state.edn")))
               outbox-path (str (fs/path artifact-root "host-outbox.edn"))
               on-restart
               (fn [data]
                 (let [data (assoc data :agent_id agent-id
                                        :restart_count (:restart-count @lifecycle))]
                   (when store
                     ((:append! store) "repl/restarted" data))
                   (kernel/emit! ctx :repl/restarted data)))
               config {:root workspace-root
                       :command command-path
                       :sandbox mode
                       :writable-root writable-root
                       :artifact-root artifact-root
                       :state-path state-path
                       :outbox-path outbox-path
                       :cells-path cells-path
                       :agent-id agent-id
                       :on-restart on-restart
                       :timeout-ms timeout-ms
                       :max-output-chars max-output-chars
                       :print-length print-length
                       :print-level print-level}
               eval!
               (fn [input]
                 (let [request-map? (map? input)
                       {:keys [code replay-safe replay_safe]
                        :as request}
                       (if (string? input) {:code input} input)
                       replay-safe? (boolean (or replay-safe replay_safe))]
                   (when-not (map? request)
                     (throw (ex-info "REPL eval request must be code or a map" {})))
                   (when-not (string? code)
                     (throw (ex-info "REPL code must be a string" {})))
                   (when (str/blank? code)
                     (throw (ex-info "REPL code must not be blank" {})))
                   (when (> (count code) max-code-chars)
                     (throw
                      (ex-info "REPL code exceeds configured limit"
                               {:max-code-chars max-code-chars})))
                   (when (and replay-safe? (not (replay-safe-definition? code)))
                     (throw
                      (ex-info
                       "Replay-safe cells must be side-effect-free top-level definitions"
                       {})))
                   (let [result (request! state lock lifecycle config
                                          {:code code})]
                     (when (and replay-safe? (:ok result))
                       (append-cell! cells-path
                                     {:id (str (random-uuid))
                                      :at (str (java.time.Instant/now))
                                      :replay_safe true
                                      :code code}))
                     (cond-> result request-map?
                       (assoc :replay_safe replay-safe?)))))
               interrupt!
               (fn [eval-id]
                 (let [current (:current-eval @lifecycle)]
                   (if (and current (or (nil? eval-id) (= current eval-id)))
                     (do
                       (stop-worker! @state)
                       (reset! state nil)
                       (swap! lifecycle update :restart-count inc)
                       (swap! lifecycle assoc :status :cold :pid nil
                              :current-eval nil :last-error "evaluation interrupted"
                              :restart-reason :interrupt)
                       true)
                     false)))
               reset-repl!
               (fn [_options]
                 (locking lock
                   (stop-worker! @state)
                   (reset! state nil)
                   (swap! lifecycle update :restart-count inc)
                   (swap! lifecycle assoc :status :cold :pid nil
                          :current-eval nil :last-error nil
                          :restart-reason :reset)
                   (start-and-replay! state lifecycle config)
                   {:reset true
                    :namespace (repl-namespace agent-id)
                    :replayed-cells (:replayed-cells @lifecycle)}))
               close!
               (fn []
                 (locking lock
                   (stop-worker! @state)
                   (reset! state nil)
                   (swap! lifecycle assoc :status :closed :pid nil
                          :current-eval nil)
                   {:closed true}))
               service
               {:backend :babashka
                :sandbox mode
                :available? true
                :writable-root (str writable-root)
                :namespace (repl-namespace agent-id)
                :status (fn [] (assoc @lifecycle
                                      :backend :babashka
                                      :namespace (repl-namespace agent-id)))
                :eval! eval!
                :interrupt! interrupt!
                :reset! reset-repl!
                :describe (fn [] {:backend :babashka
                                  :agent-id agent-id
                                  :namespace (repl-namespace agent-id)
                                  :sandbox mode
                                  :state-path state-path
                                  :cells-path cells-path
                                  :recovery :durable-state-and-replay-safe-cells})
                :close! close!}]
           (kernel/register-service! ctx :execution/repl service)
           #(locking lock
              (stop-worker! @state)
              (reset! state nil)
              (swap! lifecycle assoc :status :closed :pid nil
                     :current-eval nil))))))})
