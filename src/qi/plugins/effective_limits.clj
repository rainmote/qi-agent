(ns qi.plugins.effective-limits
  "Read-only scope and enforcement inventory. Unknown host limits stay unknown."
  (:require [qi.kernel :as kernel]))

(def plugin
  {:id :runtime/effective-limits
   :description "Report configured runtime ceilings separately from observed OS enforcement."
   :requires #{:agent/session :execution/world :tool/policy :approval/request}
   :provides #{:agent/effective-limits}
   :start
   (fn [ctx _]
     (let [session (kernel/require-service ctx :agent/session)
           world (kernel/require-service ctx :execution/world)
           snapshot
           (fn []
             {:runtime (merge ((:limits session))
                              {:basis :profile-defaults
                               :step-override :per-run
                               :request-and-wall-scope :next-request-admission
                               :hard-wall-enforced false :total-token-budget-enforced false})
              :execution {:sandbox (:sandbox world)
                          :process-enabled (contains? (:capabilities world) :process)
                          :shell-timeout-ms (:default-timeout-ms world)
                          :shell-max-timeout-ms (:max-timeout-ms world)}
              :os {:worker-cpu-enforced nil :worker-concurrency-enforced nil
                   :host-limit-observation :unavailable-in-worker
                   :memory-enforced false :pids-enforced false}
              :verification {:automatic-coding-verifier false :default :not-run}})]
       (kernel/register-service! ctx :agent/effective-limits snapshot)
       (kernel/register-tool!
        ctx {:name "effective_limits"
             :description "Inspect profile ceilings and enforcement scope. Unknown host CPU/concurrency and absent memory/PID limits are explicit. This read-only tool grants no permissions."
             :parameters {:type "object" :properties {} :additionalProperties false}
             :execute (fn [_ _] (snapshot))}))
     nil)})
