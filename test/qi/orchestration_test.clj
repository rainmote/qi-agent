(ns qi.orchestration-test
  (:require [clojure.test :refer [deftest is testing]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugins.planning :as planning]
            [qi.plugins.workflow :as workflow]
            [qi.plugins.team :as team]
            [qi.plugins.remote-registry :as remote]
            [qi.schema :as schema]))

(defn fixture
  ([] (fixture (atom {}) {}))
  ([saved extras]
   (let [ctx (kernel/create-context)
         host (kernel/plugin-context ctx :test/host)]
     (kernel/register-service! host :agent/durable-state
                               {:get #(get @saved %) :put! (fn [k v] (swap! saved assoc k v) v)})
     (kernel/register-service! host :session/store {:session-id "owner-session"})
     (doseq [[k v] extras] (kernel/register-service! host k v))
     {:ctx ctx :saved saved})))

(defn mount! [ctx plugin]
  (let [owner (kernel/plugin-context ctx (:id plugin))
        stop ((:start plugin) owner {})]
    (when (fn? stop) (kernel/track-effect! owner stop))
    (kernel/mark-loaded! ctx {:id (:id plugin)})
    ctx))
(defn call [ctx tool args]
  ((:execute (kernel/tool ctx tool)) args {}))
(defn plan [ctx] (:plan (call ctx "planning" {:action "show"})))
(defn planning-call [ctx action & [args]]
  (call ctx "planning" (merge {:action action :expected_revision (:revision (plan ctx))} args)))
(defn await! [f]
  (loop [remaining 200]
    (let [result (f)]
      (if result result
          (if (zero? remaining) (throw (ex-info "Test timed out" {}))
              (do (Thread/sleep 10) (recur (dec remaining))))))))
(defn gate [ctx tool action]
  (kernel/waterfall ctx :tool/pre-execute
                    {:execution {:name tool :arguments {:action action}}}
                    #(assoc % :decision :allow)))

(deftest plan-requires-revision-approval-and-rechecks-the-execution-boundary
  (let [{:keys [ctx]} (fixture (atom {}) {:ui/prompt {:active? (constantly true) :select! (constantly :allow)}})]
    (mount! ctx planning/plugin)
    (try
      (planning-call ctx "create" {:title "A change" :steps [{:id "inspect" :title "Inspect"} {:id "edit" :title "Edit"}]})
      (is (= :deny (:decision (gate ctx "bash" nil))))
      (is (= :deny (:decision (gate ctx "bb_repl" nil))))
      (is (= :allow (:decision (gate ctx "read" nil))))
      (is (thrown? clojure.lang.ExceptionInfo (planning-call ctx "start")))
      (planning-call ctx "submit")
      (is (= "approved" (:status (plan ctx))))
      (is (= :deny (:decision (gate ctx "write" nil))))
      (let [revision (:revision (plan ctx))]
        (planning-call ctx "update" {:title "Changed"})
        (is (thrown? clojure.lang.ExceptionInfo (call ctx "planning" {:action "start" :expected_revision revision}))))
      (planning-call ctx "submit") (planning-call ctx "start")
      (is (= :allow (:decision (gate ctx "write" nil))))
      (planning-call ctx "step" {:step_id "inspect" :status "in_progress"})
      (is (thrown? clojure.lang.ExceptionInfo (planning-call ctx "step" {:step_id "edit" :status "in_progress"})))
      (planning-call ctx "pause")
      (is (false? (:ok (kernel/waterfall ctx :tool/execute {:execution {:name "write"}} (constantly {:ok true})))))
      (is (thrown? clojure.lang.ExceptionInfo (call ctx "planning" {:action "exit"})))
      (finally (kernel/dispose-all! ctx)))))

(deftest rejected-cancelled-and-recovered-plans-cannot-execute
  (let [saved (atom {})
        {:keys [ctx]} (fixture saved {:approval/request (constantly :deny)})]
    (mount! ctx planning/plugin)
    (planning-call ctx "create" {:title "Denied" :steps [{:id "one" :title "One"}]})
    (planning-call ctx "submit")
    (is (= "rejected" (:status (plan ctx))))
    (is (thrown? clojure.lang.ExceptionInfo (planning-call ctx "start")))
    (planning-call ctx "cancel")
    (is (= :deny (:decision (gate ctx "workflow" "run"))))
    (kernel/dispose-all! ctx)
    (swap! saved assoc :orchestration/planning
           {:revision 4 :plan {:id "old" :title "Before restart" :revision 3
                               :status "executing" :approval_revision 2
                               :steps [{:id "one" :title "One" :status "in_progress"}]}})
    (let [next-ctx (:ctx (fixture saved {:approval/request (constantly :allow)}))]
      (mount! next-ctx planning/plugin)
      (try
        (is (= "paused" (:status (plan next-ctx))))
        (is (= "in_progress" (get-in (plan next-ctx) [:steps 0 :status])))
        (is (= :deny (:decision (gate next-ctx "write" nil))))
        (planning-call next-ctx "resume")
        (is (thrown? clojure.lang.ExceptionInfo (planning-call next-ctx "start")))
        (finally (kernel/dispose-all! next-ctx))))))

(deftest cancellation-during-approval-never-opens-the-plan-gate
  (let [started (promise) answer (promise)
        {:keys [ctx]} (fixture (atom {}) {:ui/prompt {:active? (constantly true)
                                                     :select! (fn [_] (deliver started true) @answer)}})
        token (cancellation/create-token)]
    (mount! ctx planning/plugin)
    (try
      (planning-call ctx "create" {:title "Waiting" :steps [{:id "a" :title "A"}]})
      (let [task (future (try ((:execute (kernel/tool ctx "planning"))
                               {:action "submit" :expected_revision 0} {:cancel-token token})
                              (catch Throwable error (ex-data error))))]
        (is (= true (deref started 1000 false)))
        (cancellation/cancel! token)
        (is (:cancelled (deref task 1000 {})))
        (deliver answer :allow)
        (is (= "paused" (:status (plan ctx))))
        (is (= :deny (:decision (gate ctx "write" nil)))))
      (finally (kernel/dispose-all! ctx)))))

(defn fake-subagents []
  (let [jobs (atom {}) active (atom 0) peak (atom 0) interrupted (atom [])]
    {:jobs jobs :peak peak :interrupted interrupted
     :service
     {:job #(get @jobs %)
      :jobs #(vec (vals @jobs))
      :start! (fn [{:keys [prompt] :as request}]
                (let [id (str "child-" (count @jobs)) result (promise)]
                  (swap! jobs assoc id {:id id :status :running :request request :result result})
                  (swap! peak max (swap! active inc))
                  (future
                    (Thread/sleep (if (= prompt "slow") 500 30))
                    (swap! active dec)
                    (deliver result (if (= prompt "fail") {:stop-reason :error :error "intentional"}
                                        {:stop-reason :completed :output (if (= prompt "bad-json") "wrong" "{\"value\":1}")})))
                  {:id id}))
      :wait! (fn [id _] (let [p (:result (get @jobs id))] (if (realized? p) @p {:status :running})))
      :interrupt! (fn [id] (swap! interrupted conj id) true)}}))
(defn run-status [ctx id] (call ctx "workflow" {:action "status" :run_id id}))
(defn wait-run [ctx id] (await! #(let [run (run-status ctx id)] (when (not= "running" (:status run)) run))))

(deftest workflow-bounds-concurrency-propagates-results-and-skips-failed-dependencies
  (let [fake (fake-subagents) {:keys [ctx]} (fixture (atom {}) {:subagents/runtime (:service fake)})]
    (mount! ctx workflow/plugin)
    (try
      (call ctx "workflow" {:action "define" :id "research" :kind "dag" :max_concurrency 2
                             :nodes [{:id "a" :prompt "ok"} {:id "b" :prompt "fail"}
                                     {:id "c" :prompt "later" :depends_on ["a"]}
                                     {:id "d" :prompt "never" :depends_on ["b"]}]})
      (let [run (call ctx "workflow" {:action "run" :id "research" :expected_revision 0})
            finished (wait-run ctx (:id run))
            nodes (into {} (map (juxt :id identity) (:nodes finished)))]
        (is (= "failed" (:status finished)))
        (is (= "completed" (get-in nodes ["c" :status])))
        (is (= "skipped" (get-in nodes ["d" :status])))
        (is (= 2 @(:peak fake)))
        (is (= 3 (count @(:jobs fake))))
        (is (some #(re-find #"Dependency outputs" (get-in % [:request :prompt])) (vals @(:jobs fake)))))
      (is (thrown? clojure.lang.ExceptionInfo
                   (call ctx "workflow" {:action "define" :id "cycle" :nodes [{:id "a" :prompt "a" :depends_on ["b"]}
                                                                               {:id "b" :prompt "b" :depends_on ["a"]}]})))
      (finally (kernel/dispose-all! ctx)))))

(deftest workflow-schema-failure-and-cancellation-are-terminal-without-automatic-replay
  (let [fake (fake-subagents) saved (atom {}) {:keys [ctx]} (fixture saved {:subagents/runtime (:service fake)})]
    (mount! ctx workflow/plugin)
    (try
      (call ctx "workflow" {:action "define" :id "structured" :nodes [{:id "a" :prompt "bad-json" :output_schema {:type "object"}}]})
      (let [run (call ctx "workflow" {:action "run" :id "structured" :expected_revision 0})]
        (is (= "failed" (:status (wait-run ctx (:id run))))))
      (call ctx "workflow" {:action "define" :id "slow" :nodes [{:id "a" :prompt "slow"}]})
      (let [run (call ctx "workflow" {:action "run" :id "slow" :expected_revision 0})
            current (await! #(let [r (run-status ctx (:id run))] (when (= "running" (get-in r [:nodes 0 :status])) r)))]
        (call ctx "workflow" {:action "cancel" :run_id (:id run) :expected_revision (:revision current)})
        (is (= "cancelled" (:status (run-status ctx (:id run)))))
        (is (get-in (run-status ctx (:id run)) [:nodes 0 :outcome_uncertain]))
        (await! #(seq @(:interrupted fake))))
      (finally (kernel/dispose-all! ctx)))
    (swap! saved assoc-in [:orchestration/workflows :runs "recover"]
           {:id "recover" :revision 1 :status "running" :max_concurrency 1
            :nodes [{:id "unknown" :prompt "ok" :provider "spawn" :status "running" :depends_on []}]})
    (let [fresh (fake-subagents) next-ctx (:ctx (fixture saved {:subagents/runtime (:service fresh)}))]
      (mount! next-ctx workflow/plugin)
      (try
        (is (= "uncertain" (:status (run-status next-ctx "recover"))))
        (is (empty? @(:jobs fresh)))
        (is (thrown? clojure.lang.ExceptionInfo (call next-ctx "workflow" {:action "resume" :run_id "recover" :expected_revision 2})))
        (finally (kernel/dispose-all! next-ctx))))))

(deftest team-claims-are-cas-isolated-and-dependency-aware
  (let [children (atom {"alice" {:id "alice" :status :running} "bob" {:id "bob" :status :running}})
        {:keys [ctx]} (fixture (atom {}) {:subagents/runtime {:job #(get @children %) :jobs #(vec (vals @children))}})]
    (mount! ctx team/plugin)
    (try
      (call ctx "team" {:action "create" :id "a" :title "Research"})
      (call ctx "team" {:action "create" :id "b" :title "Review" :depends_on ["a"]})
      (let [service (kernel/service ctx :team/runtime)
            alice (:execute ((:child-tool service) "alice"))
            bob (:execute ((:child-tool service) "bob"))
            start (promise)
            claims (mapv (fn [tool] (future @start (try (tool {:action "claim" :id "a" :expected_revision 0} {})
                                                        (catch Throwable _ :conflict)))) [alice bob])]
        (deliver start true)
        (let [results (mapv deref claims)]
          (is (= 1 (count (filter map? results))))
          (is (= 1 (count (filter #{:conflict} results)))))
        (is (thrown? clojure.lang.ExceptionInfo (alice {:action "claim" :id "b" :expected_revision 0} {})))
        (is (thrown? clojure.lang.ExceptionInfo (alice {:action "assign" :id "b" :expected_revision 0 :assignee "alice"} {})))
        (call ctx "team" {:action "complete" :id "a" :expected_revision 1 :result "Evidence collected"})
        (alice {:action "claim" :id "b" :expected_revision 0} {})
        (is (thrown? clojure.lang.ExceptionInfo (call ctx "team" {:action "reopen" :id "a" :expected_revision 2})))
        (is (thrown? clojure.lang.ExceptionInfo (bob {:action "complete" :id "b" :expected_revision 1 :result "spoof"} {})))
        (is (thrown? clojure.lang.ExceptionInfo ((:execute ((:child-tool service) "outsider")) {:action "show"} {}))))
      (call ctx "team" {:action "create" :id "c" :title "C"})
      (call ctx "team" {:action "create" :id "d" :title "D" :depends_on ["c"]})
      (is (thrown? clojure.lang.ExceptionInfo (call ctx "team" {:action "update" :id "c" :expected_revision 0 :depends_on ["d"]})))
      (is (seq (schema/errors team/parameters {:action "show" :actor "alice"})))
      (finally (kernel/dispose-all! ctx)))))

(deftest team-mailbox-is-private-and-claims-require-recovery-evidence
  (let [saved (atom {}) children {"alice" {:id "alice" :status :running} "bob" {:id "bob" :status :running}}
        extras {:subagents/runtime {:job #(get children %) :jobs #(vec (vals children))}}
        {:keys [ctx]} (fixture saved extras)]
    (mount! ctx team/plugin)
    (call ctx "team" {:action "create" :id "a" :title "A"})
    (call ctx "team" {:action "claim" :id "a" :expected_revision 0})
    (let [entry (call ctx "team" {:action "send" :recipient "alice" :message "Please inspect"})
          service (kernel/service ctx :team/runtime)
          alice (:execute ((:child-tool service) "alice"))
          bob (:execute ((:child-tool service) "bob"))]
      (is (= 1 (count (:messages (alice {:action "mailbox"} {})))))
      (is (empty? (:messages (bob {:action "mailbox"} {}))))
      (is (thrown? clojure.lang.ExceptionInfo (bob {:action "ack" :message_ids [(:id entry)]} {})))
      (is (thrown? clojure.lang.ExceptionInfo (call ctx "team" {:action "send" :recipient "foreign" :message "no"}))))
    (kernel/dispose-all! ctx)
    (let [next-ctx (:ctx (fixture saved extras))]
      (mount! next-ctx team/plugin)
      (try
        (is (= "needs_review" (get-in (call next-ctx "team" {:action "show"}) [:tasks "a" :status])))
        (is (thrown? clojure.lang.ExceptionInfo (call next-ctx "team" {:action "reopen" :id "a" :expected_revision 2})))
        (is (= "todo" (:status (call next-ctx "team" {:action "reopen" :id "a" :expected_revision 2 :evidence "Inspected interrupted child; no result was committed"}))))
        (finally (kernel/dispose-all! next-ctx))))))

(deftest orchestration-rpcs-are-schema-checked-and-only-submit-blocks
  (let [fake (fake-subagents) {:keys [ctx]} (fixture (atom {}) {:subagents/runtime (:service fake)})]
    (mount! ctx remote/plugin)
    (mount! ctx planning/plugin) (mount! ctx workflow/plugin) (mount! ctx team/plugin)
    (try
      (let [rpc (kernel/service ctx :remote/registry)]
        (is (true? (:blocking ((:method rpc) "planning.submit"))))
        (is (false? (:blocking ((:method rpc) "workflow.run"))))
        (is (= {:revision 0 :plan nil} ((:invoke! rpc) "planning.show" {})))
        (is (thrown? clojure.lang.ExceptionInfo ((:invoke! rpc) "team.show" {:actor "outsider"}))))
      (finally (kernel/dispose-all! ctx)))))

(deftest general-auto-approval-cannot-approve-a-plan-without-user-interaction
  (let [{:keys [ctx]} (fixture (atom {}) {:approval/request (constantly :allow)})]
    (mount! ctx planning/plugin)
    (try
      (planning-call ctx "create" {:title "Explicit review" :steps [{:id "inspect" :title "Inspect"}]})
      (planning-call ctx "submit")
      (is (= "rejected" (:status (plan ctx))))
      (is (thrown? clojure.lang.ExceptionInfo (planning-call ctx "start")))
      (is (= :allow (:decision (gate ctx "plugin_manage" "list"))))
      (is (= :allow (:decision (gate ctx "plugin_manage" "inspect"))))
      (is (= :deny (:decision (gate ctx "plugin_manage" "enable"))))
      (finally (kernel/dispose-all! ctx)))))
