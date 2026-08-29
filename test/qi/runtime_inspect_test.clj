(ns qi.runtime-inspect-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [clojure.test :refer [deftest is testing]]))

(deftest runtime-inspect-exposes-owned-read-only-runtime-facts
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.runtime-inspect}]})]
    (try
      (let [fixture (kernel/plugin-context ctx :test/fixture)]
        (kernel/register-service! fixture :demo/value {:secret "must-not-leak"})
        (kernel/register-tool!
         fixture
         {:name "demo_tool"
          :description "Fixture tool."
          :parameters {:type "object"}
          :execute (fn [_ _] {:ok true})})
        (kernel/mark-loaded! ctx {:id :test/fixture
                                  :namespace 'qi.runtime-inspect-test
                                  :description "Fixture plugin."})
        (let [tool (kernel/tool ctx "runtime_inspect")
              summary ((:execute tool) {:action "summary"} {})
              services ((:execute tool) {:action "services"} {})
              exact ((:execute tool) {:action "services" :name ":demo/value"} {})]
          (is (= "runtime_inspect" (:name tool)))
          (is (= [":runtime/inspect" ":test/fixture"]
                 (mapv :id (:plugins summary))))
          (is (= ["demo_tool" "runtime_inspect"]
                 (mapv :name (:tools summary))))
          (is (= [{:key ":demo/value" :owner ":test/fixture"}]
                 (:services services)))
          (is (= {:key ":demo/value" :owner ":test/fixture"}
                 (:service exact)))
          (is (not (re-find #"must-not-leak" (pr-str [summary services exact]))))))
      (finally
        (kernel/dispose-all! ctx)))
    (is (nil? (kernel/tool ctx "runtime_inspect")))))

(deftest runtime-inspect-rejects-unknown-actions-and-names
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.runtime-inspect}]})]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_inspect"))]
        (testing "unknown action"
          (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                #"Unsupported runtime inspection action"
                                (execute {:action "mutate"} {}))))
        (testing "unknown exact service"
          (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                #"Runtime service was not found"
                                (execute {:action "services" :name ":missing/service"} {})))))
      (finally
        (kernel/dispose-all! ctx)))))
