(ns qi.repl-worker
  "Line-oriented EDN worker shared by Babashka and JVM Clojure REPL providers."
  (:require [clojure.edn :as edn]
            [qi.env :as qenv]
            [qi.secure-files :as secure]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.io StringWriter]
           [java.nio.file CopyOption Files StandardCopyOption]))

(defn- read-state [path]
  (if-not (and path (.isFile (io/file path)))
    {}
    (let [value (edn/read-string (slurp path))]
      (if (map? value) value {}))))

(defn- atomic-spit! [path value]
  (let [target (.getCanonicalFile (io/file path))
        parent (.getParentFile target)]
    (.mkdirs parent)
    (secure/protect-managed-parents! parent)
    (let [temporary (java.io.File/createTempFile ".qi-agent-repl-" ".tmp" parent)]
      (try
        (secure/protect-file! temporary)
        (spit temporary value)
        (try
          (Files/move (.toPath temporary) (.toPath target)
                      (into-array CopyOption
                                  [StandardCopyOption/ATOMIC_MOVE
                                   StandardCopyOption/REPLACE_EXISTING]))
          (catch Throwable error
            (if (.exists temporary)
              (Files/move (.toPath temporary) (.toPath target)
                          (into-array CopyOption
                                      [StandardCopyOption/REPLACE_EXISTING]))
              (throw error))))
        (finally
          (when (.exists temporary) (.delete temporary)))))
    (secure/protect-file! target)))

(defn- inside-artifact [artifact-root relative]
  (let [root (.getCanonicalFile (io/file artifact-root))
        target (.getCanonicalFile (io/file root relative))]
    (when-not (or (= root target)
                  (str/starts-with? (.getPath target)
                                    (str (.getPath root) java.io.File/separator)))
      (throw (ex-info "Artifact path escapes this agent's directory"
                      {:path relative})))
    target))

(defn- install-host-bridge! []
  (let [agent-id (or (qenv/get "QI_AGENT_ID" "DAO_AGENT_ID") "user")
        artifact-root (qenv/get "QI_AGENT_ARTIFACT_ROOT" "DAO_AGENT_ARTIFACT_ROOT")
        state-path (qenv/get "QI_AGENT_STATE_PATH" "DAO_AGENT_STATE_PATH")
        outbox-path (qenv/get "QI_AGENT_OUTBOX_PATH" "DAO_AGENT_OUTBOX_PATH")
        state-lock (Object.)
        state-ns (create-ns 'qi.state)
        artifact-ns (create-ns 'qi.artifact)
        agent-ns (create-ns 'qi.agent)
        task-ns (create-ns 'qi.task)]
    (intern state-ns 'snapshot (fn [] (locking state-lock (read-state state-path))))
    (intern state-ns 'get (fn [key] (clojure.core/get (read-state state-path) key)))
    (intern state-ns 'put!
            (fn [key value]
              (locking state-lock
                (atomic-spit! state-path
                              (str (pr-str (assoc (read-state state-path) key value))
                                   "\n")))
              value))
    (intern artifact-ns 'write!
            (fn [relative value]
              (let [target (inside-artifact artifact-root relative)]
                (.mkdirs (.getParentFile target))
                (secure/protect-managed-parents! (.getParentFile target))
                (secure/ensure-owner-file! target)
                (spit target (if (string? value) value (pr-str value)))
                {:path (.getPath target)
                 :bytes (.length target)})))
    (let [enqueue!
          (fn [operation request]
            (let [entry {:id (str (random-uuid))
                         :agent-id agent-id
                         :operation operation
                         :request request
                         :at (str (java.time.Instant/now))}]
              (.mkdirs (.getParentFile (io/file outbox-path)))
              (secure/protect-managed-parents! (.getParentFile (io/file outbox-path)))
              (secure/ensure-owner-file! outbox-path)
              (spit outbox-path (str (pr-str entry) "\n") :append true)
              (select-keys entry [:id :agent-id :operation])))]
      (intern agent-ns 'spawn! #(enqueue! :spawn %))
      (intern agent-ns 'send! #(enqueue! :send %)))
    (intern task-ns 'status
            (fn [] {:agent-id agent-id
                    :durable-state (read-state state-path)}))))

(defn- limited [value limit]
  (let [text (str value)
        truncated (> (count text) limit)]
    {:text (subs text 0 (min limit (count text)))
     :truncated truncated}))

(defn- render-value [value print-length print-level]
  (binding [*print-length* print-length
            *print-level* print-level]
    (pr-str value)))

(defn- evaluate [repl-ns {:keys [code max-output-chars
                                 print-length print-level]}]
  (let [stdout (StringWriter.)
        stderr (StringWriter.)
        started (System/nanoTime)
        base {:backend (or (qenv/get "QI_AGENT_REPL_BACKEND" "DAO_REPL_BACKEND")
                           "bb-repl")
              :namespace (str (ns-name repl-ns))}]
    (try
      (let [value (binding [*ns* repl-ns
                            *out* stdout
                            *err* stderr]
                    (load-string code))
            rendered (render-value value print-length print-level)
            value-result (limited rendered max-output-chars)
            stdout-result (limited stdout max-output-chars)
            stderr-result (limited stderr max-output-chars)]
        (assoc base
               :ok true
               :value (:text value-result)
               :stdout (:text stdout-result)
               :stderr (:text stderr-result)
               :truncated (boolean
                           (or (:truncated value-result)
                               (:truncated stdout-result)
                               (:truncated stderr-result)))
               :duration_ms (long (/ (- (System/nanoTime) started) 1000000))))
      (catch Throwable error
        (let [stdout-result (limited stdout max-output-chars)
              stderr-result (limited stderr max-output-chars)]
          (assoc base
                 :ok false
                 :error (or (ex-message error) (str (class error)))
                 :stdout (:text stdout-result)
                 :stderr (:text stderr-result)
                 :truncated (boolean
                             (or (:truncated stdout-result)
                                 (:truncated stderr-result)))
                 :duration_ms
                 (long (/ (- (System/nanoTime) started) 1000000))))))))

(defn- response [repl-ns request]
  (case (:op request)
    :eval (evaluate repl-ns request)
    :ping {:ok true :backend (or (qenv/get "QI_AGENT_REPL_BACKEND"
                                           "DAO_REPL_BACKEND")
                                 "bb-repl")}
    {:ok false :error (str "Unknown REPL operation: " (:op request))}))

(defn -main [& _]
  (let [agent-id (or (qenv/get "QI_AGENT_ID" "DAO_AGENT_ID") "user")
        safe-id (str/replace agent-id #"[^A-Za-z0-9_-]" "-")
        repl-ns (create-ns (symbol (str "qi.agent." safe-id)))
        protocol-out *out*]
    (binding [*ns* repl-ns]
      (clojure.core/refer 'clojure.core))
    (install-host-bridge!)
    (loop []
      (when-let [line (read-line)]
        (let [request (try
                        (edn/read-string line)
                        (catch Throwable error
                          {:id nil :op :invalid :parse-error (ex-message error)}))
              result (if-let [parse-error (:parse-error request)]
                       {:ok false :error (str "Invalid worker request: " parse-error)}
                       (response repl-ns request))]
          (binding [*out* protocol-out]
            (prn (assoc result :id (:id request)))
            (flush))
          (recur))))))
