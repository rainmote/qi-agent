(ns qi.run-outcome-test
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.run-outcome :as outcome]
            [qi.env :as env]
            [qi.orchestration-test :as fixture]
            [qi.plugins.workflow :as workflow]
            [babashka.fs :as fs]
            [clojure.test :refer [deftest is testing]]))

(deftest host-deadline-overrides-only-its-own-older-session-run-once
  (let [events [{:type "agent/run/start" :data {:run-id "r"}}
                {:type "agent/run/end" :data {:run-id "r" :status :completed}}]
        receipt {:schema_version 1 :reason "hard-wall-timeout" :worker_id "w" :generation 2
                 :runs [{:run_id "r" :session_id "s" :deadline_at_ms 50}
                        {:run_id "other" :session_id "other-session"}]}
        identity {:worker-id "w" :generation 3 :session-id "s"}
        result (outcome/host-deadline-outcomes receipt identity events)]
    (is (= 1 (count result)))
    (is (= :uncertain (:status (first result))))
    (is (= :hard-wall-timeout (:reason (first result))))
    (is (= :not-run (:verification (first result))))
    (doseq [other [(assoc identity :worker-id "other") (assoc identity :generation 2)
                  (assoc identity :session-id "other") (assoc identity :generation nil)]]
      (is (empty? (outcome/host-deadline-outcomes receipt other events))))
    (is (empty? (outcome/host-deadline-outcomes receipt identity
                 (conj events {:type "agent/run/end" :data (first result)}))))))

