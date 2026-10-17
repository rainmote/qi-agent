(ns qi.plugins.subagent-external-cli
  "Opt-in CLI bridge and fixed Codex protocol. No personal auth discovery."
  (:require [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.run-outcome :as outcome]))

(defn- start! [config request]
  (let [script (-> (io/resource "qi/external_cli.mjs") io/file .getCanonicalPath)
        child (process/process [(or (:node config) "node") script]
                               {:in :pipe :out :string :err :string})
        writer (io/writer (:in child))
        active? (atom true)
        control! (fn [kind]
                   (when @active?
                     (locking writer
                       (try (.write writer (str (json/generate-string {:type kind}) "\n"))
                            (.flush writer) true
                            (catch Throwable _ false)))))
        result (promise)]
    (.write writer (str (json/generate-string
                        {:type "start"
                         :options {:command (:command config)
                                   :protocol (some-> (:protocol config) name)
                                   :cliVersion (:cli-version config)
                                   :cliSha256 (:cli-sha256 config)
                                   :model (:model config)
                                   :workspaceRoot (:workspace-root config)
                                   :timeoutMs (or (:timeout-ms config) 30000)
                                   :maxOutputBytes (or (:max-output-bytes config) 262144)
                                   :stderrBytes (or (:stderr-bytes config) 4096)}
                         :request (select-keys request [:prompt :run_id])}) "\n"))
    (.flush writer)
    (let [detach (cancellation/on-cancel! (:cancel-token request) #(control! "interrupt"))]
      (future
        (try
          (let [{:keys [out exit]} @child
                value (if (zero? exit)
                        (json/parse-string out true)
                        {:status :uncertain :reason :bridge-failed
                         :verification :not-run :accounting_complete false
                         :total_cost_usd nil})]
            (deliver result (outcome/normalize (assoc value :verification :not-run))))
          (catch Throwable _
            (deliver result (outcome/normalize {:status :uncertain :reason :bridge-failed
                                               :accounting_complete false :total_cost_usd nil})))
          (finally (reset! active? false) (detach) (.close writer)))))
    {:result result :cancel! #(control! "interrupt") :dispose! #(control! "stop")}))

(def plugin
  {:id :subagent/external-cli
   :description "Explicit external CLI JSONL PoC with optional pinned Codex decoder."
   :requires #{:subagents/runtime}
   :start
   (fn [ctx config]
     (when-not (and (true? (:enabled config)) (seq (:command config))
                    (.isDirectory (io/file (or (:workspace-root config) ""))))
       (throw (ex-info "External CLI requires explicit enablement, command and dedicated workspace root" {})))
     (let [runtime (kernel/require-service ctx :subagents/runtime)]
       ((:register! runtime)
        {:id :external-cli :description "Opt-in external JSONL CLI"
         :capabilities {:max-depth 1 :persona false :tool-filter false :output-schema false :multi-turn false
                        :protocol (or (:protocol config) :generic-jsonl-v1) :cli-version (:cli-version config)}
         :start (partial start! config)})))})
