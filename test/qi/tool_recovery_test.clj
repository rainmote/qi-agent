(ns qi.tool-recovery-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.runtime :as runtime]
            [qi.tool-recovery :as recovery]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(defn- call [id] {:id id :type "function" :function {:name "probe" :arguments "{}"}})
(defn- store-context [path]
  (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}]}))
(defn- restored [path]
  (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}
                          {:ns 'qi.plugins.mock :config {:generate (fn [_] (throw (ex-info "Recovery must not call provider" {})))}}
                          {:ns 'qi.plugins.runtime}]}))
(defn- seed! [path ids version? add!]
  (let [ctx (store-context path)]
    (try
      (let [store (kernel/require-service ctx :session/store) append! (:append! store)
            scope {:session_id (:session-id store) :run-id "interrupted" :step 1}]
        (append! "agent/run/start" {:run-id "interrupted"})
        (append! "step/start" {:step 1})
        (append! "message" {:message {:role "user" :content "Preserve my original requirement."}})
        (let [event (append! "message" (cond-> (assoc scope :message {:role "assistant" :tool_calls (mapv call ids)})
                                        version? (assoc :tool-dispatch-version 1)))]
          (add! append! (assoc scope :assistant-event-id (:id event)))))
      (finally (kernel/dispose-all! ctx)))))
(defn- result-data [scope id text]
  (merge scope {:call-id id :name "probe" :ok true :is-error false :content text}))
(defn- snapshot [ctx]
  (let [s (kernel/require-service ctx :session/store)] {:events ((:events s)) :messages ((:messages s))}))

(deftest repairs-partial-batch-from-durable-facts
  (let [dir (fs/create-temp-dir {:prefix "qi-tool-repair-"}) path (str (fs/path dir "s.jsonl"))
        stable (atom nil)]
    (try
      (seed! path ["a" "b" "c" "d"] true
             (fn [append! scope]
               (append! "tool/result" (result-data scope "a" "a-result"))
               (append! "message" (assoc scope :call-id "a" :message {:role "tool" :tool_call_id "a" :content "a-result"}))
               (append! "tool/result" (assoc (result-data scope "b" "b-result") :images [{:mime-type "image/png" :data "synthetic"}]))
               (append! "tool/start" (assoc scope :call-id "c"))))
      (let [prefix (slurp path)]
        (dotimes [_ 3]
          (let [ctx (restored path)]
            (try
              (let [{:keys [events messages]} (snapshot ctx)
                    results (filter #(= "tool/result" (:type %)) events)
                    data (into {} (map (juxt #(get-in % [:data :call-id]) :data) results))]
                (is (= ["a" "b" "c" "d"] (mapv :tool_call_id (filter #(= "tool" (:role %)) messages))))
                (is (= 4 (count results)))
                (is (= "b-result" (:content (get messages 3))))
                (is (= [{:mime-type "image/png" :data "synthetic"}] (:images (get messages 3))))
                (is (= "unknown" (some-> (get-in data ["c" :details :execution-state]) name)))
                (is (= "not-started" (some-> (get-in data ["d" :details :execution-state]) name)))
                (is (true? (get-in data ["c" :details :uncertain])))
                (is (= 1 (count (filter #(= "agent/run/end" (:type %)) events))))
                (if @stable (is (= @stable (count events))) (reset! stable (count events)))
                (is (str/starts-with? (slurp path) prefix)))
              (finally (kernel/dispose-all! ctx))))))
      (finally (fs/delete-tree dir)))))

(deftest only-a-clean-versioned-dispatch-log-proves-not-started
  (doseq [[version? corrupt? expected] [[false false "unknown"] [true false "not-started"] [true true "unknown"]]]
    (let [dir (fs/create-temp-dir {:prefix "qi-tool-evidence-"}) path (str (fs/path dir "s.jsonl"))]
      (try
        (seed! path ["a"] version? (fn [_ _]))
        (when corrupt? (spit path "{broken\n" :append true))
        (let [ctx (restored path)]
          (try
            (let [result (first (filter #(= "tool/result" (:type %)) (:events (snapshot ctx))))]
              (is (= expected (some-> (get-in result [:data :details :execution-state]) name))))
            (finally (kernel/dispose-all! ctx))))
        (finally (fs/delete-tree dir))))))

(deftest repair-survives-write-success-followed-by-lost-acknowledgement
  (doseq [crash-type ["tool/result" "message"]]
    (let [dir (fs/create-temp-dir {:prefix "qi-repair-crash-"}) path (str (fs/path dir "s.jsonl"))
          original @#'runtime/record! crashed (atom false)]
      (try
        (seed! path ["a" "b"] true (fn [_ _]))
        (with-redefs-fn {#'runtime/record!
                        (fn [ctx type data]
                          (let [event (original ctx type data)]
                            (when (and (= crash-type type) (compare-and-set! crashed false true))
                              (throw (ex-info "Synthetic acknowledgement lost after durable append" {})))
                            event))}
          #(is (thrown? clojure.lang.ExceptionInfo (restored path))))
        (is @crashed)
        (dotimes [_ 2]
          (let [ctx (restored path)]
            (try
              (let [{:keys [events messages]} (snapshot ctx)]
                (is (= ["a" "b"] (mapv :tool_call_id (filter #(= "tool" (:role %)) messages))))
                (is (= 2 (count (filter #(= "tool/result" (:type %)) events))))
                (is (= 1 (count (filter #(= "agent/run/end" (:type %)) events)))))
              (finally (kernel/dispose-all! ctx)))))
        (finally (fs/delete-tree dir))))))

(deftest prior-step-results-do-not-satisfy-a-reused-call-id
  (let [dir (fs/create-temp-dir {:prefix "qi-repair-scope-"}) path (str (fs/path dir "s.jsonl"))]
    (try
      (seed! path ["same"] true
             (fn [append! scope]
               (append! "tool/result" (result-data scope "same" "old-result"))
               (append! "message" (assoc scope :message {:role "tool" :tool_call_id "same" :content "old-result"}))
               (append! "step/end" {:step 1})
               (append! "step/start" {:step 2})
               (append! "message" {:message {:role "assistant" :tool_calls [(call "same")]}
                                   :session_id (:session_id scope) :run-id "interrupted" :step 2
                                   :tool-dispatch-version 1})))
      (let [ctx (restored path)]
        (try
          (let [messages (:messages (snapshot ctx))]
            (is (= "old-result" (:content (nth messages 2))))
            (is (not= "old-result" (:content (last messages))))
            (is (= "tool" (:role (last messages)))))
          (finally (kernel/dispose-all! ctx))))
      (finally (fs/delete-tree dir)))))

(deftest closed-or-non-tail-dangling-history-is-not-rewritten
  (doseq [tail [:closed :non-prefix :later-user]]
    (let [dir (fs/create-temp-dir {:prefix "qi-repair-ambiguous-"}) path (str (fs/path dir "s.jsonl"))]
      (try
        (seed! path ["a" "b"] true
               (fn [append! scope]
                 (case tail
                   :closed (append! "agent/run/end" {:run-id "interrupted" :status :failed})
                   :non-prefix (append! "message" (assoc scope :message {:role "tool" :tool_call_id "b" :content "later-result"}))
                   :later-user (append! "message" {:message {:role "user" :content "unrelated later instruction"}}))))
        (let [before (slurp path)]
          (is (thrown? clojure.lang.ExceptionInfo (restored path)))
          (is (= before (slurp path))))
        (finally (fs/delete-tree dir))))))

(deftest dispatch-start-is-durable-and-persistence-failure-does-not-dispatch-or-hang
  (doseq [fail-start? [false true]]
    (let [dir (fs/create-temp-dir {:prefix "qi-start-barrier-"}) path (str (fs/path dir "s.jsonl"))
          actions (atom 0) original @#'runtime/record!
          ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}
                                      {:ns 'qi.plugins.mock :config {:responses
                                        [{:message {:role "assistant" :tool_calls [(call "a")]}
                                          :finish-reason "tool_calls"}
                                         {:message {:role "assistant" :content "done"} :finish-reason "stop"}]}}
                                      {:ns 'qi.plugins.runtime}]})]
      (try
        (kernel/register-tool! (kernel/plugin-context ctx :fixture/probe)
                               {:name "probe" :description "Synthetic effect counter." :parameters {:type "object"}
                                :execute (fn [_ _]
                                           (is (some #(= "tool/start" (:type %)) (:events (snapshot ctx))))
                                           (is (str/includes? (slurp path) "tool/start"))
                                           (swap! actions inc) "done")})
        (with-redefs-fn {#'runtime/record! (fn [ctx type data]
                                          (if (and fail-start? (= "tool/start" type))
                                            (throw (ex-info "Synthetic dispatch persistence failure" {}))
                                            (original ctx type data)))}
          #(let [task (future ((kernel/require-service ctx :agent/run) "fixture"))]
             (is (not= ::timeout (deref task 3000 ::timeout)))))
        (is (= (if fail-start? 0 1) @actions))
        (when-not fail-start?
          (let [events (:events (snapshot ctx))
                relevant (filter #(contains? #{"tool/call" "tool/start" "tool/result"} (:type %)) events)]
            (is (= 3 (count relevant)))
            (is (every? #(and (string? (get-in % [:data :session_id]))
                              (string? (get-in % [:data :run-id])) (= 1 (get-in % [:data :step]))
                              (string? (get-in % [:data :assistant-event-id]))) relevant))))
        (finally (kernel/dispose-all! ctx) (fs/delete-tree dir))))))

(deftest malformed-result-ownership-is-rejected-even-for-a-complete-batch
  (doseq [ids [["a"] ["a" "b"]]
          mismatch [{:session_id "foreign"} {:run-id "foreign"} {:step 9}
                    {:assistant-event-id "foreign"} {:call-id "foreign"}]]
    (let [dir (fs/create-temp-dir {:prefix "qi-repair-owner-"}) path (str (fs/path dir "s.jsonl"))]
      (try
        (seed! path ids true
               (fn [append! scope]
                 (append! "message" (merge scope mismatch {:message {:role "tool" :tool_call_id "a" :content "foreign"}}))))
        (let [before (slurp path)]
          (is (thrown? clojure.lang.ExceptionInfo (restored path)))
          (is (= before (slurp path))))
        (finally (fs/delete-tree dir))))))

(deftest evidence-must-follow-its-assistant-and-match-the-tool-name
  (let [base [{:id "s" :seq 1 :type "session/start" :data {:session_id "s"}}
              {:id "r" :seq 2 :type "agent/run/start" :data {:run-id "r"}}
              {:id "p" :seq 3 :type "step/start" :data {:step 1}}]
        assistant {:id "a" :seq 5 :type "message" :data {:message {:role "assistant" :tool_calls [(call "a")]}}}]
    (doseq [type ["tool/start" "tool/result"]]
      (is (thrown? clojure.lang.ExceptionInfo
                   (recovery/recovery-plan
                    (into base [{:id "bad" :seq 4 :type type :data {:call-id "a" :content "unrelated"}} assistant])
                    {:session-id "s"}))))
    (is (thrown? clojure.lang.ExceptionInfo
                 (recovery/recovery-plan
                  (into base [assistant {:id "bad" :seq 6 :type "tool/result" :data {:call-id "a" :name "another-tool" :content "unrelated"}}])
                  {:session-id "s"})))))

(deftest forked-session-run-id-collisions-do-not-close-the-child-run
  (let [dir (fs/create-temp-dir {:prefix "qi-repair-fork-"}) path (str (fs/path dir "s.jsonl"))]
    (try
      (seed! path ["same"] true
             (fn [append! scope]
               (append! "tool/result" (result-data scope "same" "parent-result"))
               (append! "message" (assoc scope :message {:role "tool" :tool_call_id "same" :content "parent-result"}))
               (append! "agent/run/end" {:run-id "interrupted" :status "completed"})
               (append! "session/fork" {:session_id "child"})
               (append! "agent/run/start" {:run-id "interrupted"})
               (append! "step/start" {:step 1})
               (append! "message" {:message {:role "assistant" :tool_calls [(call "same")]}
                                   :session_id "child" :run-id "interrupted" :step 1 :tool-dispatch-version 1})))
      (dotimes [_ 2]
        (let [ctx (restored path)]
          (try
            (let [{:keys [events messages]} (snapshot ctx)]
              (is (= 2 (count (filter #(= "agent/run/end" (:type %)) events))))
              (is (= "parent-result" (:content (nth messages 2))))
              (is (str/includes? (:content (last messages)) "not dispatched")))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree dir)))))

(deftest compaction-preserves-provable-tail-provenance-and-clear-does-not-resurrect-calls
  (doseq [clear? [false true]]
    (let [dir (fs/create-temp-dir {:prefix "qi-repair-checkpoint-"}) path (str (fs/path dir "s.jsonl"))]
      (try
        (seed! path ["a" "b"] true
               (fn [append! scope]
                 (append! "message" (assoc scope :message {:role "tool" :tool_call_id "a" :content "done"}))
                 (if clear?
                   (append! "session/clear" {})
                   (append! "session/compaction"
                            {:replacement_messages [{:role "assistant" :content "older summary"}
                                                    {:role "assistant" :tool_calls [(call "a") (call "b")]}
                                                    {:role "tool" :tool_call_id "a" :content "done"}]}))))
        (let [ctx (restored path)]
          (try
            (is (= (if clear? [] ["a" "b"])
                   (mapv :tool_call_id (filter #(= "tool" (:role %)) (:messages (snapshot ctx))))))
            (finally (kernel/dispose-all! ctx))))
        (finally (fs/delete-tree dir))))))

(deftest actual-process-interruption-does-not-replay-an-effect-after-reopen
  (let [dir (fs/create-temp-dir {:prefix "qi-effect-crash-"})
        path (str (fs/path dir "s.jsonl")) effect (str (fs/path dir "effect.txt"))
        observed (atom nil)]
    (try
      (let [child (process/shell {:out :string :err :string :continue true}
                                "bb"
                                (str "-Duser.home=" dir) "-cp" "src:plugins:test"
                                "test/fixtures/tool-crash.clj" path effect)]
        (is (= 73 (:exit child)) (:err child))
        (is (= "effect\n" (slurp effect)))
        (is (str/includes? (slurp path) "tool/start"))
        (is (not (str/includes? (slurp path) "tool/result"))))
      (dotimes [index 2]
        (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}
                                          {:ns 'qi.plugins.mock :config {:generate (fn [request]
                                            (reset! observed request)
                                            {:message {:role "assistant" :content "inspected"} :finish-reason "stop"})}}]})]
          (try
            ;; Install an executable probe before recovery so replay would be observable.
            (kernel/register-tool! (kernel/plugin-context ctx :fixture/probe)
                                   {:name "probe" :description "Effect fixture" :parameters {:type "object"}
                                    :execute (fn [_ _] (spit effect "replayed\n" :append true) "replayed")})
            (plugin/load-plugin! ctx {:ns 'qi.plugins.runtime})
            (is (= "effect\n" (slurp effect)))
            (let [s (snapshot ctx)]
              (is (= 1 (count (filter #(= "tool/result" (:type %)) (:events s)))))
              (when (zero? index)
                (is (str/includes? (:content (last (:messages s))) "unknown"))
                ((kernel/require-service ctx :agent/run) "Inspect state; do not repeat the action.")
                (is (= ["user" "assistant" "tool" "user"] (mapv :role (:messages @observed))))))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree dir)))))
