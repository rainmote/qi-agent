(ns qi.mcp-deadline-test
  (:require [babashka.fs :as fs]
            [clojure.test :refer [deftest is]]
            [qi.mcp-stdio :as mcp]))

(deftest late-reply-cannot-win-while-requesting-thread-is-paused
  (let [client (mcp/connect!
                {:command [(str (fs/which "bb")) "-cp" (str (fs/absolutize "test"))
                           "-m" "qi.fake-computer-mcp"]
                 :env {"QI_FAKE_MCP_MODE" "delayed-list" "QI_FAKE_MCP_DELAY_MS" "150"}
                 :startup-timeout-ms 3000 :request-timeout-ms 3000})
        caller (Thread/currentThread)
        armed? (atom true)
        reply-seen (promise)
        original-future clojure.core/future-call
        finish-var (ns-resolve 'qi.mcp-stdio 'finish!)
        original-finish @finish-var]
    (try
      (let [error
            (try
              (with-redefs-fn
                {#'clojure.core/future-call
                 (fn [f]
                   (let [worker (original-future f)]
                     ;; Hold the request caller after its send worker starts,
                     ;; until the reader has arbitrated the delayed response.
                     (when (and (= caller (Thread/currentThread))
                                (compare-and-set! armed? true false))
                       (when-not (deref reply-seen 3000 false)
                         (throw (IllegalStateException. "Regression fixture did not observe a reply"))))
                     worker))
                 finish-var
                 (fn [& args]
                   (let [result (apply original-finish args)]
                     (when (:message (second args)) (deliver reply-seen true))
                     result))}
                #((:request! client) "tools/list" {} {:timeout-ms 30}))
              nil
              (catch clojure.lang.ExceptionInfo error (ex-data error)))]
        (is (= true (deref reply-seen 0 false)) "reader actually arbitrated the delayed reply")
        (is (:timeout error) "the deadline includes the caller's scheduling pause")
        (is (not (:uncertain error)))
        (is ((:alive? client)))
        (is (map? ((:request! client) "tools/call"
                   {:name "click" :arguments {:x 1 :y 2}} {}))))
      (finally ((:close! client))))))

(deftest timely-completion-is-not-replaced-by-a-later-timeout
  (let [response (promise)
        cleanup (atom 0)
        entry {:response response :state (atom {:phase :dispatched :dispatched? true})
               :deadline-ns (+ (System/nanoTime) 10000000000)
               :on-timeout (fn [_] (swap! cleanup inc))}
        finish! @(ns-resolve 'qi.mcp-stdio 'finish!)
        message {:result {:ok true}}]
    (is (true? (finish! entry {:message message})))
    ;; Reading a previously settled promise after its deadline must retain the
    ;; timely outcome, including when a duplicate late reply is observed.
    (is (nil? (finish! (assoc entry :deadline-ns 0) {:message {:result :late}})))
    (is (= {:message message :dispatched? true} @response))
    (is (zero? @cleanup))))
