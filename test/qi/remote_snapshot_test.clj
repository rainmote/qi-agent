(ns qi.remote-snapshot-test
  (:require [clojure.test :refer [deftest is]]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.remote-registry]
            [qi.plugins.remote-interaction]))

(defn- interaction-context []
  (plugin/boot!
   {:plugins [{:ns 'qi.plugins.remote-registry}
              {:ns 'qi.plugins.remote-interaction
               :config {:timeout-ms 5000}}]}))

(deftest interaction-snapshot-covers-events-not-yet-delivered
  (let [ctx (interaction-context)
        service (kernel/require-service ctx :interaction/remote)
        prompt (kernel/require-service ctx :ui/prompt)
        requested (promise)
        release-request (promise)
        resolved (promise)]
    (try
      (is (= {:revision 0 :pending []} ((:snapshot service))))
      (kernel/on! (kernel/plugin-context ctx :test/snapshot) :interaction/request
                  (fn [_ data]
                    (deliver requested data)
                    @release-request))
      (kernel/on! (kernel/plugin-context ctx :test/snapshot) :interaction/resolved
                  (fn [_ data] (deliver resolved data)))
      (let [task (future ((:select! prompt) {:message "Test approval"
                                          :default :deny}))
            event (deref requested 2000 ::timeout)]
        (is (map? event) "The prompt reached the controlled event boundary")
        (when (map? event)
          (let [snapshot ((:snapshot service))]
            (is (= (:revision event) (:revision snapshot)))
            (is (= [event] (:pending snapshot)))
            (is (= [event] ((:pending service)))))
          ((:resolve! service) (:id event) :allow)
          (deliver release-request true)
          (is (= :allow (deref task 2000 ::timeout)))
          (let [resolution (deref resolved 2000 ::timeout)
                snapshot ((:snapshot service))]
            (is (= [] (:pending snapshot)))
            (is (= (:revision resolution) (:revision snapshot)))
            (is (> (:revision resolution) (:revision event))))))
      (finally
        (deliver release-request true)
        (kernel/dispose-all! ctx)))))

(deftest concurrent-interactions-have-a-consistent-snapshot-watermark
  (let [ctx (interaction-context)
        service (kernel/require-service ctx :interaction/remote)
        prompt (kernel/require-service ctx :ui/prompt)
        events (atom [])
        both-requested (promise)]
    (try
      (kernel/on! (kernel/plugin-context ctx :test/snapshot) :interaction/request
                  (fn [_ event]
                    (let [all (swap! events conj event)]
                      (when (= 2 (count all))
                        (deliver both-requested all)))))
      (let [tasks (mapv (fn [message]
                          (future ((:select! prompt) {:message message :default :deny})))
                        ["First" "Second"])
            requests (deref both-requested 2000 ::timeout)]
        (is (vector? requests))
        (when (vector? requests)
          (let [snapshot ((:snapshot service))]
            (is (= 2 (:revision snapshot)))
            (is (= #{1 2} (set (map :revision (:pending snapshot)))))
            (is (= (set (map :id requests))
                   (set (map :id (:pending snapshot)))))))
        (doseq [entry ((:pending service))]
          ((:resolve! service) (:id entry) :deny))
        (doseq [task tasks]
          (is (= :deny (deref task 2000 ::timeout)))))
      (is (= {:revision 4 :pending []} ((:snapshot service))))
      (finally
        (kernel/dispose-all! ctx)))))
