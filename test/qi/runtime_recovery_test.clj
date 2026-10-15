(ns qi.runtime-recovery-test
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.runtime :as runtime]
            [qi.plugins.session :as session]
            [qi.plugins.subagent-in-process :as child]
            [qi.session-preferences :as preferences]
            [clojure.string :as str]
            [babashka.fs :as fs]
            [clojure.test :refer [deftest is testing]]))

(deftest response-detail-is-durable-and-presentation-only
  (let [directory (fs/create-temp-dir {:prefix "qi-response-detail-"})
        path (str (fs/path directory "session.jsonl"))
        requests (atom [])
        config {:plugins [{:ns 'qi.plugins.session :config {:path path}}
                          {:ns 'qi.plugins.mock
                           :config {:generate (fn [request]
                                                (swap! requests conj request)
                                                {:message {:role "assistant" :content "ok"}
                                                 :finish-reason "stop"})}}
                          {:ns 'qi.plugins.runtime :config {:system-prompt "base"}}
                          {:ns 'qi.plugins.remote-registry}
                          {:ns 'qi.plugins.remote-api}]}]
    (try
      (let [ctx (plugin/boot! config)]
        (try
          (let [rpc (:invoke! (kernel/require-service ctx :remote/registry))]
            (is (= {:response_detail "auto"} (rpc "session.preferences" {})))
            (doseq [mode ["short" "auto" "detailed"]]
              (rpc "session.preferences.set" {:response_detail mode})
              ((kernel/require-service ctx :agent/run) "test")
              (let [prompt (:system-prompt (last @requests))]
                (is (str/includes? prompt (str "Response detail: " mode)))
                (is (str/includes? prompt "verification"))
                (is (str/includes? prompt "grants no permissions"))))
            (is (thrown? clojure.lang.ExceptionInfo
                         (rpc "session.preferences.set" {:response_detail "allow"})))
            (is (thrown? clojure.lang.ExceptionInfo
                         (rpc "session.preferences.set" {:response_detail "short" :permissions "allow"}))))
          (finally (kernel/dispose-all! ctx))))
      (let [ctx (plugin/boot! config)]
        (try
          (let [rpc (:invoke! (kernel/require-service ctx :remote/registry))]
            (is (= "detailed" (get-in (rpc "session.snapshot" {}) [:preferences :response_detail])))
            (rpc "session.clear" {})
            (is (= {:response_detail "detailed"} (rpc "session.preferences" {}))))
          (finally (kernel/dispose-all! ctx))))
      (is (= "auto" (:response_detail (preferences/snapshot [{:type "session/preferences" :data {:response_detail "unrecognized"}}]))))
      (finally (fs/delete-tree directory)))))

(defn- answer [text]
  {:message {:role "assistant" :content text} :finish-reason "stop"})

(defn- step-limit-context [config calls finish-at]
  (plugin/boot!
   {:plugins
    [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
     {:ns 'qi.plugins.mock
      :config
      {:generate
       (fn [_]
         (let [step (swap! calls inc)]
           (if (= step finish-at)
             (answer "done")
             {:message
              {:role "assistant"
               :tool_calls
               [{:id (str "step-" step)
                 :type "function"
                 :function {:name "calculate"
                            :arguments (str "{\"operation\":\"add\",\"a\":" step ",\"b\":1}")}}]}
              :finish-reason "tool_calls"})))}}
     {:ns 'qi.plugins.math}
     {:ns 'qi.plugins.runtime
      :config (merge {:system-prompt "Offline step-budget test"} config)}]}))

(deftest shipped-parent-profiles-use-the-raised-step-limit
  (doseq [path ["agent.edn" "presets/standard/agent.edn"
                "presets/creator/agent.edn"]]
    (let [spec (some #(when (= 'qi.plugins.runtime (:ns %)) %)
                     (:plugins (plugin/read-config path)))]
      (is (= 256 (get-in spec [:config :max-steps])) path))))

(deftest default-step-limit-allows-a-final-answer-on-the-last-step
  (let [calls (atom 0)
        ctx (step-limit-context {} calls 256)]
    (try
      (let [result ((kernel/require-service ctx :agent/run) "long tool sequence")]
        (is (= "done" (:content result)))
        (is (= 256 (:steps result)))
        (is (= 256 @calls)))
      (finally (kernel/dispose-all! ctx)))))

(deftest default-step-limit-stops-before-an-extra-model-request
  (let [calls (atom 0)
        ctx (step-limit-context {} calls 257)]
    (try
      (let [error (try
                    ((kernel/require-service ctx :agent/run) "one step too many")
                    nil
                    (catch clojure.lang.ExceptionInfo error error))]
        (is (= "Agent exceeded its step limit" (some-> error ex-message)))
        (is (= 256 (:max-steps (ex-data error))))
        (is (= 256 @calls) "The limit must stop the next model request")
        (is (= :idle (:phase ((:state (kernel/require-service ctx :agent/session)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest profile-and-per-run-step-limits-still-take-precedence
  (doseq [{:keys [config options limit]}
          [{:config {:max-steps 2} :options {} :limit 2}
           {:config {:max-steps 1} :options {:max-steps 3} :limit 3}]
          finish-at [limit (inc limit)]]
    (let [calls (atom 0)
          ctx (step-limit-context config calls finish-at)]
      (try
        (let [run (kernel/require-service ctx :agent/run)]
          (if (= limit finish-at)
            (is (= limit (:steps (run "finish within the explicit limit" options))))
            (let [error (try
                          (run "stop at the explicit limit" options)
                          nil
                          (catch clojure.lang.ExceptionInfo error error))]
              (is (= "Agent exceeded its step limit" (some-> error ex-message)))
              (is (= limit (:max-steps (ex-data error))))))
          (is (= limit @calls)))
        (finally (kernel/dispose-all! ctx))))))

(defn- append-messages! [ctx messages]
  (let [store (kernel/require-service ctx :session/store)]
    (doseq [message messages]
      ((:append! store) "message" {:message message}))))

(defn- context-profile [generate]
  {:plugins [{:ns 'qi.plugins.session}
             {:ns 'qi.plugins.mock :config {:generate generate}}
             {:ns 'qi.plugins.context-manager
              :config {:context-window 10000 :reserve-tokens 100
                       :retain-messages 4}}
             {:ns 'qi.plugins.runtime :config {:retry-delay-ms 1}}]})

(deftest overflow-retry-uses-the-committed-summary-and-keeps-current-user
  (doseq [recover? [true false]]
    (let [requests (atom [])
          generate (fn [request]
                     (if (:system-prompt request)
                       (answer "old goal and result")
                       (do
                         (swap! requests conj request)
                         (if (and recover? (= 2 (count @requests)))
                           (answer "recovered")
                           (throw (ex-info "context window exceeded"
                                           {:context-overflow true}))))))
          ctx (plugin/boot! (context-profile generate))]
      (try
        (append-messages! ctx [{:role "user" :content "old goal"}
                               {:role "assistant" :content "old result"}])
        (if recover?
          (is (= "recovered" (:content ((kernel/require-service ctx :agent/run)
                                        "current exact instruction"))))
          (is (thrown-with-msg? clojure.lang.ExceptionInfo #"context window"
                               ((kernel/require-service ctx :agent/run)
                                "current exact instruction"))))
        (is (= 2 (count @requests)) "Overflow retries remain bounded")
        (is (= [{:role "system"
                 :content "Previous conversation summary:\nold goal and result"}
                {:role "user" :content "current exact instruction"}]
               (:messages (second @requests))))
        (is (not= (:messages (first @requests))
                  (:messages (second @requests))))
        (finally (kernel/dispose-all! ctx))))))

(def batch-history
  [{:role "user" :content "old goal"}
   {:role "assistant"
    :tool_calls [{:id "a" :type "function"
                  :function {:name "read" :arguments "{}"}}
                 {:id "b" :type "function"
                  :function {:name "ls" :arguments "{}"}}]}
   {:role "tool" :tool_call_id "a" :content "alpha result"}
   {:role "tool" :tool_call_id "b" :content "beta result"}
   {:role "assistant" :content "old result"}
   {:role "user" :content "current exact instruction"}])

(defn- paired-tools? [messages]
  (let [calls (set (mapcat #(map :id (:tool_calls %)) messages))
        results (set (keep :tool_call_id messages))]
    (= calls results)))

(deftest compaction-preserves-complete-batches-and-a-consistent-summary-source
  (testing "Every small retain value preserves complete multi-tool batches"
    (doseq [retain (range 1 8)]
      (let [{:keys [dropped retained]} (session/compaction-plan batch-history retain)]
        (is (= batch-history (vec (concat dropped retained))))
        (is (paired-tools? dropped))
        (is (paired-tools? retained))
        (is (= (last batch-history) (last retained))))))
  (testing "Manual compaction uses the same safe boundary"
    (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session}]})]
      (try
        (append-messages! ctx batch-history)
        (let [store (kernel/require-service ctx :session/store)]
          (is (:compacted ((:compact! store) {:retain 3})))
          (is (= (subvec batch-history 1) (subvec ((:messages store)) 1)))
          (is (paired-tools? ((:messages store)))))
        (finally (kernel/dispose-all! ctx)))))
  (testing "An unfinished batch remains entirely on the retained side"
    (let [incomplete (subvec batch-history 0 3)
          plan (session/compaction-plan incomplete 1)]
      (is (= (subvec incomplete 0 1) (:dropped plan)))
      (is (= (subvec incomplete 1) (:retained plan)))))
  (let [sources (atom [])
        ctx (plugin/boot!
             (context-profile
              (fn [request]
                (swap! sources conj (get-in request [:messages 0 :content]))
                (answer "summary of dropped prefix"))))]
    (try
      (append-messages! ctx batch-history)
      (let [manager (kernel/require-service ctx :context/manager)
            store (kernel/require-service ctx :session/store)]
        (is (:compacted ((:compact! manager))))
        (is (= ["user: old goal"] @sources))
        (is (= (subvec batch-history 1) (subvec ((:messages store)) 1)))
        (is (= 5 (get-in (last (filter #(= "session/compaction" (:type %)) ((:events store))))
                        [:data :retained_message_count])))
        (append-messages! ctx [{:role "assistant" :content "second answer"}
                               {:role "user" :content "new exact instruction"}])
        (is (:compacted ((:compact! manager))))
        (is (paired-tools? ((:messages store))))
        (is (= "new exact instruction" (:content (last ((:messages store)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest stale-or-cancelled-semantic-summary-does-not-replace-new-context
  (doseq [cancel? [false true]]
    (let [holder (atom nil)
          token (cancellation/create-token)
          ctx (plugin/boot!
               (context-profile
                (fn [_]
                  (if cancel?
                    (cancellation/cancel! token)
                    (append-messages! @holder [{:role "user" :content "arrived during summary"}]))
                  (answer "obsolete summary"))))]
      (reset! holder ctx)
      (try
        (append-messages! ctx batch-history)
        (let [manager (kernel/require-service ctx :context/manager)
              store (kernel/require-service ctx :session/store)]
          (if cancel?
            (is (thrown-with-msg? clojure.lang.ExceptionInfo #"cancelled"
                                 ((:compact! manager) {:cancel-token token})))
            (is (= :context-changed
                   (:reason ((:compact! manager) {:cancel-token token})))))
          (is (not-any? #(= "session/compaction" (:type %)) ((:events store))))
          (is (= batch-history (subvec ((:messages store)) 0 (count batch-history)))))
        (finally (kernel/dispose-all! ctx))))))

(deftest concurrent-queue-drain-consumes-each-item-once-in-order
  (let [queue (atom [{:id :s1 :kind :steer} {:id :f1 :kind :follow-up}
                    {:id :s2 :kind :steer}])
        before-commit (promise)
        appended (promise)
        intercepted? (atom false)
        original-cas compare-and-set!
        original-swap swap!
        rendezvous! #(when (original-cas intercepted? false true)
                       (deliver before-commit true)
                       (deref appended 2000 ::timeout))
        writer (future
                 (when (= true (deref before-commit 2000 ::timeout))
                   (original-swap queue into [{:id :f2 :kind :follow-up}
                                              {:id :s3 :kind :steer}]))
                 (deliver appended true)
                 true)]
    ;; Instrument either atomic primitive so this regression also fails on the
    ;; former swap!-with-side-effects implementation, at the same CAS conflict.
    (with-redefs [clojure.core/compare-and-set!
                  (fn [a before after]
                    (when (identical? a queue) (rendezvous!))
                    (original-cas a before after))
                  clojure.core/swap!
                  (fn [a f & args]
                    (apply original-swap a
                           (fn [& values]
                             (let [value (apply f values)]
                               (when (identical? a queue) (rendezvous!))
                               value)) args))]
      (is (= [:s1 :s2 :s3] (mapv :id (#'runtime/drain-kind! queue :steer))))
      (is (= [:f1 :f2] (mapv :id @queue)))
      (is (empty? (#'runtime/drain-kind! queue :steer)))
      (is (= [:f1 :f2] (mapv :id (#'runtime/drain-kind! queue :follow-up))))
      (is (empty? @queue)))
    (is (= true (deref writer 2000 ::timeout)))))

(defn- child-profile [root generate]
  {:plugins [{:ns 'qi.plugins.session}
             {:ns 'qi.plugins.durable-state :config {:root (str root)}}
             {:ns 'qi.plugins.bb-repl :config {:root (str root) :sandbox :none}}
             {:ns 'qi.plugins.mock :config {:generate generate}}
             {:ns 'qi.plugins.runtime}]})

(deftest retained-and-restored-children-cancel-the-current-follow-up
  (doseq [restore? [false true]]
    (let [root (fs/create-temp-dir {:prefix "qi-cancel-recovery-"})
          calls (atom 0)
          started (promise)
          release (promise)
          generate (fn [{:keys [cancel-token]}]
                     (when (= 2 (swap! calls inc))
                       (deliver started cancel-token)
                       ;; A provider ignoring cancellation must still not commit
                       ;; a late normal response into the child conversation.
                       (deref release 3000 nil))
                     (answer "normal answer"))
          ctx (plugin/boot!
               {:plugins [{:ns 'qi.plugins.session
                           :config {:path (str (fs/path root ".qi-agent" "sessions" "root.jsonl"))}}
                          {:ns 'qi.plugins.subagent}
                          {:ns 'qi.plugins.subagent-in-process
                           :config {:allowed-tools []
                                    :child-profile (child-profile root generate)}}]})]
      (try
        (let [registry (kernel/require-service ctx :subagents/runtime)
              job ((:start! registry) {:provider :spawn :prompt "first"
                                      :parent-context ctx})
              id (:id job)]
          (is (= :completed (:stop-reason ((:wait! registry) id 3000))))
          (when restore? (is (true? ((:passivate! registry) id))))
          (is (:accepted ((:send! registry) id "second")))
          (let [token (deref started 3000 ::timeout)]
            (is (map? token))
            (is (true? ((:interrupt! registry) id)))
            (is (cancellation/cancelled? token))
            (deliver release true)
            (is (= :aborted (:stop-reason ((:wait! registry) id 3000))))
            (is (false? ((:interrupt! registry) id)))
            (let [snapshot ((:invoke! registry) id "session.snapshot" {})]
              (is (= 1 (count (filter #(and (= "message" (:type %))
                                            (= "assistant" (get-in % [:data :message :role])))
                                      (:events snapshot))))))))
        (finally
          (deliver release true)
          (kernel/dispose-all! ctx)
          (fs/delete-tree root))))))

(deftest child-cancellation-and-disposal-during-boot-do-not-start-model-work
  (doseq [dispose? [false true]]
    (let [root (fs/create-temp-dir {:prefix "qi-child-startup-"})
          booting (promise)
          release (promise)
          calls (atom 0)
          boot plugin/boot!]
      (try
        (with-redefs [plugin/boot! (fn [profile]
                                   (deliver booting true)
                                   (deref release 3000 nil)
                                   (boot profile {}))]
          (let [handle (#'child/start-child
                        (child-profile root (fn [_] (swap! calls inc) (answer "late")))
                        :spawn #{} {:agent-id "startup" :prompt "work"})]
            (is (= true (deref booting 2000 ::timeout)))
            (if dispose?
              ((:dispose! handle))
              (is (true? ((:cancel! handle)))))
            (deliver release true)
            (is (= :aborted (:stop-reason (deref (:result handle) 3000 {}))))
            (is (zero? @calls))
            (deref (:task handle) 3000 nil)
            ((:dispose! handle))))
        (finally (deliver release true) (fs/delete-tree root))))))

(deftest follow-up-can-be-cancelled-before-its-future-enters-the-runtime
  (doseq [dispose? [false true]]
  (let [root (fs/create-temp-dir {:prefix "qi-child-submission-"})
        holder (atom nil)
        boot plugin/boot!
        submitted (promise)
        release (promise)]
    (try
      (with-redefs [plugin/boot! (fn [profile]
                                 (let [ctx (boot profile {})]
                                   (reset! holder ctx)
                                   ctx))]
        (let [handle (#'child/start-child (child-profile root (constantly (answer "first")))
                                          :spawn #{} {:agent-id "submission" :prompt "first"})]
          (try
            (is (= :completed (:stop-reason (deref (:result handle) 3000 {}))))
            (let [ctx @holder
                  session (kernel/require-service ctx :agent/session)
                  submit (:submit! session)]
              (swap! (:state ctx) assoc-in [:services :agent/session :value :submit!]
                     (fn [message options]
                       (let [result (promise)
                             task (future
                                    (deliver submitted (:cancel-token options))
                                    (deref release 3000 nil)
                                    (deliver result @(:result (submit message options))))]
                         {:result result :task task})))
              (let [accepted ((:message! handle) "second")
                    token (deref submitted 2000 ::timeout)]
                (is (thrown-with-msg? clojure.lang.ExceptionInfo #"retry the message"
                                     ((:message! handle) "competing submission")))
                (is (not-any? #(= "competing submission" (get-in % [:data :message]))
                              ((:events (kernel/require-service ctx :session/store)))))
                (if dispose?
                  ((:dispose! handle))
                  (is (true? ((:cancel! handle)))))
                (is (cancellation/cancelled? token))
                (deliver release true)
                (is (= :aborted (:stop-reason (deref (:result accepted) 3000 {}))))))
            (finally ((:dispose! handle))))))
      (finally (deliver release true) (fs/delete-tree root))))))

(deftest state-revisions-are-monotonic-and-readable-in-snapshots
  (let [holder (atom nil)
        events (atom [])
        ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session}
                        {:ns 'qi.plugins.mock
                         :config {:generate (fn [_]
                                              (kernel/emit! @holder :llm/stream
                                                            {:type :text/delta :delta "a"})
                                              (kernel/emit! @holder :llm/stream
                                                            {:type :reasoning/delta :delta "b"})
                                              (answer "done"))}}
                        {:ns 'qi.plugins.runtime}]})]
    (reset! holder ctx)
    (try
      (let [session (kernel/require-service ctx :agent/session)]
        (is (= 0 (:revision ((:state session)))))
        ((:subscribe! session) #(when (= :agent/state (:type %)) (swap! events conj %)))
        ((kernel/require-service ctx :agent/run) "run")
        (let [revisions (mapv :revision @events)
              snapshot ((:state session))]
          (is (= (vec (range 1 (inc (count revisions)))) revisions))
          (is (= (last revisions) (:revision snapshot)))
          (is (= :idle (:phase snapshot)))
          (is (some #(= "a" (:partial-assistant %)) @events))
          (kernel/emit! ctx :llm/stream {:type :text/delta :delta "stale"})
          (is (= snapshot ((:state session))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest stale-child-watcher-does-not-complete-or-disable-cancellation-of-new-run
  (let [first-watcher (promise)
        first-completed (promise)
        release-first (promise)
        second-result (promise)
        cancellations (atom 0)
        ended (atom [])
        original-deliver deliver
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.subagent}]})]
    (try
      (with-redefs [clojure.core/deliver
                    (fn [target value]
                      (let [result (original-deliver target value)]
                        (when (= "first" (:output value))
                          (original-deliver first-completed value))
                        result))]
      (let [registry (kernel/require-service ctx :subagents/runtime)
            observed (kernel/plugin-context ctx :test/watchers)]
        (kernel/on! observed :subagent/end (fn [_ event] (swap! ended conj event)))
        ((:register! registry)
         {:id :test :capabilities {}
          :start (fn [_]
                   {:result (reify clojure.lang.IDeref
                              (deref [_]
                                (deliver first-watcher true)
                                (deref release-first 3000 nil)
                                {:output "first" :stop-reason :completed}))
                    :message! (fn [_] {:accepted true :result second-result})
                    :cancel! (fn []
                               (swap! cancellations inc)
                               (deliver second-result {:output "" :stop-reason :aborted})
                               true)
                    :dispose! (fn [])})})
        (let [id (:id ((:start! registry) {:provider :test :prompt "first"}))]
          (is (= true (deref first-watcher 2000 ::timeout)))
          (is (= :running (:status ((:job registry) id))))
          (is (:accepted ((:send! registry) id "second")))
          (deliver release-first true)
          ;; The old completion must resolve after the guarded registry update,
          ;; even though its result can no longer replace the current job.
          (is (= "first" (:output (deref first-completed 2000 {}))))
          (is (= :running (:status ((:job registry) id))))
          (is (not (realized? second-result)))
          (is (empty? @ended) "Stale completion must not publish a current end event")
          (is (true? ((:interrupt! registry) id)))
          (is (= 1 @cancellations))
          (is (= :aborted (:stop-reason ((:wait! registry) id 3000)))))))
      (finally
        (deliver release-first true)
        (deliver second-result {:stop-reason :aborted})
        (kernel/dispose-all! ctx)))))


(defn progress-answer [text] {:message {:role "assistant" :content text} :finish-reason "stop"})
(defn progress-call [id args] {:id (str id) :type "function" :function {:name "probe" :arguments args}})
(defn progress-tool-answer [calls] {:message {:role "assistant" :tool_calls calls} :finish-reason "tool_calls"})
(defn progress-fixture [generate execute config tool-options]
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                                    {:ns 'qi.plugins.mock :config {:generate generate}}
                                    {:ns 'qi.plugins.runtime :config (merge {:max-steps 20} config)}]})]
    (kernel/register-tool! (kernel/plugin-context ctx :acceptance/tools)
                          (merge {:name "probe" :description "Offline progress-fixture"
                                  :parameters {:type "object"} :execute execute} tool-options))
    ctx))
(defn progress-attempt [ctx]
  (try ((kernel/require-service ctx :agent/run) "offline task")
       (catch clojure.lang.ExceptionInfo error (ex-data error))))
(defn progress-events [ctx] ((:events (kernel/require-service ctx :session/store))))

(deftest static-results-stop-with-auditable-no-progress
  (let [requests (atom 0) bodies (atom 0)
        ctx (progress-fixture (fn [_] (let [n (swap! requests inc)]
                               (progress-tool-answer [(progress-call n (if (odd? n) "{\"a\":1,\"b\":2}" "{\"b\":2,\"a\":1}"))])))
                     (fn [_ _] (swap! bodies inc) {:result 3}) {} {})]
    (try
      (let [result (progress-attempt ctx)
            terminal (:data (last (filter #(= "agent/run/end" (:type %)) (progress-events ctx))))]
        (is (= :no-progress (:reason result)))
        (is (= 3 @bodies @requests))
        (is (= ["1" "2" "3"] (get-in terminal [:no-progress :call-ids])))
        (is (= :failed (:status terminal))))
      (finally (kernel/dispose-all! ctx)))))

(deftest changing-results-steering-and-polling-are-progress-aware
  (doseq [mode [:changing :steer :poll]]
    (testing (name mode)
      (let [requests (atom 0) bodies (atom 0) context (atom nil)
            ctx (progress-fixture
                 (fn [_] (let [n (swap! requests inc)]
                           (if (= n (if (= mode :steer) 5 9)) (progress-answer "done")
                               (progress-tool-answer [(progress-call n "{}")]))))
                 (fn [_ _]
                   (let [n (swap! bodies inc)]
                     (when (and (= mode :steer) (= n 2))
                       ((:steer! (kernel/require-service @context :agent/session)) "new direction"))
                     (if (= mode :changing) {:revision n} {:status "waiting"})))
                 {} (if (= mode :poll) {:progress-mode :poll} {}))]
        (reset! context ctx)
        (try
          (is (= "done" (:content (progress-attempt ctx))))
          (when (= mode :steer)
            (let [added (:data (first (filter #(= "queue/added" (:type %)) (progress-events ctx))))
                  consumed (:data (first (filter #(= "queue/consumed" (:type %)) (progress-events ctx))))]
              (is (= (:id added) (:id consumed)))
              (is (some? (:id consumed)))))
          (finally (kernel/dispose-all! ctx)))))))

(deftest unchanged-polling-has-its-own-finite-limit
  (let [bodies (atom 0)
        ctx (progress-fixture (fn [_] (progress-tool-answer [(progress-call (str (random-uuid)) "{}")]))
                     (fn [_ _] (swap! bodies inc) {:status "waiting"})
                     {:max-stalled-polls 5} {:progress-mode :poll})]
    (try
      (is (= :no-progress (:reason (progress-attempt ctx))))
      (is (= 5 @bodies))
      (finally (kernel/dispose-all! ctx)))))

(deftest forty-read-tools-have-four-workers-and-ordered-results
  (let [requests (atom 0) active (atom 0) peak (atom 0)
        ctx (progress-fixture (fn [_] (if (= 1 (swap! requests inc))
                               (progress-tool-answer (mapv #(progress-call % (str "{\"n\":" % "}")) (range 40))) (progress-answer "done")))
                     (fn [{:keys [n]} _]
                       (let [running (swap! active inc)]
                         (swap! peak max running)
                         (try (Thread/sleep 50) {:n n} (finally (swap! active dec))))) {} {})]
    (try
      (is (= "done" (:content (progress-attempt ctx))))
      (is (<= @peak 4))
      (is (> @peak 1))
      (is (= (mapv str (range 40))
             (mapv #(get-in % [:data :call-id]) (filter #(= "tool/result" (:type %)) (progress-events ctx)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest cancelling-a-batch-prevents-waiting-tool-bodies
  (let [started (atom 0) four (promise) release (promise)
        ctx (progress-fixture (fn [_] (progress-tool-answer (mapv #(progress-call % "{}") (range 40))))
                     (fn [_ _] (when (= 4 (swap! started inc)) (deliver four true)) @release {:done true}) {} {})]
    (try
      (let [session (kernel/require-service ctx :agent/session)
            task ((:submit! session) "cancel progress-fixture")]
        (is (= true (deref four 3000 ::timeout)))
        (Thread/sleep 75)
        ((:abort! session))
        (deliver release true)
        (let [result (deref (:result task) 3000 ::timeout)]
          (is (not= ::timeout result))
          (is (= :cancelled (:status (ex-data (:error result))))))
        (is (<= @started 4)))
      (finally (deliver release true) (kernel/dispose-all! ctx)))))

(deftest automatic-compaction-explains-its-chunks-and-closes-on-every-outcome
  (doseq [mode [:success :failure :cancel]]
    (testing (name mode)
      (let [lifecycle (atom []) phases (atom [])
            ctx (plugin/boot!
                 {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                            {:ns 'qi.plugins.mock :config {:context-window 2048
                             :generate (fn [{:keys [system-prompt cancel-token]}]
                                         (if (.contains (or system-prompt "") "Summarize")
                                           (case mode
                                             :failure (throw (ex-info "offline summary failure" {:retryable false}))
                                             :cancel (do (cancellation/cancel! cancel-token) (progress-answer "late"))
                                             (progress-answer "summary")) (progress-answer "done")))}}
                            {:ns 'qi.plugins.context-manager :config {:context-window 2048 :reserve-tokens 128
                                                                    :retain-messages 1 :max-source-chars 1800}}
                            {:ns 'qi.plugins.runtime}]})]
        (try
          (kernel/on! (kernel/plugin-context ctx :acceptance/hooks) :context/compaction (fn [_ data] (swap! lifecycle conj data)))
          (let [store (kernel/require-service ctx :session/store)
                old {:role "user" :content (apply str (repeat 12000 "x"))}]
            ((:append! store) "message" {:message old})
            ((:subscribe! (kernel/require-service ctx :agent/session)) #(swap! phases conj %))
            (progress-attempt ctx)
            (is (= :started (:status (first @lifecycle))))
            (is (= (case mode :success :completed :failure :failed :cancel :cancelled) (:status (last @lifecycle))))
            (is (some #(= :compacting (:phase %)) @phases))
            (is (= :idle (:phase (last (filter #(= :agent/state (:type %)) @phases)))))
            (is (every? #(and (:run-id %) (:compaction-id %) (:total-chunks %)) @lifecycle))
            (if (= mode :success)
              (is (= (:total-chunks (last @lifecycle)) (:completed-chunks (last @lifecycle))))
              (do (is (= old (first ((:messages store)))))
                  (is (not-any? #(= "session/compaction" (:type %)) (progress-events ctx))))))
          (finally (kernel/dispose-all! ctx)))))))


(deftest steering-at-the-repetition-threshold-still-takes-effect
  (let [requests (atom 0) bodies (atom 0) context (atom nil)
        ctx (progress-fixture
             (fn [_] (let [n (swap! requests inc)]
                       (if (= n 6) (progress-answer "done")
                           (progress-tool-answer [(progress-call n "{}")]))))
             (fn [_ _] (when (= 3 (swap! bodies inc))
                         ((:steer! (kernel/require-service @context :agent/session)) "new instruction"))
               {:result 3}) {} {})]
    (reset! context ctx)
    (try
      (is (= "done" (:content (progress-attempt ctx))))
      (is (= 5 @bodies))
      (finally (kernel/dispose-all! ctx)))))

(deftest alternating-read-cycle-produces-one-budget-bound-diagnostic
  (let [requests (atom 0) ctx (progress-fixture
                             (fn [_] (let [n (swap! requests inc)]
                                       (progress-tool-answer [(progress-call n (str "{\"target\":\"" (if (odd? n) "A" "B") "\"}"))])))
                             (fn [args _] args) {:max-model-requests 8 :max-wall-ms 5000} {})]
    (try
      (let [result (progress-attempt ctx)
            terminal (:data (last (filter #(= "agent/run/end" (:type %)) (progress-events ctx))))
            plan (:diagnostic-plan result)]
        (is (= :no-progress (:reason result))) (is (= 5 @requests))
        (is (= :read-cycle (get-in result [:no-progress :kind])))
        (is (= ["3" "4" "5"] (:call-ids plan)))
        (is (= 3 (count (:evidence plan))))
        (is (= 2 (count (set (map :result-fingerprint (:evidence plan))))))
        (is (= :no-new-observation (:evidence-gap plan)))
        (is (= 1 (count (:steps plan)))) (is (every? :read-only (:steps plan)))
        (is (false? (:automatic-execution plan)))
        (is (= 5 (get-in plan [:budget :requests-used])))
        (is (= 8 (get-in plan [:budget :max-requests])))
        (is (integer? (get-in plan [:budget :deadline-at-ms])))
        (is (= plan (:diagnostic-plan terminal))))
      (finally (kernel/dispose-all! ctx)))))

(deftest uncertain-write-produces-reconciliation-without-a-second-dispatch
  (let [requests (atom 0) writes (atom 0)
        ctx (progress-fixture (fn [_] (progress-tool-answer [(progress-call (swap! requests inc) "{}")]))
                              (fn [_ _] (swap! writes inc) (throw (ex-info "external response lost" {:uncertain true})))
                              {:max-model-requests 4 :max-wall-ms 5000} {:execution-mode :sequential})]
    (try
      (let [result (progress-attempt ctx) plan (:diagnostic-plan result)]
        (is (= :no-progress (:reason result))) (is (= 1 @writes @requests))
        (is (= :uncertain-action (get-in result [:no-progress :kind])))
        (is (= :external-result-unreconciled (:evidence-gap plan)))
        (is (= [:reconcile-current-state] (mapv :action (:steps plan))))
        (is (every? :read-only (:steps plan)))
        (is (= 1 (get-in plan [:budget :requests-used]))))
      (finally (kernel/dispose-all! ctx)))))
