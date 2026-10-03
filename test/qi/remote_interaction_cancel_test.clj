(ns qi.remote-interaction-cancel-test
  (:require [clojure.test :refer [deftest is]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

(defn- fixture []
  (plugin/boot! {:plugins [{:ns 'qi.plugins.remote-registry}
                          {:ns 'qi.plugins.remote-interaction :config {:timeout-ms nil}}]}))
(defn- await-empty! [service]
  (loop [tries 100]
    (cond (empty? ((:pending service))) true
          (zero? tries) false
          :else (do (Thread/sleep 10) (recur (dec tries))))))

(deftest cancellation-removes-a-real-remote-prompt-without-a-timeout
  (let [ctx (fixture) token (cancellation/create-token) started (promise) resolved (promise)
        service (kernel/require-service ctx :interaction/remote)
        prompt (kernel/require-service ctx :ui/prompt)
        events (kernel/plugin-context ctx :test/observer)]
    (try
      (kernel/on! events :interaction/request (fn [_ event] (deliver started event)))
      (kernel/on! events :interaction/resolved (fn [_ event] (deliver resolved event)))
      (let [task (future (try ((:select! prompt) {:title "Approve" :default :deny :cancel-token token})
                               (catch Throwable error (ex-data error))))
            request (deref started 1000 nil)]
        (is (some? request))
        (is (= 1 (:revision ((:snapshot service)))))
        (cancellation/cancel! token)
        (is (:cancelled (deref task 1000 {})))
        (is (await-empty! service))
        (is (= 2 (:revision ((:snapshot service)))))
        (is (= :deny (:decision (deref resolved 1000 nil))))
        (is (:cancelled (deref resolved 1000 nil)))
        (is (thrown? clojure.lang.ExceptionInfo ((:resolve! service) (:id request) :allow))))
      (finally (kernel/dispose-all! ctx)))))

(deftest interrupting-the-blocking-rpc-prompt-cleans-pending-state
  (let [ctx (fixture) started (promise) resolved (promise)
        service (kernel/require-service ctx :interaction/remote)
        prompt (kernel/require-service ctx :ui/prompt)
        events (kernel/plugin-context ctx :test/observer)]
    (try
      (kernel/on! events :interaction/request (fn [_ event] (deliver started event)))
      (kernel/on! events :interaction/resolved (fn [_ event] (deliver resolved event)))
      (let [task (future ((:select! prompt) {:title "Approve" :default :deny}))]
        (is (some? (deref started 1000 nil)))
        (future-cancel task)
        (is (await-empty! service))
        (is (= 2 (:revision ((:snapshot service)))))
        (is (= :deny (:decision (deref resolved 1000 nil))))
        (is (:cancelled (deref resolved 1000 nil))))
      (finally (kernel/dispose-all! ctx)))))
