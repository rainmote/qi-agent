(ns qi.plugins.team
  "Session-local shared task board and member mailboxes with revision claims."
  (:require [qi.kernel :as kernel]
            [qi.orchestration :as orch]))

(def ^:private actions
  ["show" "create" "update" "assign" "claim" "complete" "reopen" "cancel" "send" "mailbox" "ack"])
(def parameters
  {:type "object" :additionalProperties false :required ["action"]
   :properties
   {:action {:type "string" :enum actions}
    :id {:type "string"} :title {:type "string" :maxLength 1000}
    :description {:type "string" :maxLength 8000}
    :depends_on {:type "array" :maxItems 64 :items {:type "string"} :uniqueItems true}
    :expected_revision {:type "integer" :minimum 0}
    :assignee {:type "string"} :recipient {:type "string"}
    :message {:type "string" :maxLength 8000}
    :message_ids {:type "array" :maxItems 256 :items {:type "string"}}
    :result {:type "string" :maxLength 16000}
    :evidence {:type "string" :maxLength 4000}}})

(defn- recover [state]
  (update state :tasks
          #(into {} (map (fn [[id task]]
                           [id (if (= "claimed" (:status task))
                                 (-> task (assoc :status "needs_review"
                                                 :recovery_note "Worker restarted; inspect the assignee's progress before reopening or completing.")
                                     (update :revision inc)) task)]) %))))

