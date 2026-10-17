(ns profile-inventory
  "Offline composition and capability control; never calls a real provider."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [qi.context-summary :as summary]
            [qi.env :as env]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.trust :as trust]))

(def profiles
  {"standard" "presets/standard/agent.edn"
   "creator" "presets/creator/agent.edn"
   "minimal" "evals/experiments/profiles/minimal.edn"
   "code" "evals/experiments/profiles/code.edn"})

(defn- isolate [config root]
  (update config :plugins
          #(mapv
            (fn [spec]
              (update spec :config
                      (fn [options]
                        (let [options (or options {})
                              options (cond-> options
                                        (contains? options :root) (assoc :root (str root)))]
                          (case (:ns spec)
                            qi.plugins.session (assoc options :path nil :ephemeral true)
                            qi.plugins.session-catalog (assoc options :directory (str (fs/path root "sessions")))
                            qi.plugins.trust (assoc options :trust-file (str (fs/path root "trust.edn")))
                            qi.plugins.resources (assoc options :user-dir (str (fs/path root "resources")))
                            qi.plugins.presets (assoc options :user-root (str (fs/path root "presets")))
                            qi.plugins.plugin-manager (assoc options :user-dir (str (fs/path root "packages")))
                            options))))) %)))

(defn run-profile [name]
  (let [file (or (get profiles name) (throw (ex-info "Unknown experiment profile" {:name name})))
        raw (slurp file) config (plugin/read-config file)
        root (fs/real-path (fs/create-temp-dir {:prefix "qi-profile-control-"}))
        captured (atom []) tool-results (atom {}) task (atom nil) calls (atom 0)]
    (try
      (spit (str (fs/path root "sample.txt")) "seed-value")
      ;; Only this disposable fixture root is trusted. Production trust is untouched.
      (trust/set-decision! (str root) :allow (str (fs/path root "trust.edn")))
      (with-redefs [env/get (fn [& _] nil) env/home (constantly (str root))]
        (let [started (System/nanoTime)
              ctx (plugin/boot! (isolate config root))
              elapsed (/ (- (System/nanoTime) started) 1000000.0)]
          (try
            (let [registry (kernel/require-service ctx :llm/registry)
                  fixture (kernel/plugin-context ctx :experiment/fixture)
                  manager (kernel/require-service ctx :context/manager)
                  generate
                  (fn [request]
                    (swap! captured conj
                           {:task (:id @task)
                            :request-sha256 (summary/sha256 (json/generate-string
                                                          (select-keys request [:system-prompt :messages :tools :options])))
                            :budget ((:budget! manager) request)})
                    (if (= 1 (swap! calls inc))
                      {:message {:tool_calls [{:id (str "fixture-" (:id @task)) :type "function"
                                              :function {:name (:tool @task)
                                                         :arguments (json/generate-string (:arguments @task))}}]}
                       :finish-reason "tool_calls"}
                      {:message {:content "Fixture execution ended. Verification is independent."}
                       :finish-reason "stop"}))]
              (kernel/register-service! fixture :ui/prompt
                                        {:active? (constantly true) :select! (constantly :allow)})
              (kernel/on! fixture :tool.execution/end
                          (fn [_ data] (swap! tool-results assoc (:call-id data) data)))
              ((:register! registry) {:id :offline-fixture :provider :fixture :model "deterministic-v1"
                                      :context-window 128000 :generate generate})
              ((:select! registry) :offline-fixture)
              (let [tasks [{:id "read" :tool "read" :arguments {:path "sample.txt"}}
                           {:id "edit" :tool "write" :arguments {:path "sample.txt" :content "changed"}}
                           {:id "verify" :tool "bash" :arguments {:command "test \"$(cat sample.txt)\" = changed"}}]
                    rows
                    (mapv
                     (fn [spec]
                       (reset! task spec) (reset! calls 0)
                       (let [available? (boolean (kernel/tool ctx (:tool spec)))
                             result ((kernel/require-service ctx :agent/run)
                                     (str "Offline fixture: " (:id spec)) {:max-steps 4})
                             message (last (filter #(= "tool" (:role %)) (:messages result)))
                             tool-result (get @tool-results (str "fixture-" (:id spec)))
                             passed (and available?
                                         (case (:id spec)
                                           "read" (str/includes? (or (:content message) "") "seed-value")
                                           "edit" (= "changed" (slurp (str (fs/path root "sample.txt"))))
                                           "verify" (= 0 (get-in tool-result [:value :exit-code]))))]
                         {:id (:id spec) :required-tool (:tool spec) :available available?
                          :verification (if passed "PASS" (if available? "FAIL" "MISSING_CAPABILITY"))
                          :tool-error (:error tool-result)
                          :execution-status (:status result)
                          :execution-verification (:verification result)})) tasks)
                    policies (filterv #(contains? '#{qi.plugins.policy qi.plugins.approval
                                                     qi.plugins.execution-world qi.plugins.runtime} (:ns %)) (:plugins config))
                    snapshot (kernel/runtime-snapshot ctx)]
                {:name name :profile-file file :profile-sha256 (summary/sha256 raw)
                 :configured-plugins (mapv (comp str :ns) (:plugins config))
                 :runtime snapshot :tool-schema-sha256 (summary/sha256 (json/generate-string (kernel/tool-schemas ctx)))
                 :policy-sha256 (summary/sha256 (pr-str policies))
                 :configured-boundaries (mapv #(update % :ns str) policies)
                 :sandbox (get (kernel/service ctx :execution/world) :sandbox)
                 :composition-ms elapsed :timing-scope "in-process boot, not cold application launch"
                 :provider "offline-fixture" :model_calls 0 :fixture_requests (count @captured)
                 :request-estimates @captured :tasks rows
                 :missing-capabilities (mapv :required-tool (filter #(not (:available %)) rows))
                 :production-defaults-changed false}))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree root)))))

(when (= *file* (System/getProperty "babashka.file"))
  (let [names (if (seq *command-line-args*) *command-line-args* ["standard" "creator" "minimal" "code"])
        result (binding [*out* (java.io.StringWriter.) *err* (java.io.StringWriter.)]
                 {:schema_version 1 :experiment "profile-inventory-v1" :model_calls 0
                  :rows (mapv run-profile names)})]
    (println (json/generate-string result))))
