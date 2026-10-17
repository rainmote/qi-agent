(ns qi.orchestration-recovery-test
  (:require [clojure.test :refer [deftest is]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.orchestration-test :as fixture]
            [qi.plugins.planning :as planning]
            [qi.plugins.workflow :as workflow]
            [qi.plugins.team :as team]))

(deftest pausing-a-pending-approval-cancels-it-without-overwriting-paused-state
  (let [started (promise) released (promise) cancelled (promise)
        {:keys [ctx]} (fixture/fixture
                       (atom {})
                       {:ui/prompt {:active? (constantly true)
                                    :select! (fn [{:keys [cancel-token]}]
                                               (cancellation/on-cancel! cancel-token #(deliver cancelled true))
                                               (deliver started true)
                                               @released)}})]
    (fixture/mount! ctx planning/plugin)
    (try
      (fixture/planning-call ctx "create" {:title "Await user" :steps [{:id "a" :title "A"}]})
      (let [pending (future (try (fixture/planning-call ctx "submit")
                                (catch Throwable error (ex-data error))))]
        (is (= true (deref started 1000 false)))
        (fixture/planning-call ctx "pause")
        (let [paused (fixture/plan ctx)]
          (is (= true (deref cancelled 1000 false)))
          (is (:cancelled (deref pending 1000 {})))
          (deliver released :allow)
          (is (= paused (fixture/plan ctx)))
          (is (= "paused" (:status paused)))
          (is (= :deny (:decision (fixture/gate ctx "write" nil))))))
      (finally (deliver released :deny) (kernel/dispose-all! ctx)))))

(deftest stale-approval-cleanup-cannot-pause-a-newer-submission
  (let [{:keys [ctx]} (fixture/fixture)
        first-started (promise) second-started (promise)
        first-release (promise) second-release (promise)
        attempts (atom 0)]
    (fixture/mount! ctx planning/plugin)
    (try
      (fixture/planning-call ctx "create" {:title "Retry approval" :steps [{:id "a" :title "A"}]})
      ;; Hold the old approval at its exception boundary until the replacement
      ;; is pending, reproducing this ordering without scheduler timing sleeps.
      (with-redefs-fn
        {#'planning/approval!
         (fn [_ _ _]
           (if (= 1 (swap! attempts inc))
             (do (deliver first-started true) @first-release
                 (throw (ex-info "Old approval cancelled" {:cancelled true})))
             (do (deliver second-started true) @second-release)))}
        (fn []
          (let [old (future (try (fixture/planning-call ctx "submit")
                                (catch Throwable error (ex-data error))))]
            (is (= true (deref first-started 1000 false)))
            (fixture/planning-call ctx "pause")
            (let [new (future (fixture/planning-call ctx "submit"))]
              (is (= true (deref second-started 1000 false)))
              (let [pending (fixture/plan ctx)]
                (is (= "awaiting_approval" (:status pending)))
                (deliver first-release true)
                (is (:cancelled (deref old 1000 {})))
                (is (= pending (fixture/plan ctx)))
                (is (= :deny (:decision (fixture/gate ctx "write" nil))))
                (deliver second-release :allow)
                (is (= "approved" (get-in (deref new 1000 {}) [:plan :status])))
                (is (= (inc (:revision pending)) (:revision (fixture/plan ctx)))))))))
      (finally
        (deliver first-release true) (deliver second-release :deny)
        (kernel/dispose-all! ctx)))))

(deftest unknown-provider-admission-is-not-a-failed-or-replayable-node
  (let [starts (atom 0)
        {:keys [ctx]} (fixture/fixture (atom {})
                                      {:subagents/runtime {:start! (fn [_] (swap! starts inc) (throw (ex-info "lost acknowledgement" {})))
                                                           :interrupt! (constantly true)}})]
    (fixture/mount! ctx workflow/plugin)
    (try
      (fixture/call ctx "workflow" {:action "define" :id "unknown" :kind "pipeline"
                                    :nodes [{:id "a" :prompt "Admit"} {:id "b" :prompt "Later"}]})
      (let [run (fixture/call ctx "workflow" {:action "run" :id "unknown" :expected_revision 0})
            ended (fixture/wait-run ctx (:id run))]
        (is (= "uncertain" (:status ended)))
        (is (= "uncertain" (get-in ended [:nodes 0 :status])))
        (is (= "pending" (get-in ended [:nodes 1 :status])))
        (is (= 1 @starts)))
      (finally (kernel/dispose-all! ctx)))))

(deftest stopping-a-worker-preserves-unknown-work-and-does-not-replay-on-reopen
  (let [saved (atom {}) fake (fixture/fake-subagents)
        {:keys [ctx]} (fixture/fixture saved {:subagents/runtime (:service fake)})]
    (fixture/mount! ctx workflow/plugin)
    (fixture/call ctx "workflow" {:action "define" :id "active" :nodes [{:id "a" :prompt "slow"}]})
    (let [run (fixture/call ctx "workflow" {:action "run" :id "active" :expected_revision 0})]
      (fixture/await! #(get-in (fixture/run-status ctx (:id run)) [:nodes 0 :agent_id]))
      (kernel/dispose-all! ctx)
      (is (= "uncertain" (get-in @saved [:orchestration/workflows :runs (:id run) :status])))
      (is (= "uncertain" (get-in @saved [:orchestration/workflows :runs (:id run) :nodes 0 :status])))
      (let [next-fake (fixture/fake-subagents)
            next-ctx (:ctx (fixture/fixture saved {:subagents/runtime (:service next-fake)}))]
        (fixture/mount! next-ctx workflow/plugin)
        (try
          (is (= "uncertain" (:status (fixture/run-status next-ctx (:id run)))))
          (is (empty? @(:jobs next-fake)))
          (finally (kernel/dispose-all! next-ctx)))))))

(deftest only-explicit-reconciliation-resumes-and-preserves-completed-nodes
  (let [output-schema {:type "object" :required ["value"] :properties {:value {:type "integer"}}}
        saved (atom {:orchestration/workflows
                     {:revision 4 :definitions {}
                      :runs {"restore" {:id "restore" :revision 2 :status "uncertain" :title "Restore" :max_concurrency 1
                                         :nodes [{:id "done" :prompt "Already done" :provider "spawn" :depends_on [] :status "completed" :result {:output "old"}}
                                                 {:id "unknown" :prompt "Unknown" :provider "spawn" :depends_on ["done"] :status "uncertain" :output_schema output-schema}
                                                 {:id "next" :prompt "Continue" :provider "spawn" :depends_on ["unknown"] :status "pending"}]}}}})
        fake (fixture/fake-subagents) {:keys [ctx]} (fixture/fixture saved {:subagents/runtime (:service fake)})]
    (fixture/mount! ctx workflow/plugin)
    (try
      (let [execute (:execute! (kernel/service ctx :workflow/runtime))
            user {:orchestration/user-rpc true}]
        (is (thrown? clojure.lang.ExceptionInfo (execute {:action "resume" :run_id "restore" :expected_revision 2} user)))
        (is (thrown? clojure.lang.ExceptionInfo (execute {:action "reconcile" :run_id "restore" :node_id "unknown" :expected_revision 2
                                                         :status "completed" :result {:output "not-json"} :evidence "Looked at output"} user)))
        (execute {:action "reconcile" :run_id "restore" :node_id "unknown" :expected_revision 2
                  :status "completed" :result {:output "{\"value\":7}"} :evidence "Verified saved output"} user)
        (execute {:action "resume" :run_id "restore" :expected_revision 3} user)
        (let [finished (fixture/wait-run ctx "restore")]
          (is (= "completed" (:status finished)))
          (is (= "old" (get-in finished [:nodes 0 :result :output])))
          (is (= {:value 7} (get-in finished [:nodes 1 :result :structured])))
          (is (= 1 (count @(:jobs fake))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest workflow-direct-rpc-cannot-cross-the-plan-gate
  (let [fake (fixture/fake-subagents) {:keys [ctx]} (fixture/fixture (atom {}) {:subagents/runtime (:service fake)})]
    (fixture/mount! ctx planning/plugin) (fixture/mount! ctx workflow/plugin)
    (try
      (fixture/call ctx "workflow" {:action "define" :id "blocked" :nodes [{:id "a" :prompt "A"}]})
      (fixture/planning-call ctx "create" {:title "Review first" :steps [{:id "review" :title "Review"}]})
      (is (thrown? clojure.lang.ExceptionInfo
                   ((:execute! (kernel/service ctx :workflow/runtime))
                    {:action "run" :id "blocked" :expected_revision 0} {:orchestration/user-rpc true})))
      (is (empty? @(:jobs fake)))
      (is (empty? (:runs (fixture/call ctx "workflow" {:action "show"}))))
      (doseq [tool ["bash" "bb_repl" "delegate_task" "fork_agent" "schedule" "goal" "plugin_manage" "mcp" "write"]]
        (is (= :deny (:decision (fixture/gate ctx tool "run")))))
      (finally (kernel/dispose-all! ctx)))))

(deftest cancelling-a-dependency-cannot-invalidate-an-active-team-task
  (let [fake (fixture/fake-subagents) {:keys [ctx]} (fixture/fixture (atom {}) {:subagents/runtime (:service fake)})]
    (fixture/mount! ctx team/plugin)
    (try
      (fixture/call ctx "team" {:action "create" :id "base" :title "Base"})
      (fixture/call ctx "team" {:action "create" :id "dependent" :title "Dependent" :depends_on ["base"]})
      (fixture/call ctx "team" {:action "claim" :id "base" :expected_revision 0})
      (fixture/call ctx "team" {:action "complete" :id "base" :expected_revision 1 :result "Verified"})
      (fixture/call ctx "team" {:action "claim" :id "dependent" :expected_revision 0})
      (is (thrown? clojure.lang.ExceptionInfo
                   (fixture/call ctx "team" {:action "cancel" :id "base" :expected_revision 2})))
      (is (= "completed" (get-in (fixture/call ctx "team" {:action "show"}) [:tasks "base" :status])))
      (finally (kernel/dispose-all! ctx)))))
