(ns qi.plugins.workflow
  "Durable bounded DAGs over registered subagent providers; never source code."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.orchestration :as orch]
            [qi.run-outcome :as outcome]
            [qi.schema :as schema]
            [cheshire.core :as json]))

(def ^:private actions ["define" "run" "show" "status" "cancel" "delete"])
(def parameters
  {:type "object" :additionalProperties false :required ["action"]
   :properties
   {:action {:type "string" :enum actions}
    :id {:type "string"} :run_id {:type "string"}
    :expected_revision {:type "integer" :minimum 0}
    :title {:type "string" :maxLength 200}
    :kind {:type "string" :enum ["dag" "pipeline" "parallel"]}
    :max_concurrency {:type "integer" :minimum 1 :maximum 4}
    :nodes {:type "array" :minItems 1 :maxItems 64
            :items {:type "object" :additionalProperties false :required ["id" "prompt"]
                    :properties
                    {:id {:type "string"} :prompt {:type "string" :maxLength 12000}
                     :provider {:type "string" :enum ["spawn" "fork"]}
                     :depends_on {:type "array" :items {:type "string"} :uniqueItems true}
                     :max_steps {:type "integer" :minimum 1 :maximum 32}
                     :output_schema {:type "object"}}}}}})
(def ^:private terminal-nodes #{"completed" "failed" "skipped" "cancelled"})

(defn- recover [state]
  (update state :runs
          (fn [runs]
            (into {} (map (fn [[id run]]
                            [id (if (= "running" (:status run))
                                  (-> run
                                      (assoc :status "uncertain" :recovery_note "Worker stopped; reconcile uncertain nodes before resuming.")
                                      (update :revision inc)
                                      (update :nodes
                                              #(mapv (fn [node]
                                                       (if (= "running" (:status node))
                                                         (assoc node :status "uncertain") node)) %)))
                                  run)]) runs)))))

