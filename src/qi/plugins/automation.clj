(ns qi.plugins.automation
  "Durable scheduling and goals through the daemon's private event bridge."
  (:require [qi.env :as env]
            [qi.kernel :as kernel]))

(def ^:private text {:type "string" :minLength 1})
(def ^:private revision {:type "integer" :minimum 1})
(def ^:private schedule-properties
  {"prompt" text "at_ms" {:type "integer"} "delay_ms" {:type "integer" :minimum 1}
   "every_ms" {:type "integer" :minimum 100} "expression" text "daily" text "weekly" text
   "timezone" text "schedule_id" text "expected_revision" revision})
(def ^:private goal-properties
  {"objective" text "max_continuations" {:type "integer" :minimum 0 :maximum 20}
   "goal_id" text "expected_revision" revision "reconciled" {:type "boolean"}})

(def ^:private definitions
  [{:name "schedule_add" :method "schedule.add" :required ["prompt"]
    :description "Create a durable reminder or recurring task only when explicitly requested by the user. Supply exactly one of at_ms, delay_ms, every_ms, five-field expression, daily HH:MM, weekly MON,WED HH:MM. Use the user's IANA timezone (UTC default). Missing DST wall times are skipped and repeated wall times run once."}
   {:name "schedule_list" :method "schedule.list" :required []
    :description "List this agent's durable schedules, status, next occurrence and revision. Inspect unknown delivery outcomes before retrying."}
   {:name "schedule_update" :method "schedule.update" :required ["schedule_id" "expected_revision"]
    :description "Update a user-requested schedule's prompt, time or timezone using its latest revision. Uncertain/claimed schedules cannot be edited."}
   {:name "schedule_pause" :method "schedule.pause" :required ["schedule_id" "expected_revision"]
    :description "Pause an active schedule only when requested by the user."}
   {:name "schedule_resume" :method "schedule.resume" :required ["schedule_id" "expected_revision"]
    :description "Resume a paused schedule only when requested by the user. Missed occurrences are skipped."}
   {:name "schedule_cancel" :method "schedule.cancel" :required ["schedule_id" "expected_revision"]
    :description "Cancel a schedule only when requested by the user. An already dispatched turn is not interrupted."}
   {:name "goal_set" :method "goal.set" :required ["objective"]
    :description "Create a durable goal ONLY when the user explicitly requests sustained autonomous work or a goal. Ordinary tasks do not authorize goal creation. An unfinished goal must be completed/cancelled first. Binds the goal to the current turn; max_continuations defaults to 3 and cannot exceed 20."}
   {:name "goal_list" :method "goal.list" :required []
    :description "Read this agent's durable goals, budgets, status and revisions."}
   {:name "goal_status" :method "goal.status" :required ["goal_id"]
    :description "Read one durable goal and its current revision."}
   {:name "goal_update" :method "goal.update" :required ["goal_id" "expected_revision"] :approval true
    :description "Change an existing goal objective or continuation budget only with user authorization; requires approval."}
   {:name "goal_pause" :method "goal.pause" :required ["goal_id" "expected_revision"]
    :description "Pause a durable goal only at the user's explicit request. Does not interrupt the current turn."}
   {:name "goal_resume" :method "goal.resume" :required ["goal_id" "expected_revision"] :approval true
    :description "Resume a paused/blocked goal only at the user's request. An uncertain prior outcome requires checking actual effects and reconciled=true. Does not increase the budget."}
   {:name "goal_cancel" :method "goal.cancel" :required ["goal_id" "expected_revision"] :approval true
    :description "Cancel a durable goal only when requested by the user; requires approval."}
   {:name "goal_complete" :method "goal.complete" :required ["goal_id" "expected_revision"] :approval true
    :description "Mark a durable goal completed only after every requested outcome is actually verified. Requires user approval; never use because work is difficult or the budget is nearly exhausted."}])

(def plugin
  {:id :tools/automation
   :description "Daemon-backed schedules and durable goals with revision checks."
   :requires #{:remote/registry :tool/policy}
   :provides #{:automation/control}
   :start
   (fn [ctx {:keys [timeout-ms] :or {timeout-ms 10000}}]
     (let [pending (atom {}) closed? (atom false)
           available? (boolean (env/get "QI_AGENT_WORKER_ID" "DAO_WORKER_ID"))
           registry (kernel/require-service ctx :remote/registry)
           request! (fn [method params]
                      (when-not available?
                        (throw (ex-info "Durable automation requires a daemon-managed Web or TUI session" {:type :automation/unavailable})))
                      (let [id (str (random-uuid)) result (promise)]
                        (locking pending
                          (when @closed? (throw (ex-info "Automation bridge is stopping" {:type :automation/unavailable})))
                          (swap! pending assoc id result))
                        (try
                          (kernel/emit! ctx :automation/request {:id id :method method :params params})
                          (let [response (deref result timeout-ms ::timeout)]
                            (when (= ::timeout response)
                              (throw (ex-info "Automation outcome is unknown; inspect schedules/goals before repeating the request"
                                              {:type :automation/uncertain :request-id id})))
                            (if (:ok response) (:result response)
                                (throw (ex-info (:error response) {:type :automation/rejected}))))
                          (finally (swap! pending dissoc id)))))]
       (kernel/track-stop! ctx #(locking pending
                                 (reset! closed? true)
                                 (doseq [[_ result] @pending]
                                   (deliver result {:ok false :error "Automation bridge stopped; inspect actual state before retrying"}))))
       (kernel/register-service! ctx :automation/control {:available? available? :request! request!})
       ;; Only the private daemon-worker channel may deliver these responses.
       ;; The public daemon dispatcher rejects automation.resolve unconditionally.
       (kernel/track-effect!
        ctx ((:register! registry)
             {:method "automation.resolve" :private true :description "Private daemon automation response."
              :params-schema {:type "object" :required ["id" "ok"]
                              :properties {"id" text "ok" {:type "boolean"}
                                           "result" {} "error" {:type "string"}}}
              :result-schema {:type "object"}
              :handler (fn [{:keys [id] :as response}]
                         (if-let [result (get @pending id)]
                           (do (deliver result response) {:resolved true})
                           {:resolved false}))}))
       (doseq [{:keys [name method required description approval]} definitions]
         (let [properties (if (.startsWith method "schedule.") schedule-properties goal-properties)]
           (kernel/register-tool!
            ctx {:name name :description description
                 :requires-trust (not (contains? #{"schedule.list" "goal.list" "goal.status"} method))
                 :requires-approval (boolean approval)
                 :parameters {:type "object" :required required :properties properties :additionalProperties false}
                 :execute (fn [arguments _] (request! method arguments))})))
       (fn []
         (doseq [[_ result] @pending]
           (deliver result {:ok false :error "Automation bridge stopped; inspect actual state before retrying"}))
         (reset! pending {}))))})
