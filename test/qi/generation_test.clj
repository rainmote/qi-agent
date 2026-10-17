(ns qi.generation-test
  (:require [clojure.test :refer [deftest is]]
            [qi.generation :as generation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [babashka.fs :as fs]))

(deftest request-ledger-preserves-failures-and-distinguishes-identical-usage
  (let [calls (atom 0)
        ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                        {:ns 'qi.plugins.mock
                         :config {:generate (fn [_]
                                              (if (= 1 (swap! calls inc))
                                                (throw (ex-info "retry" {:usage {:input_tokens 7}}))
                                                {:usage {:input_tokens 7} :message {:role "assistant" :content "ok"}}))}}]})]
    (try
      (try (generation/generate! ctx {} {:purpose :main :attempt 0}) (catch Exception _))
      (generation/generate! ctx {} {:purpose :main :attempt 1})
      (generation/generate! ctx {} {:purpose :compaction})
      (let [records (map :data (filter #(= "usage/request" (:type %))
                                      ((:events (kernel/require-service ctx :session/store)))))
            terminal (remove #(= :started (:status %)) records)]
        (is (= 6 (count records)))
        (is (= 3 (count (set (map :request_id records)))))
        (is (= [:failed :completed :completed] (mapv :status terminal)))
        (is (= [:main :main :compaction] (mapv :purpose terminal)))
        (is (= [7 7 7] (mapv #(get-in % [:usage :input_tokens]) terminal)))
        (is (every? #(and (nil? (:cost_usd %)) (false? (:accounting_complete %))) records)))
      (finally (kernel/dispose-all! ctx)))))

(deftest request-summary-includes-failed-and-compaction-usage-and-marks-incomplete-counts
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}]})
        store (kernel/require-service ctx :session/store)]
    (try
      (doseq [data [{:request_id "one" :run-id "r" :status :started}
                    {:request_id "one" :run-id "r" :status :completed :usage {:input_tokens 10 :output_tokens 5}}
                    {:request_id "two" :run-id "r" :purpose :compaction :status :completed :usage {:input_tokens 60 :output_tokens 7}}
                    {:request_id "three" :run-id "r" :status :failed}
                    {:request_id "other" :run-id "other" :status :completed :usage {:input_tokens 999}}]]
        ((:append! store) "usage/request" data))
      (let [summary (generation/request-summary ctx "r")]
        (is (= 3 (:requests summary)))
        (is (= 70 (:known-input-tokens summary)))
        (is (= 12 (:known-output-tokens summary)))
        (is (= 1 (:unknown-requests summary)))
        (is (false? (:token-usage-complete summary)))
        (is (nil? (:total-cost-usd summary))))
      (finally (kernel/dispose-all! ctx)))))

(deftest accounting-write-failure-prevents-request-admission
  (let [ctx (kernel/plugin-context (kernel/create-context) :test)
        calls (atom 0)]
    (kernel/register-service! ctx :llm/generate (fn [_] (swap! calls inc)))
    (kernel/register-service! ctx :session/store {:append! (fn [& _] (throw (ex-info "disk full" {})))})
    (let [error (try (generation/generate! ctx {} {:purpose :main}) (catch Exception error error))]
      (is (= :usage_persistence_failed (:code (ex-data error))))
      (is (false? (:retryable (ex-data error))))
      (is (zero? @calls)))))

