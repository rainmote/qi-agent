(ns qi.plugins.jobs
  "Session-local background shell tools. All execution stays in ExecutionWorld."
  (:require [qi.jobs :as jobs]
            [qi.kernel :as kernel]))

(defn- job-tools [manager]
  [{:name "job_list"
    :progress-mode :poll
    :description "List this session's retained background shell jobs, newest first."
    :parameters {:type "object" :properties {} :additionalProperties false}
    :execute (fn [_ _] {:jobs ((:list manager))})}
   {:name "job_output"
    :progress-mode :poll
    :description (str "Read a background job's combined stdout/stderr stream. "
                      "offset is a zero-based character cursor; continue with next-offset. "
                      "wait_ms waits for new output or completion within its configured limit. "
                      "Old output may be discarded; discarded-chars reports the gap.")
    :parameters {:type "object" :required ["job_id"]
                 :properties {"job_id" {:type "string"}
                              "offset" {:type "integer" :minimum 0}
                              "limit" {:type "integer" :minimum 1
                                       :maximum (get-in manager [:limits :max-read-chars])}
                              "wait_ms" {:type "integer" :minimum 0
                                         :maximum (get-in manager [:limits :max-wait-ms])}}
                 :additionalProperties false}
    :execute (fn [{:keys [job_id offset limit wait_ms]} execution]
               ((:output manager)
                (cond-> {:job-id job_id}
                  (some? offset) (assoc :offset offset)
                  (some? limit) (assoc :limit limit)
                  (some? wait_ms) (assoc :wait-ms wait_ms)) execution))}
   {:name "job_kill"
    :description "Cancel a background shell job and terminate its process tree. Safe to repeat."
    :execution-mode :sequential
    :parameters {:type "object" :required ["job_id"]
                 :properties {"job_id" {:type "string"}} :additionalProperties false}
    :execute (fn [{:keys [job_id]} _] ((:kill! manager) job_id))}])

(def plugin
  {:id :tools/jobs
   :description "Bounded, cancellable background shell jobs with session completion events."
   :requires #{:execution/world}
   :provides #{:execution/jobs}
   :start
   (fn [ctx config]
     (let [world (kernel/require-service ctx :execution/world)
           notify! (fn [kind value]
                     (let [store (kernel/service ctx :session/store)
                           data (cond-> value store (assoc :session-id (:session-id store)))]
                       (kernel/emit! ctx kind data)
                       (when store
                         (let [event ((:append! store) (subs (str kind) 1) data)]
                           (kernel/emit! ctx :session/event event)))))
           manager (jobs/create-manager
                    (fn [args]
                      (when-not (contains? (:capabilities world) :process)
                        (throw (ex-info "Execution world does not support processes" {})))
                      ((:spawn! world) args))
                    (assoc (merge {:timeout-ms (min 300000 (or (:max-timeout-ms world) 300000))}
                                  config)
                           :notify! notify!))]
       ;; Register cleanup before exposing operations, including partial start failures.
       (kernel/track-stop! ctx (:close! manager))
       (kernel/track-effect! ctx #(let [receipt ((:close! manager))]
                                   (when (pos? (:remaining receipt))
                                     (throw (ex-info "Background jobs have not stopped" receipt)))))
       (kernel/register-service! ctx :execution/jobs (update manager :list kernel/inspection))
       (doseq [tool (job-tools manager)] (kernel/register-tool! ctx tool))
       nil))})
