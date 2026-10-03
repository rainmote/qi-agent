(ns qi.plugins.planning
  "Revision-approved durable plans with an explicit execution gate."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.orchestration :as orch]))

(def ^:private read-tools
  #{"current_time" "read" "read_file" "ls" "find" "grep" "hash_read"
    "load_skill" "runtime_inspect" "preset_inspect" "preset_guide"
    "list_agents" "wait_agent" "interrupt_agent" "stop_agent"})
(def ^:private actions
  ["show" "create" "update" "submit" "start" "step" "pause" "resume" "cancel"])
(def parameters
  {:type "object" :additionalProperties false :required ["action"]
   :properties
   {:action {:type "string" :enum actions}
    :title {:type "string" :maxLength 200}
    :steps {:type "array" :minItems 1 :maxItems 64
            :items {:type "object" :additionalProperties false :required ["id" "title"]
                    :properties {:id {:type "string"} :title {:type "string" :maxLength 1000}}}}
    :expected_revision {:type "integer" :minimum 0}
    :step_id {:type "string"}
    :status {:type "string" :enum ["in_progress" "completed" "skipped"]}
    :note {:type "string" :maxLength 4000}}})

(defn- steps! [steps]
  (orch/graph! (mapv #(assoc % :depends_on []) steps))
  (mapv (fn [{:keys [id title]}]
          {:id id :title (orch/text! title "Step title" 1000) :status "pending"}) steps))

(defn- recovered [state]
  (if (contains? #{"executing" "awaiting_approval" "approved"} (get-in state [:plan :status]))
    (-> state
        (assoc-in [:plan :status] "paused")
        (assoc-in [:plan :approval_revision] nil)
        (assoc-in [:plan :recovery_note] "Worker restarted; inspect progress and approve again.")
        (update-in [:plan :revision] inc))
    state))

(defn- approval! [ctx plan token]
  (cancellation/throw-if-cancelled! token)
  (let [prompt (kernel/service ctx :ui/prompt)
        task (future
               (cond
                 (and prompt (or (nil? (:active? prompt)) ((:active? prompt))))
                 ((:select! prompt)
                  {:title (str "Approve plan: " (:title plan))
                   :message (pr-str (select-keys plan [:id :revision :title :steps]))
                   :cancel-token token
                   :items [{:label "Approve this plan" :value :allow}
                           {:label "Reject" :value :deny}]
                   :default :deny})
                 ;; A general Full Access policy cannot approve a plan on the
                 ;; model's behalf. A plan needs an active user interaction.
                 :else :deny))]
    (try
      (loop []
        (cancellation/throw-if-cancelled! token)
        (let [result (deref task 50 ::waiting)]
          (if (= result ::waiting) (recur) result)))
      ;; UI prompts own durable interaction cleanup. Interrupting their thread
      ;; while it appends to a shared session writer can close its NIO channel.
      ;; Prompt adapters must observe the token and finish cooperatively.
      (finally (when-not (realized? task) (cancellation/cancel! token))))))

(def plugin
  {:id :orchestration/planning
   :requires #{:agent/durable-state}
   :provides #{:planning/runtime}
   :start
   (fn [ctx _]
     (let [ledger (orch/ledger ctx :orchestration/planning {:revision 0 :plan nil} recovered)
           snapshot (:snapshot ledger)
           mutate! (:mutate! ledger)
           current #(get (snapshot) :plan)
           active-token (atom nil)
           change!
           (fn [expected f]
             (:plan (mutate! (fn [state]
                               (when-not (:plan state) (orch/fail! "No active plan" {}))
                               (orch/revision! (:plan state) expected)
                               (update state :plan #(-> (f %) (update :revision inc)))))))
           execute
           (fn [{:keys [action title steps expected_revision step_id status note] :as args} execution]
             (case action
               "show" (snapshot)
               "create"
               (let [title (orch/text! title "Plan title" 200) steps (steps! steps)]
                 (mutate!
                  (fn [state]
                    (when (and (:plan state)
                               (not (contains? #{"cancelled" "completed" "rejected"} (get-in state [:plan :status]))))
                      (orch/fail! "Finish or cancel the current plan before creating another" {}))
                    (assoc state :plan {:id (orch/id "plan") :revision 0 :title title
                                        :status "draft" :steps steps :created_at (orch/now)}))))
               "update"
               (do (change! expected_revision
                            (fn [plan]
                              (when-not (contains? #{"draft" "paused" "rejected" "approved"} (:status plan))
                                (orch/fail! "Plan cannot be edited in its current state" {}))
                              (cond-> (assoc plan :status "draft" :approval_revision nil)
                                title (assoc :title (orch/text! title "Plan title" 200))
                                steps (assoc :steps (steps! steps)))))
                   (snapshot))
               "submit"
               (let [token (or (:cancel-token execution) (cancellation/create-token))
                     plan (change! expected_revision
                                   (fn [plan]
                                     (when-not (contains? #{"draft" "paused" "rejected"} (:status plan))
                                       (orch/fail! "Only a draft, paused or rejected plan can be submitted" {}))
                                     (assoc plan :status "awaiting_approval" :approval_revision nil)))]
                 (reset! active-token token)
                 (try
                   (let [decision (approval! ctx plan token)]
                     (cancellation/throw-if-cancelled! token)
                     (change! (:revision plan)
                              (fn [p]
                                (when-not (= "awaiting_approval" (:status p))
                                  (orch/fail! "Plan approval is stale" {}))
                                (if (= :allow decision)
                                  (assoc p :status "approved" :approval_revision (inc (:revision p)))
                                  (assoc p :status "rejected" :approval_revision nil))))
                     (snapshot))
                   (catch Throwable error
                     ;; Cleanup owns only this submission. Pause followed by a
                     ;; new submit may have advanced the same plan meanwhile.
                     ;; Check identity/status inside the revision-checked write.
                     (try
                       (change! (:revision plan)
                                (fn [pending]
                                  (when-not (and (= (:id plan) (:id pending))
                                                 (= "awaiting_approval" (:status pending)))
                                    (orch/fail! "Plan approval is stale" {:conflict true}))
                                  (assoc pending :status "paused" :approval_revision nil)))
                       (catch clojure.lang.ExceptionInfo cleanup-error
                         (when-not (:conflict (ex-data cleanup-error)) (throw cleanup-error))))
                     (throw error))
                   (finally (compare-and-set! active-token token nil))))
               "start"
               (do (change! expected_revision
                            (fn [plan]
                              (when-not (and (= "approved" (:status plan))
                                             (= (:approval_revision plan) (:revision plan)))
                                (orch/fail! "Execution requires approval of the current plan revision" {}))
                              (assoc plan :status "executing")))
                   (snapshot))
               "step"
               (do (change! expected_revision
                            (fn [plan]
                              (when-not (= "executing" (:status plan)) (orch/fail! "Plan is not executing" {}))
                              (when-not (contains? #{"in_progress" "completed" "skipped"} status)
                                (orch/fail! "Invalid plan step status" {}))
                              (when-not (some #(= step_id (:id %)) (:steps plan)) (orch/fail! "Unknown plan step" {}))
                              (when (and (= status "in_progress")
                                         (some #(and (not= step_id (:id %)) (= "in_progress" (:status %))) (:steps plan)))
                                (orch/fail! "Finish the active step before starting another" {}))
                              (let [next-steps (mapv #(if (= step_id (:id %))
                                                       (cond-> (assoc % :status status) note (assoc :note note)) %) (:steps plan))]
                                (cond-> (assoc plan :steps next-steps)
                                  (every? #(contains? #{"completed" "skipped"} (:status %)) next-steps)
                                  (assoc :status "completed")))))
                   (snapshot))
               "pause" (do (change! expected_revision #(assoc % :status "paused" :approval_revision nil))
                            (cancellation/cancel! @active-token) (snapshot))
               "resume" (do (change! expected_revision
                                    (fn [plan]
                                      (when-not (= "paused" (:status plan)) (orch/fail! "Only a paused plan can resume" {}))
                                      (assoc plan :status "draft" :approval_revision nil))) (snapshot))
               "cancel" (do (change! expected_revision #(assoc % :status "cancelled" :approval_revision nil))
                             (cancellation/cancel! @active-token) (snapshot))
               "exit" (do (when-not (:orchestration/user-rpc execution)
                            (orch/fail! "Only the user can exit plan mode" {}))
                          (when (current) (orch/revision! (current) expected_revision))
                          (cancellation/cancel! @active-token)
                          (mutate! #(assoc % :plan nil)))
               (orch/fail! "Unknown planning action" {:action action})))
           permitted?
           (fn [name action]
             (let [plan (current)]
               (or (nil? plan) (= "executing" (:status plan))
                   (= name "planning") (contains? read-tools name)
                   (and (= name "plugin_manage") (contains? #{"list" "inspect"} action))
                   (and (contains? #{"workflow" "team"} name)
                        (contains? #{"show" "list" "status" "mailbox" "cancel"} action)))))
           service {:snapshot snapshot :execute! execute :hard-gate true :permitted? permitted?}]
       (kernel/register-service! ctx :planning/runtime service)
       (kernel/register-tool! ctx {:name "planning" :description "Create and track a durable plan. Submitting requests approval; execution stays read-only until the approved revision is started. Paused plans require approval again."
                                  :parameters parameters :execution-mode :sequential :execute execute})
       (kernel/intercept!
        ctx :tool/pre-execute -1000
        (fn [_ request next]
          (let [name (get-in request [:execution :name])
                action (get-in request [:execution :arguments :action])]
            (if-not (permitted? name action)
              (assoc request :decision :deny :reason "Plan mode is read-only until this exact plan is approved and started.")
              (next request)))))
       ;; The runtime preflights a whole batch before running it. Recheck at the
       ;; execution boundary so create/pause + write in one batch cannot escape.
       (kernel/intercept!
        ctx :tool/execute -1000
        (fn [_ {:keys [execution] :as request} next]
          (if (permitted? (:name execution) (get-in execution [:arguments :action]))
            (next request)
            {:ok false :is-error true :execution execution
             :error "Plan execution gate is closed"
             :content "ERROR: Plan execution gate is closed; approve and start the current revision."})))
       (orch/register-rpcs! ctx "planning" (conj actions "exit") parameters execute)
       (fn [] (cancellation/cancel! @active-token))))})