(deftest one-budget-covers-main-failure-and-compaction-and-preserves-root-identity
  (let [ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                        {:ns 'qi.plugins.mock :config {:generate (constantly {:message {:role "assistant" :content "ok"}})}}]})]
    (try
      (binding [generation/*run* (generation/run-budget "root-run" {:max-model-requests 2 :max-wall-ms 10000})]
        (generation/generate! ctx {} {:purpose :main})
        (binding [generation/*run* (generation/run-budget "child-run" {})]
          (generation/generate! ctx {} {:purpose :compaction})
          (let [error (try (generation/generate! ctx {} {:purpose :main}) (catch Exception e e))]
            (is (= :request-budget (:reason (ex-data error)))))))
      (let [records (map :data (filter #(= "usage/request" (:type %))
                                      ((:events (kernel/require-service ctx :session/store)))))]
        (is (= 4 (count records)))
        (is (every? #(= "root-run" (:root-run-id %)) records))
        (is (= ["root-run" "root-run" "child-run" "child-run"] (mapv :run-id records))))
      (binding [generation/*run* {:deadline 0}]
        (let [error (try (generation/generate! ctx {} {:purpose :compaction}) (catch Exception e e))]
          (is (= :wall-budget (:reason (ex-data error))))))
      (finally (kernel/dispose-all! ctx)))))


(deftest persistent-root-index-deduplicates-replay-and-excludes-manual-operations
  (let [directory (fs/create-temp-dir {:prefix "qi-root-index-"})
        profile {:plugins [{:ns 'qi.plugins.session :config {:path (str (fs/path directory "parent.jsonl"))}}]}
        ctx (plugin/boot! profile)
        saved (atom nil)]
    (try
      (let [store (kernel/require-service ctx :session/store)
            sid (:session-id store)
            append! (:append! store)
            request {:request_id "parent-request" :run-id "root" :root-run-id "root" :session_id sid
                     :status :completed :usage {:input_tokens 10 :output_tokens 2}}
            child {:request_id "child-request" :run-id "native-child" :root-run-id "root" :session_id "child"
                   :status :completed :usage {:input_tokens 30 :output_tokens 3}}
            child-run {:run-id "native-child" :root-run-id "root" :session_id "child" :agent-id "agent" :status :completed :index-version 1}]
        (generation/record-tree-run! ctx "root" "root" :started)
        (append! "usage/request" request)
        (doseq [data [(assoc child :status :started) child child (assoc child :status :started)]]
          (append! "usage/child-request" data))
        (append! "usage/tree-run" child-run)
        (generation/record-provider! ctx {:root-run-id "root" :id "agent" :run-id "registry-child" :execution-run-id "native-child"} :completed)
        (generation/record-tree-run! ctx "root" "root" :completed)
        (append! "usage/request" {:request_id "independent" :operation-id "manual" :purpose :compaction :status :completed :usage {:input_tokens 999 :output_tokens 1}})
        (let [summary (generation/root-request-summary ctx "root")]
          (reset! saved summary)
          (is (= [40 5 2] ((juxt :known-input-tokens :known-output-tokens :requests) summary)))
          (is (true? (:token-usage-complete summary)))
          (is (= :root-tree (:scope summary)))
          (is (= 2 (count (get-in summary [:coverage :expected-sessions]))))
          (is (= :session-local (:scope (generation/request-summary ctx "root"))))
          (is (= 10 (:known-input-tokens (generation/request-summary ctx "root"))))
          (is (nil? (:total-cost-usd summary)))))
      (kernel/dispose-all! ctx)
      (let [restored (plugin/boot! profile)]
        (try (is (= @saved (generation/root-request-summary restored "root")))
             (finally (kernel/dispose-all! restored))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))

(deftest pending-child-and-opaque-provider-coverage-never-claim-complete
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}]})
        store (kernel/require-service ctx :session/store)
        append! (:append! store)
        sid (:session-id store)]
    (try
      (generation/record-tree-run! ctx "root" "root" :completed)
      (append! "usage/request" {:request_id "p" :run-id "root" :root-run-id "root" :session_id sid :status :completed :usage {:input_tokens 10 :output_tokens 0}})
      (append! "usage/tree-run" {:run-id "child" :root-run-id "root" :session_id "child-session" :status :started})
      (append! "usage/child-request" {:request_id "c" :run-id "child" :root-run-id "root" :session_id "child-session" :status :started})
      (let [summary (generation/root-request-summary ctx "root")]
        (is (= 1 (:unknown-requests summary)))
        (is (= ["child"] (:pending-children summary)))
        (is (false? (:token-usage-complete summary))))
      (append! "usage/child-request" {:request_id "c" :run-id "child" :root-run-id "root" :session_id "child-session" :status :failed :usage {:input_tokens 30 :output_tokens 0}})
      (append! "usage/tree-run" {:run-id "child" :root-run-id "root" :session_id "child-session" :status :failed})
      (is (true? (:token-usage-complete (generation/root-request-summary ctx "root"))))
      (generation/record-provider! ctx {:root-run-id "root" :id "opaque" :run-id "external" :execution-run-id "root" :provider :external-cli} :completed)
      (let [summary (generation/root-request-summary ctx "root")]
        (is (= 40 (:known-input-tokens summary)))
        (is (= ["external"] (:unknown-provider-runs summary)))
        (is (false? (:token-usage-complete summary))))
      (is (= :legacy-unindexed (get-in (generation/root-request-summary ctx "legacy") [:coverage :status])))
      (finally (kernel/dispose-all! ctx)))))

(deftest parent-index-persistence-failure-blocks-child-provider-before-dispatch
  (let [calls (atom 0)
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                                    {:ns 'qi.plugins.mock :config {:generate (fn [_] (swap! calls inc))}}]})]
    (try
      (kernel/register-service! (kernel/plugin-context ctx :test/root-index) :usage/root-target
                                {:context ctx :store {:append! (fn [& _] (throw (ex-info "parent disk full" {})))}})
      (binding [generation/*run* {:run-id "child" :root-run-id "root"}]
        (let [error (try (generation/generate! ctx {} {:purpose :main}) (catch Exception error error))]
          (is (= :usage_persistence_failed (:code (ex-data error))))
          (is (false? (:retryable (ex-data error))))
          (is (zero? @calls))))
      (finally (kernel/dispose-all! ctx)))))

(deftest actual-native-child-requests-are-included-in-the-root-subtotal
  (let [directory (fs/create-temp-dir {:prefix "qi-native-root-"})
        answer (fn [tokens] {:message {:role "assistant" :content "done"} :finish-reason "stop" :usage {:input_tokens tokens :output_tokens 2}})
        holder (atom nil)
        child-profile {:plugins [{:ns 'qi.plugins.session}
                                 {:ns 'qi.plugins.durable-state :config {:root (str directory)}}
                                 {:ns 'qi.plugins.bb-repl :config {:root (str directory) :sandbox :none}}
                                 {:ns 'qi.plugins.mock :config {:generate (constantly (answer 30))}}
                                 {:ns 'qi.plugins.runtime :config {:max-steps 2 :max-retries 0}}]}
        ctx (plugin/boot!
              {:plugins [{:ns 'qi.plugins.session :config {:path (str (fs/path directory "parent.jsonl"))}}
                         {:ns 'qi.plugins.subagent}
                         {:ns 'qi.plugins.subagent-in-process :config {:allowed-tools [] :child-profile child-profile}}
                         {:ns 'qi.plugins.mock :config {:generate (fn [_]
                                                                  (let [registry (kernel/require-service @holder :subagents/runtime)
                                                                        job ((:start! registry) {:provider :spawn :prompt "child" :parent-context @holder})]
                                                                    ((:wait! registry) (:id job) 3000)
                                                                    (answer 10)))}}
                         {:ns 'qi.plugins.runtime :config {:max-steps 2 :max-retries 0}}]})]
    (reset! holder ctx)
    (try
      (let [result ((kernel/require-service ctx :agent/run) "parent")
            local (:request-usage result) tree (:root-request-usage result)]
        (is (= [10 1 :session-local] ((juxt :known-input-tokens :requests :scope) local)))
        (is (= [40 2 :root-tree] ((juxt :known-input-tokens :requests :scope) tree)))
        (is (true? (:token-usage-complete tree)))
        (is (empty? (:pending-children tree))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree directory)))))