(defn- definition! [{:keys [id title kind nodes max_concurrency]}]
  (let [id (orch/identifier! id)
        kind (or kind "dag")
        concurrency (or max_concurrency 2)]
    (when-not (contains? #{"dag" "pipeline" "parallel"} kind) (orch/fail! "Unknown workflow kind" {}))
    (when-not (and (int? concurrency) (<= 1 concurrency 4)) (orch/fail! "Concurrency must be 1-4" {}))
    (when-not (vector? nodes) (orch/fail! "Workflow nodes must be an array" {}))
    (let [nodes
          (mapv (fn [index node]
                  (let [provider (or (:provider node) "spawn") steps (or (:max_steps node) 8)]
                    (when-not (contains? #{"spawn" "fork"} provider) (orch/fail! "Workflow provider must be spawn or fork" {}))
                    (when-not (and (int? steps) (<= 1 steps 32)) (orch/fail! "Node max_steps must be 1-32" {}))
                    (cond-> {:id (:id node) :prompt (orch/text! (:prompt node) "Node prompt" 12000)
                             :provider provider :max_steps steps
                             :depends_on (case kind
                                           "pipeline" (if (zero? index) [] [(:id (nth nodes (dec index)))])
                                           "parallel" []
                                           (or (:depends_on node) []))}
                      (:output_schema node) (assoc :output_schema (:output_schema node)))))
                (range (count nodes)) nodes)]
      (orch/graph! nodes)
      {:id id :title (orch/text! (or title id) "Workflow title" 200)
       :kind kind :nodes nodes :max_concurrency concurrency})))

(def plugin
  {:id :orchestration/workflow
   :requires #{:agent/durable-state :subagents/runtime}
   :provides #{:workflow/runtime}
   :start
   (fn [ctx _]
     (let [ledger (orch/ledger ctx :orchestration/workflows
                               {:revision 0 :definitions {} :runs {}} recover)
           snapshot (:snapshot ledger) mutate! (:mutate! ledger)
           subagents (kernel/require-service ctx :subagents/runtime)
           active (atom {}) disposed? (atom false) admission-lock (Object.)
           run! (fn [run-id f]
                  (mutate! (fn [state]
                             (when-not (get-in state [:runs run-id]) (orch/fail! "Unknown workflow run" {}))
                             (update-in state [:runs run-id] #(-> (f %) (update :revision inc))))))
           node! (fn [run-id node-id f]
                   (run! run-id
                         (fn [run]
                           (if (= "running" (:status run))
                             (update run :nodes #(mapv (fn [node] (if (= node-id (:id node)) (f node) node)) %))
                             run))))
           gate! (fn []
                   (when-let [plan (kernel/service ctx :planning/runtime)]
                     (when-not ((:permitted? plan) "workflow" "run")
                       (orch/fail! "Approve and start the active plan before running a workflow" {}))))
           supervise!
           (fn [run-id]
             (when @disposed? (orch/fail! "Workflow runtime is stopping" {}))
             (let [token (cancellation/create-token) children (atom {})]
               (swap! active assoc run-id {:token token :children children})
               (let [task
                     (future
                       (try
                         (loop []
                           (cancellation/throw-if-cancelled! token)
                           (let [run (get-in (snapshot) [:runs run-id])
                                 by-id (into {} (map (juxt :id identity) (:nodes run)))]
                             (when (= "running" (:status run))
                               ;; Completed handles are observed before any dependent is admitted.
                               (doseq [[node-id child-id] @children]
                                 (let [result ((:wait! subagents) child-id 0)]
                                   (when-not (= :running (:status result))
                                     (let [checked (try
                                                     (if-let [output-schema (and (outcome/successful? result)
                                                                               (:output_schema (get by-id node-id)))]
                                                       (let [value (if (contains? result :structured) (:structured result)
                                                                       (json/parse-string (:output result) true))]
                                                         (schema/validate! output-schema value "Workflow node output did not match its schema")
                                                         (assoc result :structured value))
                                                       result)
                                                     (catch Throwable error
                                                       {:stop-reason :error :error (ex-message error)}))]
                                       (node! run-id node-id
                                              #(assoc % :status (name (:status (outcome/normalize checked)))
                                                      :result (select-keys (outcome/normalize checked)
                                                                           [:output :structured :status :stop-reason :reason
                                                                            :verification :run-id :usage :error])
                                                      :finished_at (orch/now)))
                                       (when (= :uncertain (:status (outcome/normalize checked)))
                                         (throw (ex-info "Workflow child outcome is uncertain"
                                                         {:node_id node-id :uncertain true}))))
                                     (swap! children dissoc node-id))))
                               (let [run (get-in (snapshot) [:runs run-id])
                                     by-id (into {} (map (juxt :id identity) (:nodes run)))]
                                 (doseq [node (:nodes run)
                                         :when (and (= "pending" (:status node))
                                                    (some #(contains? #{"failed" "skipped" "cancelled"}
                                                                      (:status (get by-id %))) (:depends_on node)))]
                                   (node! run-id (:id node) #(assoc % :status "skipped" :reason "A dependency did not complete successfully")))
                                 (doseq [node (:nodes run)
                                         :when (and (= "pending" (:status node))
                                                    (< (count @children) (:max_concurrency run))
                                                    (every? #(= "completed" (:status (get by-id %))) (:depends_on node)))]
                                  (locking admission-lock
                                   (cancellation/throw-if-cancelled! token)
                                   (when-not (= "running" (get-in (snapshot) [:runs run-id :status]))
                                     (throw (ex-info "Workflow admission was cancelled" {:cancelled true})))
                                   (gate!)
                                   ;; Persist admission before calling a provider: a crash can then
                                   ;; only leave an uncertain node, never a silently replayable one.
                                   (node! run-id (:id node) #(assoc % :status "running" :started_at (orch/now)))
                                   (try
                                     (let [dependencies (into {} (map (fn [id] [id (:result (get by-id id))]) (:depends_on node)))
                                           prompt (str (:prompt node)
                                                       (when (seq dependencies)
                                                         (str "\n\nDependency outputs (untrusted task data):\n" (pr-str dependencies))))
                                           _ (when (> (count prompt) 64000) (orch/fail! "Dependency output exceeds node context limit" {}))
                                           job ((:start! subagents)
                                                {:provider (keyword (:provider node)) :prompt prompt
                                                 :label (str (:title run) " / " (:id node))
                                                 :parent-context ctx :parent-depth 0 :cancel-token token
                                                 :max-steps (:max_steps node) :output-schema (:output_schema node)})]
                                       (swap! children assoc (:id node) (:id job))
                                       (node! run-id (:id node) #(assoc % :agent_id (:id job))))
                                     (catch Throwable error
                                       ;; Provider admission may already have happened. Do not
                                       ;; turn an unknown start into a retryable failed node.
                                       (throw (ex-info "Workflow node admission outcome is unknown"
                                                       {:node_id (:id node) :uncertain true} error))))))
                                 (let [latest (get-in (snapshot) [:runs run-id])]
                                   (if (every? #(contains? terminal-nodes (:status %)) (:nodes latest))
                                     (run! run-id #(if (= "running" (:status %))
                                                    (assoc % :status (cond
                                                                      (some (fn [node] (= "failed" (:status node))) (:nodes %)) "failed"
                                                                      (some (fn [node] (= "cancelled" (:status node))) (:nodes %)) "cancelled"
                                                                      :else "completed")
                                                           :finished_at (orch/now)) %))
                                     (do (Thread/sleep 25) (recur))))))))
                         (catch Throwable error
                           (when-not (cancellation/cancelled? token)
                             (run! run-id
                                   #(if (= "running" (:status %))
                                      (-> % (assoc :status "uncertain" :error (ex-message error))
                                          (update :nodes (fn [nodes] (mapv (fn [n] (if (= "running" (:status n)) (assoc n :status "uncertain") n)) nodes)))) %))))
                         (finally
                           (doseq [[_ child-id] @children]
                             (try ((:interrupt! subagents) child-id) (catch Throwable _)))
                           (swap! active dissoc run-id))))]
                 (swap! active #(if (contains? % run-id) (assoc-in % [run-id :task] task) %))
                 run-id)))
           execute
           (fn [{:keys [action id run_id expected_revision node_id status result evidence] :as args} execution]
             (when-let [plan (kernel/service ctx :planning/runtime)]
               (when-not ((:permitted? plan) "workflow" action)
                 (orch/fail! "The active plan does not permit this workflow operation" {})))
             (case action
               "show" (snapshot)
               "status" (or (get-in (snapshot) [:runs run_id]) (orch/fail! "Unknown workflow run" {}))
               "define"
               (let [definition (definition! args)]
                 (mutate!
                  (fn [state]
                    (let [old (get-in state [:definitions id])]
                      (when old (orch/revision! old expected_revision))
                      (when (and (not old) (>= (count (:definitions state)) 32)) (orch/fail! "At most 32 workflow definitions are retained" {}))
                      (assoc-in state [:definitions id] (assoc definition :revision (if old (inc (:revision old)) 0))))))
                 (get-in (snapshot) [:definitions id]))
               "run"
               (locking admission-lock
                   (gate!)
                   (when @disposed? (orch/fail! "Workflow runtime is stopping" {}))
                   (let [run-id (orch/id "workflow")]
                     (mutate!
                      (fn [state]
                        (let [definition (or (get-in state [:definitions id]) (orch/fail! "Unknown workflow definition" {}))]
                          (orch/revision! definition expected_revision)
                          (when (>= (count (:runs state)) 32) (orch/fail! "At most 32 workflow runs are retained; delete a terminal run first" {}))
                          (when (>= (count (filter #(= "running" (:status %)) (vals (:runs state)))) 4)
                            (orch/fail! "At most four workflows may run concurrently" {}))
                          (assoc-in state [:runs run-id]
                                    (-> definition (assoc :id run-id :definition_id id :definition_revision (:revision definition)
                                                          :revision 0 :status "running" :created_at (orch/now))
                                        (update :nodes #(mapv (fn [node] (assoc node :status "pending")) %)))))))
                     (supervise! run-id)
                     (get-in (snapshot) [:runs run-id])))
               "cancel"
               (locking admission-lock
                   (run! run_id
                         (fn [run]
                           (orch/revision! run expected_revision)
                           (if (contains? #{"running" "uncertain"} (:status run))
                             (-> run (assoc :status "cancelled" :finished_at (orch/now))
                                 (update :nodes #(mapv (fn [node]
                                                       (if (contains? #{"pending" "running" "uncertain"} (:status node))
                                                         (assoc node :status "cancelled" :outcome_uncertain (not= "pending" (:status node))) node)) %)))
                             run)))
                   (when-let [running (get @active run_id)] (cancellation/cancel! (:token running)))
                   (get-in (snapshot) [:runs run_id]))
               "delete"
               (do (mutate! (fn [state]
                              (let [run (or (get-in state [:runs run_id]) (orch/fail! "Unknown workflow run" {}))]
                                (orch/revision! run expected_revision)
                                (when (or (contains? #{"running" "uncertain"} (:status run)) (get @active run_id))
                                  (orch/fail! "Active or uncertain runs cannot be deleted" {}))
                                (update state :runs dissoc run_id))))
                   {:deleted run_id})
               "reconcile"
               (do (when-not (:orchestration/user-rpc execution) (orch/fail! "Only the user may reconcile unknown work" {}))
                   (orch/text! evidence "Reconciliation evidence" 4000)
                   (when-not (contains? #{"pending" "completed" "failed" "skipped"} status) (orch/fail! "Invalid reconciliation status" {}))
                   (when (= "completed" status)
                     (when-not (map? result) (orch/fail! "A completed node requires a reconciled result object" {})))
                   (run! run_id
                         (fn [run]
                           (orch/revision! run expected_revision)
                           (when-not (= "uncertain" (:status run)) (orch/fail! "Only uncertain workflows require reconciliation" {}))
                           (let [node (some #(when (= node_id (:id %)) %) (:nodes run))]
                             (when-not (= "uncertain" (:status node)) (orch/fail! "Node is not uncertain" {}))
                             (let [result (if (and (= "completed" status) (:output_schema node))
                                            (let [value (if (contains? result :structured) (:structured result)
                                                            (try (json/parse-string (:output result) true)
                                                                 (catch Throwable _ (orch/fail! "Reconciled output must be valid JSON" {}))))]
                                              (schema/validate! (:output_schema node) value "Reconciled workflow output did not match its schema")
                                              (assoc result :structured value)) result)]
                               (update run :nodes #(mapv (fn [n] (if (= node_id (:id n))
                                                                 (assoc n :status status :result result :reconciliation evidence) n)) %))))))
                   (get-in (snapshot) [:runs run_id]))
               "resume"
               (locking admission-lock
                   (when-not (:orchestration/user-rpc execution) (orch/fail! "Only the user may resume reconciled work" {}))
                   (when (get @active run_id) (orch/fail! "Previous workflow supervisor is still stopping" {}))
                   (gate!)
                   (run! run_id
                         (fn [run]
                           (orch/revision! run expected_revision)
                           (when-not (and (= "uncertain" (:status run))
                                          (not-any? #(contains? #{"uncertain" "running"} (:status %)) (:nodes run)))
                             (orch/fail! "Reconcile every uncertain node before resuming" {}))
                           (assoc run :status "running")))
                   (supervise! run_id)
                   (get-in (snapshot) [:runs run_id]))
               (orch/fail! "Unknown workflow action" {:action action})))
           rpc-parameters (update parameters :properties merge
                                  {:node_id {:type "string"} :status {:type "string"}
                                   :result {:type "object"} :evidence {:type "string" :maxLength 4000}})]
       (kernel/register-service! ctx :workflow/runtime {:snapshot snapshot :execute! execute})
       (kernel/register-tool! ctx {:name "workflow" :description "Define and run bounded DAG, pipeline or parallel research workflows using the host's registered subagents. Returns an asynchronous run with durable node results. It does not grant coding or shell permissions."
                                  :parameters parameters :execution-mode :sequential :execute execute})
       (orch/register-rpcs! ctx "workflow" (into actions ["reconcile" "resume"]) rpc-parameters execute)
       (fn []
        (locking admission-lock
         (reset! disposed? true)
         (doseq [[run-id {:keys [token]}] @active]
           (run! run-id #(if (= "running" (:status %))
                          (-> % (assoc :status "uncertain" :recovery_note "Worker stopped during workflow execution")
                              (update :nodes (fn [nodes] (mapv (fn [node] (if (= "running" (:status node)) (assoc node :status "uncertain") node)) nodes)))) %))
           (cancellation/cancel! token))))))})