(deftest runtime-persists-host-correction-before-recovery-can-show-late-completion
  (let [root (fs/create-temp-dir {:prefix "qi-deadline-correction-"})
        log (str (fs/path root "session.jsonl"))
        receipt (str (fs/path root "timeout.json"))
        environment {"QI_AGENT_HOST_DEADLINE_RECEIPT" receipt "QI_AGENT_WORKER_ID" "w"
                     "QI_AGENT_WORKER_GENERATION" "3"}
        config {:plugins [{:ns 'qi.plugins.session :config {:path log}}
                          {:ns 'qi.plugins.mock} {:ns 'qi.plugins.runtime}]}]
    (try
      (spit log (str "{\"type\":\"session/start\",\"data\":{\"session_id\":\"s\"}}\n"
                     "{\"type\":\"agent/run/start\",\"data\":{\"run-id\":\"r\"}}\n"
                     "{\"type\":\"agent/run/end\",\"data\":{\"run-id\":\"r\",\"status\":\"completed\"}}\n"))
      (spit receipt "{\"schema_version\":1,\"reason\":\"hard-wall-timeout\",\"worker_id\":\"w\",\"generation\":2,\"runs\":[{\"run_id\":\"r\",\"session_id\":\"s\",\"deadline_at_ms\":50}]}")
      (dotimes [_ 2]
        (with-redefs [env/get #(get environment %)]
          (let [ctx (plugin/boot! config)]
            (try
              (let [events ((:events (kernel/require-service ctx :session/store)))
                    terminal (:data (last events))]
                (is (= 4 (count events)))
                (is (= :uncertain (some-> (:status terminal) name keyword)))
                (is (= 2 (:host-generation terminal))))
              (finally (kernel/dispose-all! ctx))))))
      (finally (fs/delete-tree root)))))

(defn- answer [text]
  {:message {:role "assistant" :content text}
   :finish-reason "stop" :usage {:input-tokens 10 :output-tokens 2}})

(defn- tool-answer [_]
  {:message {:role "assistant"
             :tool_calls [{:id "call" :type "function"
                           :function {:name "calculate"
                                      :arguments "{\"operation\":\"add\",\"a\":1,\"b\":2}"}}]}
   :finish-reason "tool_calls" :usage {:input-tokens 10 :output-tokens 2}})

(deftest each-admitted-run-has-one-durable-and-live-terminal-outcome
  (doseq [[label generate policy status reason]
          [["normal" (constantly (answer "done")) nil :completed :completed]
           ["provider" (fn [_] (throw (ex-info "offline failure" {:retryable false})))
            nil :failed :provider-error]
           ["cancel" (fn [{:keys [cancel-token]}]
                       (cancellation/cancel! cancel-token) (answer "late"))
            nil :cancelled :cancelled]
           ["budget" tool-answer nil :failed :step-budget]
           ["policy" tool-answer {:deny-tools #{"calculate"} :terminate-on-deny true}
            :failed :tool-terminated]
           ["output limit" (constantly (assoc (answer "partial") :finish-reason "length"))
            nil :failed :output-limit]]]
    (testing label
      (let [directory (fs/create-temp-dir {:prefix "qi-terminal-"})
            path (str (fs/path directory "session.jsonl"))
            ctx (plugin/boot!
                 {:plugins (cond-> [{:ns 'qi.plugins.session :config {:path path :fsync? false}}
                                     {:ns 'qi.plugins.mock :config {:generate generate}}
                                     {:ns 'qi.plugins.math}]
                             policy (conj {:ns 'qi.plugins.policy :config policy})
                             true (conj {:ns 'qi.plugins.runtime :config {:max-steps 1}}))})
            live (atom [])]
        (try
          (let [session (kernel/require-service ctx :agent/session)
                store (kernel/require-service ctx :session/store)
                _ ((:subscribe! session) #(when (= :agent.run/end (:type %))
                                           (swap! live conj %)))
                result (deref (:result ((:submit! session) "run")) 3000 ::timeout)
                terminals (filter #(= "agent/run/end" (:type %)) ((:events store)))
                data (:data (first terminals))]
            (is (= (= :completed status) (:ok result)))
            (is (= 1 (count terminals)))
            (is (= 1 (count @live)))
            (is (string? (:run-id data)))
            (is (= status (:status data) (:status (first @live))))
            (is (= reason (:reason data)))
            (is (= :not-run (:verification data)))
            (when (contains? #{"normal" "budget" "policy" "output limit"} label)
              (is (= {:input-tokens 10 :output-tokens 2} (:usage data))))
            (when-not (= :completed status)
              (is (= status (:status (ex-data (:error result))))))
            (kernel/dispose-all! ctx)
            (let [reopened (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}]})]
              (try
                (let [events ((:events (kernel/require-service reopened :session/store)))]
                  (is (= 1 (count (filter #(= "agent/run/end" (:type %)) events)))))
                (finally (kernel/dispose-all! reopened)))))
          (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))))

(deftest registry-classifies-provider-results-without-promoting-failure
  (doseq [[result status reason]
          [[{:output "done" :stop-reason :completed} :completed :completed]
           [{:output "" :stop-reason :error :error "failed"} :failed :provider-error]
           [{:output "" :stop-reason :aborted} :cancelled :cancelled]
           [{:output "old" :stop-reason :restored} :uncertain :restored]
           [{:output "ambiguous"} :uncertain :unknown]
           [{:stop-reason :completed :error "contradictory"} :failed :provider-error]
           [{:stop-reason :completed :status :failed :reason :step-budget}
            :failed :step-budget]]]
    (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session} {:ns 'qi.plugins.subagent}]})]
      (try
        (let [registry (kernel/require-service ctx :subagents/runtime)]
          ((:register! registry)
           {:id :test :capabilities {}
            :start (fn [_] {:result (doto (promise) (deliver result))
                            :cancel! (constantly true) :dispose! (fn [])})})
          (let [id (:id ((:start! registry) {:provider :test :prompt "run"}))
                actual ((:wait! registry) id 2000)]
            (is (= status (:status actual) (:status ((:job registry) id))))
            (is (= reason (:reason actual)))
            (is (= :not-run (:verification actual)))
            (let [ends (filter #(= "subagent/run/end" (:type %))
                               ((:events (kernel/require-service ctx :session/store))))]
              (is (= 1 (count ends)))
              (is (= (:run-id actual) (get-in (first ends) [:data :run-id])))
              (is (= status (get-in (first ends) [:data :status]))))
            (when-not (= :completed status)
              (is (not= :completed (:stop-reason actual))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest late-provider-completion-cannot-resurrect-stopped-child
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.subagent}]})
        result (promise) completed (promise)]
    (try
      (let [registry (kernel/require-service ctx :subagents/runtime)]
        ((:register! registry)
         {:id :test :capabilities {}
          :start (fn [_] {:result result :cancel! (constantly true) :dispose! (fn [])})})
        (let [id (:id ((:start! registry) {:provider :test :prompt "run"}))]
          (future (deliver completed ((:wait! registry) id 2000)))
          ((:stop! registry) id)
          (deliver result {:stop-reason :completed :output "late"})
          (deref completed 3000 nil)
          (is (= :stopped (:status ((:job registry) id))))))
      (finally (deliver result {:stop-reason :aborted}) (kernel/dispose-all! ctx)))))

(deftest interrupted-parent-is-recovered-once-without-inventing-success
  (let [directory (fs/create-temp-dir {:prefix "qi-run-restore-"})
        path (str (fs/path directory "session.jsonl"))
        profile {:plugins [{:ns 'qi.plugins.session :config {:path path :fsync? false}}]}
        first-ctx (plugin/boot! profile)]
    (try
      (let [store (kernel/require-service first-ctx :session/store)]
        ((:append! store) "message" {:message {:role "user" :content "legacy log message"}})
        ((:append! store) "agent/run/start" {:run-id "interrupted"}))
      (kernel/dispose-all! first-ctx)
      (dotimes [_ 2]
        (let [ctx (plugin/boot! (update profile :plugins into
                                       [{:ns 'qi.plugins.mock :config {:responses []}}
                                        {:ns 'qi.plugins.runtime}]))]
          (try
            (let [store (kernel/require-service ctx :session/store)
                  ends (filter #(= "agent/run/end" (:type %)) ((:events store)))]
              (is (= 1 (count ends)))
              (is (= "uncertain" (name (get-in (first ends) [:data :status]))))
              (is (= "legacy log message" (:content (first ((:messages store)))))))
            (finally (kernel/dispose-all! ctx)))))
      (finally (kernel/dispose-all! first-ctx) (fs/delete-tree directory)))))

(deftest restored-roster-does-not-return-a-previous-runs-success
  (let [directory (fs/create-temp-dir {:prefix "qi-roster-restore-"})
        path (str (fs/path directory ".qi-agent" "sessions" "owner.jsonl"))
        profile {:plugins [{:ns 'qi.plugins.session :config {:path path :fsync? false}}]}
        first-ctx (plugin/boot! profile)]
    (try
      (let [store (kernel/require-service first-ctx :session/store)
            roster (fs/path directory ".qi-agent" "artifacts" (:session-id store) "children.edn")]
        (fs/create-dirs (fs/parent roster))
        (spit (str roster)
              (pr-str {:version 1 :children
                       [{:id "interrupted" :provider :test :status :running
                         :result {:stop-reason :completed :output "previous run"}}
                        {:id "old-bug" :provider :test :status :completed
                         :result {:stop-reason :error :error "provider failure"}}]})))
      (kernel/dispose-all! first-ctx)
      (let [ctx (plugin/boot! (update profile :plugins conj {:ns 'qi.plugins.subagent}))]
        (try
          (let [registry (kernel/require-service ctx :subagents/runtime)]
            (is (= :uncertain (:status ((:wait! registry) "interrupted" 0))))
            (is (nil? (:output ((:wait! registry) "interrupted" 0))))
            (is (= :failed (:status ((:job registry) "old-bug"))))
            (is (= :failed (:status ((:wait! registry) "old-bug" 0)))))
          (finally (kernel/dispose-all! ctx))))
      (finally (kernel/dispose-all! first-ctx) (fs/delete-tree directory)))))

(deftest workflow-never-admits-dependents-of-a-false-success
  (let [starts (atom 0)
        {:keys [ctx]} (fixture/fixture
                       (atom {})
                       {:subagents/runtime
                        {:start! (fn [_] (swap! starts inc) {:id "bad"})
                         :wait! (fn [_ _] {:stop-reason :completed :error "provider failed"})
                         :interrupt! (constantly true)}})]
    (fixture/mount! ctx workflow/plugin)
    (try
      (fixture/call ctx "workflow" {:action "define" :id "outcome" :kind "pipeline"
                                    :nodes [{:id "a" :prompt "first"} {:id "b" :prompt "dependent"}]})
      (let [run (fixture/call ctx "workflow" {:action "run" :id "outcome" :expected_revision 0})
            ended (fixture/wait-run ctx (:id run))]
        (is (= "failed" (:status ended)))
        (is (= ["failed" "skipped"] (mapv :status (:nodes ended))))
        (is (= :provider-error (get-in ended [:nodes 0 :result :reason])))
        (is (= 1 @starts)))
      (finally (kernel/dispose-all! ctx)))))

(deftest workflow-preserves-cancelled-and-uncertain-child-outcomes
  (doseq [[stop status] [[:aborted "cancelled"] [:restored "uncertain"]]]
    (let [starts (atom 0)
          {:keys [ctx]} (fixture/fixture
                         (atom {})
                         {:subagents/runtime
                          {:start! (fn [_] (swap! starts inc) {:id "child"})
                           :wait! (fn [_ _] {:stop-reason stop})
                           :interrupt! (constantly true)}})]
      (fixture/mount! ctx workflow/plugin)
      (try
        (fixture/call ctx "workflow" {:action "define" :id "terminal" :kind "pipeline"
                                      :nodes [{:id "a" :prompt "first"} {:id "b" :prompt "dependent"}]})
        (let [run (fixture/call ctx "workflow" {:action "run" :id "terminal" :expected_revision 0})
              ended (fixture/wait-run ctx (:id run))]
          (is (= status (:status ended) (get-in ended [:nodes 0 :status])))
          (is (= 1 @starts)))
        (finally (kernel/dispose-all! ctx))))))

(deftest queued-child-message-keeps-the-active-run-identity
  (let [result (promise)
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session} {:ns 'qi.plugins.subagent}]})]
    (try
      (let [registry (kernel/require-service ctx :subagents/runtime)]
        ((:register! registry)
         {:id :test :capabilities {}
          :start (fn [_] {:result result :message! (constantly {:queued true :accepted true})
                          :cancel! (constantly true) :dispose! (fn [])})})
        (let [job ((:start! registry) {:provider :test :prompt "start"})
              sent ((:send! registry) (:id job) "queued")]
          (deliver result {:stop-reason :completed :run-id "native-child-run" :output "done"})
          (let [done ((:wait! registry) (:id job) 2000)
                events ((:events (kernel/require-service ctx :session/store)))]
            (is (= (:run-id job) (:run_id sent) (:run-id done)))
            (is (= "native-child-run" (:execution-run-id done)))
            (is (= 1 (count (filter #(= "subagent/run/start" (:type %)) events))))
            (is (= 1 (count (filter #(= "subagent/run/end" (:type %)) events)))))))
      (finally (deliver result {:stop-reason :aborted}) (kernel/dispose-all! ctx)))))
