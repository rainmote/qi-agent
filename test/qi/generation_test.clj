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

(deftest accounting-write-failure-prevents-request-admission
  (let [ctx (kernel/plugin-context (kernel/create-context) :test)
        calls (atom 0)]
    (kernel/register-service! ctx :llm/generate (fn [_] (swap! calls inc)))
    (kernel/register-service! ctx :session/store {:append! (fn [& _] (throw (ex-info "disk full" {})))})
    (let [error (try (generation/generate! ctx {} {:purpose :main}) (catch Exception error error))]
      (is (= :usage_persistence_failed (:code (ex-data error))))
      (is (false? (:retryable (ex-data error))))
      (is (zero? @calls)))))
