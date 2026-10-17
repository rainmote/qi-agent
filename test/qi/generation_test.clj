(ns qi.generation-test
  (:require [clojure.test :refer [deftest is]]
            [qi.generation :as generation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

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
