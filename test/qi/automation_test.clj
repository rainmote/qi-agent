(ns qi.automation-test
  (:require [clojure.test :refer [deftest is testing]]
            [qi.env :as env]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

(defn- context [available? timeout-ms]
  (with-redefs [env/get (fn [& _] (when available? "offline-worker"))]
    (plugin/boot! {:plugins [{:ns 'qi.plugins.remote-registry}
                            {:ns 'qi.plugins.policy}
                            {:ns 'qi.plugins.automation :config {:timeout-ms timeout-ms}}]})))

(deftest automation-bridge-resolves-correlated-private-response
  (let [ctx (context true 200)
        registry (kernel/require-service ctx :remote/registry)
        seen (atom [])]
    (try
      (kernel/on! (kernel/plugin-context ctx :test/bridge) :automation/request
                  (fn [_ request]
                    (swap! seen conj request)
                    ((:invoke! registry) "automation.resolve"
                     {:id (:id request) :ok true :result [{:schedule_id "schedule-1" :revision 4}]})))
      (is (= [{:schedule_id "schedule-1" :revision 4}]
             ((:execute (kernel/tool ctx "schedule_list")) {} {})))
      (is (= "schedule.list" (:method (first @seen))))
      (is (not-any? #(= "automation.resolve" (:method %)) ((:methods registry))))
      (is (true? (:private ((:method registry) "automation.resolve"))))
      (is (= {:resolved false} ((:invoke! registry) "automation.resolve"
                               {:id (:id (first @seen)) :ok true :result :duplicate})))
      (finally (kernel/dispose-all! ctx)))))

(deftest automation-fails-explicitly-without-daemon-and-never-retries-unknown
  (doseq [available? [false true]]
    (let [ctx (context available? 10) requests (atom 0)]
      (try
        (kernel/on! (kernel/plugin-context ctx :test/bridge) :automation/request
                    (fn [_ _] (swap! requests inc)))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo
                              (if available? #"outcome is unknown" #"daemon-managed")
                              ((:execute (kernel/tool ctx "schedule_list")) {} {})))
        (is (= (if available? 1 0) @requests))
        (finally (kernel/dispose-all! ctx))))))

(deftest completion-and-budget-changes-cannot-bypass-tool-approval-policy
  (let [ctx (context true 20) approvals (atom [])
        owner (kernel/plugin-context ctx :test/approval)]
    (try
      (kernel/register-service! owner :project/trust {:trusted? (constantly true)})
      (kernel/register-service! owner :approval/request (fn [request] (swap! approvals conj request) :deny))
      (doseq [name ["goal_complete" "goal_cancel" "goal_update" "goal_resume"]]
        (let [tool (kernel/tool ctx name)
              gate (kernel/waterfall ctx :tool/pre-execute
                                     {:tool tool :execution {:name name :arguments {}}}
                                     #(assoc % :decision :allow))]
          (is (:requires-approval tool))
          (is (= :deny (:decision gate)))))
      (is (= 4 (count @approvals)))
      (is (re-find #"ONLY when the user explicitly" (:description (kernel/tool ctx "goal_set"))))
      (finally (kernel/dispose-all! ctx)))))
