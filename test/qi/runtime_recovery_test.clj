(ns qi.runtime-recovery-test
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.runtime :as runtime]
            [qi.plugins.session :as session]
            [qi.plugins.subagent-in-process :as child]
            [babashka.fs :as fs]
            [clojure.test :refer [deftest is testing]]))

(defn- answer [text]
  {:message {:role "assistant" :content text} :finish-reason "stop"})

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
        (is (= 5 (get-in (last ((:events store)))
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
