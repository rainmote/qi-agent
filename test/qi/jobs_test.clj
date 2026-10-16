(ns qi.jobs-test
  (:require [qi.cancellation :as cancellation]
            [qi.jobs :as jobs]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.execution-world :as execution-world]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(defn- await-status [manager job-id]
  (loop [attempt 0]
    (let [job (first (filter #(= job-id (:job-id %)) ((:list manager))))]
      (if (or (not (contains? #{:queued :running :cancelling} (:status job)))
              (>= attempt 200))
        job
        (do (Thread/sleep 10) (recur (inc attempt)))))))

(defn- controlled-world []
  (let [calls (atom [])]
    {:calls calls
     :spawn! (fn [{:keys [cancel-token] :as request}]
               (let [finished (promise)
                     dispose (cancellation/on-cancel!
                              cancel-token #(deliver finished :cancelled))]
                 (try
                   (swap! calls conj (assoc request :finish finished))
                   (let [result @finished]
                     (cancellation/throw-if-cancelled! cancel-token)
                     (if (instance? Throwable result) (throw result)
                         (merge {:exit-code 0 :stdout "" :stderr ""} result)))
                   (finally (dispose)))))}))

(defn- await-calls [calls n]
  (loop [attempt 0]
    (if (or (>= (count @calls) n) (>= attempt 200))
      @calls
      (do (Thread/sleep 10) (recur (inc attempt))))))

(deftest live-output-has-stable-cursors-and-a-bounded-tail
  (let [{:keys [spawn! calls]} (controlled-world)
        events (atom [])
        manager (jobs/create-manager spawn! {:max-output-chars 8 :max-read-chars 4
                                            :notify! #(swap! events conj [%1 %2])})]
    (try
      (let [{:keys [job-id]} ((:start! manager) {:command "controlled"} {})
            request (first (await-calls calls 1))]
        (is (:stream-output? request))
        ((:on-update request) {:stream :stdout :chunk "abcde"})
        (let [first-read ((:output manager) {:job-id job-id :limit 3} {})]
          (is (= "abc" (:output first-read)))
          (is (= 3 (:next-offset first-read)))
          (is (:truncated first-read)))
        ((:on-update request) {:stream :stderr :chunk "FGHIJK"})
        (let [retained ((:output manager) {:job-id job-id :offset 0 :limit 4} {})]
          (is (= "deFG" (:output retained)))
          (is (= 3 (:discarded-chars retained)))
          (is (= 7 (:next-offset retained)))
          (is (= 11 (:end-offset retained))))
        (deliver (:finish request) {:exit-code 7})
        (is (= :failed (:status (await-status manager job-id))))
        (is (= 7 (:exit-code (await-status manager job-id))))
        (is (= [:job/started :job/completed] (mapv first @events)))
        (is (= :failed (:status ((:kill! manager) job-id))))
        (is (= 1 (count (filter #(= :job/completed (first %)) @events)))))
      (finally ((:close! manager))))))

(deftest bounded-wait-wakes-on-output-completion-and-cancellation
  (let [{:keys [spawn! calls]} (controlled-world)
        manager (jobs/create-manager spawn! {:max-wait-ms 1000})]
    (try
      (let [{:keys [job-id]} ((:start! manager) {:command "controlled"} {})
            request (first (await-calls calls 1))
            waiting (future ((:output manager) {:job-id job-id :wait-ms 1000} {}))]
        ((:on-update request) {:stream :stdout :chunk "ready"})
        (is (= "ready" (:output (deref waiting 1500 {}))))
        (is (true? (:wait-timed-out ((:output manager)
                                    {:job-id job-id :offset 5 :wait-ms 20} {}))))
        (let [token (cancellation/create-token)
              pending (future
                        (try ((:output manager) {:job-id job-id :offset 5 :wait-ms 1000}
                              {:cancel-token token})
                             (catch Throwable e (ex-data e))))]
          (cancellation/cancel! token)
          (is (:cancelled (deref pending 1500 {}))))
        (let [pending (future ((:output manager) {:job-id job-id :offset 5 :wait-ms 1000} {}))]
          (deliver (:finish request) {})
          (is (= :completed (:status (deref pending 1500 {})))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"exceeds"
                              ((:output manager) {:job-id job-id :offset 6} {})))
        (doseq [args [{:wait-ms 1001} {:limit 50001} {:offset -1} {:wait-ms -1}]]
          (is (thrown? clojure.lang.ExceptionInfo
                       ((:output manager) (assoc args :job-id job-id) {})))))
      (finally ((:close! manager))))))

(deftest concurrency-and-retention-are-bounded-and-unload-cancels
  (let [{:keys [spawn! calls]} (controlled-world)
        manager (jobs/create-manager spawn! {:max-running 1 :max-retained 2})]
    (try
      (let [first-id (:job-id ((:start! manager) {:command "first"} {}))]
        (await-calls calls 1)
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"concurrency"
                              ((:start! manager) {:command "blocked"} {})))
        ((:kill! manager) first-id)
        (is (= :cancelled (:status (await-status manager first-id))))
        (let [second-id (:job-id ((:start! manager) {:command "second"} {}))
              second-request (second (await-calls calls 2))]
          (deliver (:finish second-request) {})
          (is (= :completed (:status (await-status manager second-id))))
          (let [third-id (:job-id ((:start! manager) {:command "third"} {}))]
            (await-calls calls 3)
            (is (= #{second-id third-id} (set (map :job-id ((:list manager))))))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo #"expired"
                                  ((:output manager) {:job-id first-id} {})))
            (is (zero? (:remaining ((:close! manager)))))
            (is (= :cancelled (:status (await-status manager third-id))))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo #"closed"
                                  ((:start! manager) {:command "closed"} {}))))))
      (finally ((:close! manager))))))

(deftest cancellation-before-launch-never-spawns-and-after-launch-cleans-up
  (let [parent (cancellation/create-token)
        spawned (atom 0)
        manager (jobs/create-manager
                 (fn [_] (swap! spawned inc) {:exit-code 0})
                 {:notify! (fn [kind _]
                             (when (= :job/started kind) (cancellation/cancel! parent)))})]
    (try
      (let [job ((:start! manager) {:command "must-not-spawn"} {:cancel-token parent})]
        (is (= :cancelled (:status (await-status manager (:job-id job)))))
        (is (zero? @spawned))
        (is (empty? (:callbacks @(:state parent)))))
      (finally ((:close! manager)))))
  (let [{:keys [spawn! calls]} (controlled-world)
        parent (cancellation/create-token)
        manager (jobs/create-manager spawn! {})]
    (try
      (let [job ((:start! manager) {:command "cancel-later"} {:cancel-token parent})]
        (await-calls calls 1)
        (cancellation/cancel! parent)
        (is (= :cancelled (:status (await-status manager (:job-id job)))))
        (is (empty? (:callbacks @(:state parent)))))
      (finally ((:close! manager))))))

(deftest plugin-completion-is-a-session-event-and-bash-is-backward-compatible
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-"})
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.execution-world
                                     :config {:root (str directory) :sandbox :none}}
                                    {:ns 'qi.plugins.session}
                                    {:ns 'qi.plugins.tools}]})]
    (try
      (let [bash (kernel/tool ctx "bash")]
        (is (= "legacy" (:stdout ((:execute bash) {:command "printf legacy"} {}))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"jobs plugin"
                              ((:execute bash) {:command "printf unused"
                                                :run_in_background true} {})))
        (plugin/load-plugin! ctx {:ns 'qi.plugins.jobs})
        (let [job ((:execute bash) {:command "printf started; sleep 0.2; printf done"
                                    :run_in_background true} {:call-id "test-call"})
              manager (kernel/require-service ctx :execution/jobs)
              first-output ((:execute (kernel/tool ctx "job_output"))
                            {:job_id (:job-id job) :wait_ms 1000} {})]
          (is (:background job))
          (is (str/includes? (:output first-output) "started"))
          (is (= :completed (:status (await-status manager (:job-id job)))))
          (is (= "starteddone" (:output ((:output manager) {:job-id (:job-id job)} {}))))
          (let [events ((:events (kernel/require-service ctx :session/store)))
                completions (filter #(= "job/completed" (:type %)) events)]
            (is (= 1 (count completions)))
            (is (= "test-call" (get-in (first completions) [:data :source-call-id]))))
          (is (str/includes? ((:render bash) {} job) (:job-id job)))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(deftest default-read-only-child-rejects-injected-background-bash
  (let [directory (str (fs/real-path (fs/create-temp-dir {:prefix "qi-jobs-child-"})))
        requests (atom [])
        child-config (some #(when (= 'qi.plugins.subagent-in-process (:ns %)) (:config %))
                           (:plugins (plugin/read-config "agent.edn")))
        child {:plugins [{:ns 'qi.plugins.session}
                         {:ns 'qi.plugins.execution-world :config {:root directory :sandbox :none}}
                         ;; Even a child mounting these tools must not widen its
                         ;; shipped read-only boundary or execute injected calls.
                         {:ns 'qi.plugins.jobs} {:ns 'qi.plugins.tools}
                         {:ns 'qi.plugins.mock
                          :config {:generate
                                   (fn [request]
                                     (swap! requests conj request)
                                     (if (= 1 (count @requests))
                                       {:message {:role "assistant" :content nil
                                                  :tool_calls [{:id "injected-background"
                                                                :type "function"
                                                                :function {:name "bash"
                                                                           :arguments "{\"command\":\"printf escaped > forbidden.txt\",\"run_in_background\":true}"}}]}
                                        :finish-reason "tool_calls"}
                                       {:message {:role "assistant" :content "finished"}
                                        :finish-reason "stop"}))}}
                         {:ns 'qi.plugins.runtime :config {:max-steps 3}}]}
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session} {:ns 'qi.plugins.subagent}
                                    {:ns 'qi.plugins.subagent-in-process
                                     :config (assoc child-config :child-profile child)}
                                    {:ns 'qi.plugins.subagent-tools}]})]
    (try
      (let [result ((:execute (kernel/tool ctx "delegate_task")) {:prompt "read only fixture"} {})
            names (map #(get-in % [:function :name]) (:tools (first @requests)))
            tool-message (some #(when (= "tool" (:role %)) %) (:messages (second @requests)))]
        (is (= :completed (:stop-reason result)))
        (is (= 2 (count @requests)))
        (is (not-any? #{"bash" "job_list" "job_output" "job_kill"} names))
        (is (str/includes? (:content tool-message) "read-only boundary"))
        (is (not (fs/exists? (fs/path directory "forbidden.txt")))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(defn- alive? [pid]
  (let [handle (java.lang.ProcessHandle/of pid)]
    (and (.isPresent handle) (.isAlive (.get handle)))))

(defn- await-stopped? [pid]
  ;; ProcessHandle termination sends a signal; kernel exit/reaping is asynchronous.
  ;; The bound is shorter than either fixture's sleep, so natural exit cannot pass.
  (let [deadline (+ (System/nanoTime) 1000000000)]
    (loop []
      (cond
        (not (alive? pid)) true
        (>= (System/nanoTime) deadline) false
        :else (do (Thread/sleep 5) (recur))))))

(deftest real-background-process-tree-is-killed-and-spools-are-removed-on-unload
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-kill-"})
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.execution-world
                                     :config {:root (str directory) :sandbox :none}}
                                    {:ns 'qi.plugins.jobs}
                                    {:ns 'qi.plugins.tools}]})]
    (try
      (let [manager (kernel/require-service ctx :execution/jobs)
            job ((:execute (kernel/tool ctx "bash"))
                 {:command "sleep 20 & echo $! > child.pid; printf alive; wait"
                  :run_in_background true} {})
            output ((:output manager) {:job-id (:job-id job) :wait-ms 1000} {})
            pid (parse-long (str/trim (slurp (str (fs/path directory "child.pid")))))]
        (is (= "alive" (:output output)))
        (is (alive? pid))
        (kernel/dispose-plugin! ctx :tools/jobs)
        (is (= :cancelled (:status (await-status manager (:job-id job)))))
        (is (await-stopped? pid))
        (is (nil? (kernel/service ctx :execution/jobs)))
        (is (nil? (kernel/tool ctx "job_kill")))
        (is (empty? (fs/glob (fs/path directory ".qi-agent/tool-output") "*.tmp" {:hidden true}))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(deftest world-streaming-keeps-preview-and-disk-limits
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-limits-"})
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.execution-world
                                     :config {:root (str directory) :sandbox :none
                                              :max-output-chars 4 :max-output-file-chars 16}}
                                    {:ns 'qi.plugins.jobs :config {:max-output-chars 8}}]})]
    (try
      (let [manager (kernel/require-service ctx :execution/jobs)
            world (kernel/require-service ctx :execution/world)
            foreground-chunks (atom [])
            foreground ((:spawn! world) {:command "printf 1234567890"
                                         :on-update #(swap! foreground-chunks conj (:chunk %))})
            job ((:start! manager) {:command "printf 1234567890"} {})]
        (is (= "1234" (:stdout foreground)))
        (is (= "1234" (apply str @foreground-chunks)))
        (is (= :completed (:status (await-status manager (:job-id job)))))
        (let [output ((:output manager) {:job-id (:job-id job)} {})]
          (is (= "34567890" (:output output)))
          (is (= 2 (:discarded-chars output))))
        (let [overflow ((:start! manager) {:command "printf 12345678901234567"} {})
              failed (await-status manager (:job-id overflow))]
          (is (= :failed (:status failed)))
          (is (str/includes? (:error failed) "disk limit")))
        (is (empty? (fs/glob (fs/path directory ".qi-agent/tool-output") "*.tmp" {:hidden true}))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(defn- check-inherited-output-pipe-cleanup []
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-pipes-"})
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.execution-world
                                     :config {:root (str directory) :sandbox :none
                                              :timeout-ms 100 :max-timeout-ms 1000}}]})]
    (try
      (let [world (kernel/require-service ctx :execution/world)
            started (System/nanoTime)]
        ;; Keep the parent around long enough for child discovery, then leave a
        ;; child owning inherited output pipes after the shell has exited.
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"timed out"
                              ((:spawn! world)
                               {:command "sleep 3 & echo $! > child.pid; sleep 0.05"})))
        (is (< (/ (- (System/nanoTime) started) 1000000) 1500))
        (is (await-stopped? (parse-long (str/trim (slurp (str (fs/path directory "child.pid"))))))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(deftest world-timeout-reclaims-children-missed-between-descendant-polls
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-unseen-child-"})
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.execution-world
                                     :config {:root (str directory) :sandbox :none
                                              :timeout-ms 200}}]})
        pid (atom nil)]
    (try
      (with-redefs-fn {(ns-resolve 'qi.plugins.execution-world 'remember-descendants!) (fn [& _] nil)}
        #(is (thrown-with-msg? clojure.lang.ExceptionInfo #"timed out"
                              ((:spawn! (kernel/require-service ctx :execution/world))
                               {:command "sleep 20 & echo $! > child.pid; sleep 0.03"}))))
      (reset! pid (parse-long (str/trim (slurp (str (fs/path directory "child.pid"))))))
      (is (await-stopped? @pid))
      (finally
        (when @pid @(process/process ["/bin/kill" "-KILL" (str @pid)] {:out :string :err :string}))
        (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(deftest world-process-group-stops-after-its-babashka-parent-is-killed
  (let [directory (fs/create-temp-dir {:prefix "qi-jobs-parent-death-"})
        pid (atom nil)
        code (str "(require '[qi.plugin :as p] '[qi.kernel :as k])"
                  "(let [c (p/boot! {:plugins [{:ns 'qi.plugins.execution-world :config {:root "
                  (pr-str (str directory)) " :sandbox :none :timeout-ms 30000}}]})]"
                  "((:spawn! (k/require-service c :execution/world)) {:command \"sleep 20 & echo $! > child.pid; wait\"}))")
        parent (process/process ["bb" "--classpath" "src:plugins" "-e" code]
                                {:out :string :err :string})]
    (try
      (loop [n 0]
        (when (and (< n 200) (not (fs/exists? (fs/path directory "child.pid"))))
          (Thread/sleep 10) (recur (inc n))))
      (reset! pid (parse-long (str/trim (slurp (str (fs/path directory "child.pid"))))))
      (is (alive? @pid))
      @(process/process ["/bin/kill" "-KILL" (str (.pid (:proc parent)))] {:out :string :err :string})
      (is (await-stopped? @pid))
      (finally
        (when (.isAlive (:proc parent)) (process/destroy-tree parent))
        (when @pid @(process/process ["/bin/kill" "-KILL" (str @pid)] {:out :string :err :string}))
        (fs/delete-tree directory)))))
(deftest world-timeout-includes-inherited-output-pipes
  (check-inherited-output-pipe-cleanup))

(deftest world-tracks-children-while-output-pumps-are-starting
  ;; Output-pump setup can be descheduled after the child shell starts. Keep
  ;; the existing timeout and cleanup assertions; reproduce that scheduling
  ;; gap deterministically rather than hoping a busy CI runner triggers it.
  (let [pump-var #'execution-world/pump!
        original @pump-var]
    (with-redefs-fn {pump-var (fn [& args]
                              (Thread/sleep 150)
                              (apply original args))}
      check-inherited-output-pipe-cleanup)))

(deftest background-bash-cannot-bypass-the-runtime-trust-and-approval-gates
  (doseq [[trusted? approval expected-starts] [[false :allow 0] [true :deny 0] [true :allow 1]]]
    (let [ctx (kernel/create-context)
          owner (kernel/plugin-context ctx :test/jobs-services)
          spawned (atom 0)
          replies (atom [{:message {:role "assistant" :content nil
                                    :tool_calls [{:id "background-policy"
                                                  :type "function"
                                                  :function {:name "bash"
                                                             :arguments {:command "mock command"
                                                                         :run_in_background true}}}]}
                          :finish-reason "tool_calls"}
                         {:message {:role "assistant" :content "Finished offline policy fixture"}
                          :finish-reason "stop"}])]
      (try
        (kernel/register-service! owner :execution/world
                                  {:provider :test :capabilities #{:process}
                                   :resolve! identity
                                   :spawn! (fn [_] (swap! spawned inc) {:exit-code 0})})
        (kernel/register-service! owner :project/trust {:trusted? (constantly trusted?)})
        (kernel/register-service! owner :approval/request (constantly approval))
        (kernel/register-service! owner :llm/generate
                                  (fn [_] (let [reply (first @replies)]
                                            (swap! replies subvec 1) reply)))
        (plugin/load-all! ctx [{:ns 'qi.plugins.session}
                               {:ns 'qi.plugins.jobs}
                               {:ns 'qi.plugins.tools}
                               {:ns 'qi.plugins.policy
                                :config {:trusted-tools ["bash"] :approval-tools ["bash"]}}
                               {:ns 'qi.plugins.runtime}])
        ((kernel/require-service ctx :agent/run) "Run offline mock job" {})
        (let [manager (kernel/require-service ctx :execution/jobs)]
          (doseq [job ((:list manager))] (await-status manager (:job-id job)))
          (is (= expected-starts @spawned))
          (is (= expected-starts (count ((:list manager))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest invalid-provider-result-is-not-reported-as-success
  (let [manager (jobs/create-manager (constantly {}) {})]
    (try
      (let [job ((:start! manager) {:command "invalid-provider"} {})
            result (await-status manager (:job-id job))]
        (is (= :failed (:status result)))
        (is (str/includes? (:error result) "no shell exit code")))
      (finally ((:close! manager))))))