(def plugin
  {:id :orchestration/team
   :requires #{:agent/durable-state :subagents/runtime :session/store}
   :provides #{:team/runtime}
   :start
   (fn [ctx _]
     (let [store (kernel/require-service ctx :session/store)
           owner-id (:session-id store)
           _ (orch/text! owner-id "Session identity" 200)
           ledger (orch/ledger ctx :orchestration/team
                               {:revision 0 :owner_id owner-id :tasks {} :messages []} recover)
           snapshot (:snapshot ledger) mutate! (:mutate! ledger)
           subagents (kernel/require-service ctx :subagents/runtime)
           member? (fn [id]
                     (or (= id owner-id)
                         (when-let [job ((:job subagents) id)]
                           (not (contains? #{:stopped :deleted} (:status job))))))
           require-member! (fn [id]
                             (when-not (and (string? id) (member? id))
                               (orch/fail! "Member does not belong to this session's registered team" {:member_id id}))
                             id)
           owner! (fn [actor]
                    (when-not (= actor owner-id) (orch/fail! "Only the session owner may change assignments or dependencies" {})))
           change-task!
           (fn [id expected f]
             (mutate!
              (fn [state]
                (let [task (or (get-in state [:tasks id]) (orch/fail! "Unknown team task" {:id id}))]
                  (orch/revision! task expected)
                  (let [next (assoc-in state [:tasks id] (-> (f task state)
                                                           (update :revision inc)
                                                           (assoc :updated_at (orch/now))))]
                    (orch/graph! (vec (vals (:tasks next))))
                    next)))))
           execute
           (fn [{:keys [action id title description depends_on expected_revision assignee recipient message message_ids result evidence] :as args} execution]
             (when-let [plan (kernel/service ctx :planning/runtime)]
               (when-not ((:permitted? plan) "team" action)
                 (orch/fail! "The active plan does not permit this team operation" {})))
             ;; The model/RPC schema has no actor field. Only a host-created child
             ;; bridge can stamp this identity; public requests always act as owner.
             (let [actor (require-member! (or (:orchestration/member-id execution) owner-id))]
               (case action
                 "show" (assoc (dissoc (snapshot) :messages)
                               :member_id actor
                               :members (into [{:id owner-id :role "owner"}]
                                              (map #(assoc (select-keys % [:id :status :label]) :role "subagent")
                                                   ((:jobs subagents))))
                               :unread (count (filter #(and (= actor (:to %)) (nil? (:read_at %))) (:messages (snapshot)))))
                 "create"
                 (let [task-id (orch/identifier! id)
                       task {:id task-id :title (orch/text! title "Task title" 1000)
                             :description (or description "") :depends_on (or depends_on [])
                             :revision 0 :status "todo" :created_by actor :created_at (orch/now)}]
                   (mutate!
                    (fn [state]
                      (when (contains? (:tasks state) task-id) (orch/fail! "Team task already exists" {}))
                      (let [next (assoc-in state [:tasks task-id] task)]
                        (orch/graph! (vec (vals (:tasks next)))) next)))
                   (get-in (snapshot) [:tasks task-id]))
                 "update"
                 (do (owner! actor)
                     (change-task! id expected_revision
                                   (fn [task _]
                                     (when-not (= "todo" (:status task)) (orch/fail! "Only an unclaimed task may be edited" {}))
                                     (cond-> task
                                       title (assoc :title (orch/text! title "Task title" 1000))
                                       description (assoc :description description)
                                       (contains? args :depends_on) (assoc :depends_on depends_on))))
                     (get-in (snapshot) [:tasks id]))
                 "assign"
                 (do (owner! actor) (require-member! assignee)
                     (change-task! id expected_revision
                                   (fn [task _]
                                     (when-not (= "todo" (:status task)) (orch/fail! "Reopen a claimed task before changing its assignment" {}))
                                     (assoc task :assignee assignee)))
                     (get-in (snapshot) [:tasks id]))
                 "claim"
                 (do (change-task! id expected_revision
                                   (fn [task state]
                                     (when-not (and (= "todo" (:status task))
                                                    (or (nil? (:assignee task)) (= actor (:assignee task))))
                                       (orch/fail! "Task is already claimed or assigned to another member" {}))
                                     (when-not (every? #(= "completed" (get-in state [:tasks % :status])) (:depends_on task))
                                       (orch/fail! "Task dependencies are not completed" {}))
                                     (assoc task :status "claimed" :assignee actor :claimed_at (orch/now))))
                     (get-in (snapshot) [:tasks id]))
                 "complete"
                 (do (orch/text! result "Task result" 16000)
                     (change-task! id expected_revision
                                   (fn [task _]
                                     (when-not (and (contains? #{"claimed" "needs_review"} (:status task))
                                                    (or (= actor owner-id) (= actor (:assignee task))))
                                       (orch/fail! "Only the assignee or owner may complete a claimed task" {}))
                                     (when (= "needs_review" (:status task))
                                       (owner! actor) (orch/text! evidence "Recovery evidence" 4000))
                                     (cond-> (assoc task :status "completed" :result result :completed_by actor :completed_at (orch/now))
                                       evidence (assoc :reconciliation evidence))))
                     (get-in (snapshot) [:tasks id]))
                 "reopen"
                 (do (owner! actor)
                     (change-task! id expected_revision
                                   (fn [task state]
                                     (when (some #(and (some #{id} (:depends_on %))
                                                      (contains? #{"claimed" "completed" "needs_review"} (:status %))) (vals (:tasks state)))
                                       (orch/fail! "Reopen dependent tasks before invalidating their dependency" {}))
                                     (when (= "needs_review" (:status task)) (orch/text! evidence "Recovery evidence" 4000))
                                     (cond-> (-> task (assoc :status "todo")
                                                 (dissoc :assignee :result :claimed_at :completed_at :completed_by))
                                       evidence (assoc :reconciliation evidence))))
                     (get-in (snapshot) [:tasks id]))
                 "cancel"
                 (do (owner! actor)
                     (change-task! id expected_revision
                                   (fn [task state]
                                     (when (some #(and (some #{id} (:depends_on %))
                                                      (contains? #{"claimed" "completed" "needs_review"} (:status %))) (vals (:tasks state)))
                                       (orch/fail! "Cancel or reopen active dependents before cancelling their dependency" {}))
                                     (assoc task :status "cancelled")))
                     (get-in (snapshot) [:tasks id]))
                 "send"
                 (let [recipient (require-member! recipient)
                       message (orch/text! message "Message" 8000)
                       entry {:id (orch/id "mail") :from actor :to recipient :message message :created_at (orch/now)}]
                   (mutate! (fn [state]
                              (when (>= (count (:messages state)) 256) (orch/fail! "Mailbox storage is full; acknowledge delivered messages first" {}))
                              (update state :messages conj entry)))
                   entry)
                 "mailbox" {:member_id actor :messages (filterv #(= actor (:to %)) (:messages (snapshot)))}
                 "ack"
                 (do (when-not (and (vector? message_ids) (<= (count message_ids) 256)) (orch/fail! "message_ids must be an array" {}))
                     (mutate! (fn [state]
                                (doseq [message-id message_ids]
                                  (when-not (some #(and (= message-id (:id %)) (= actor (:to %))) (:messages state))
                                    (orch/fail! "Message is not in this member's mailbox" {:message_id message-id})))
                                (update state :messages #(filterv (fn [entry] (not (some #{(:id entry)} message_ids))) %))))
                     {:acknowledged (vec message_ids) :member_id actor})
                 (orch/fail! "Unknown team action" {:action action}))))
           service {:snapshot #(dissoc (snapshot) :messages)
                    :execute! execute :owner-id owner-id
                    :child-tool (fn [child-id]
                                  {:name "team"
                                   :description "Shared task board and your private team mailbox. Claims use the task revision; you can only act as this registered child. This does not grant coding permissions."
                                   :parameters parameters :execution-mode :sequential
                                   :execute (fn [args execution]
                                              (execute args (assoc execution :orchestration/member-id child-id)))})}]
       (kernel/register-service! ctx :team/runtime service)
       (kernel/register-tool! ctx {:name "team" :description "Maintain this session's shared task DAG and member mailboxes. Claim/assign/complete/reopen require the exact task revision. The board coordinates registered research subagents; it does not launch coding workers."
                                  :parameters parameters :execution-mode :sequential :execute execute})
       (orch/register-rpcs! ctx "team" actions parameters execute)
       nil))})
