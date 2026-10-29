(ns qi.plugin-contract-test
  (:require [clojure.test :refer [deftest is run-tests]]
            [qi.kernel :as k]
            [qi.plugin :as plugin]
            [qi.lifecycle :as lifecycle]
            [qi.tool-contract :as contract]
            [qi.cancellation :as cancellation]))

(defn tool [name body]
  {:name name :description name :parameters {:type "object"}
   :output-schema {:type "object" :required ["ok"]
                   :properties {:ok {:type "boolean"}} :additionalProperties false}
   :execute body})

(deftest stopped-context-cannot-publish-new-resources
  (let [ctx (k/create-context) p (k/plugin-context ctx :oracle/late)]
    (k/register-service! p :oracle/value 1)
    (k/dispose-plugin! ctx :oracle/late)
    (is (false? (try (k/register-service! p :oracle/late-value 2) true
                    (catch Exception _ false))))
    (is (nil? (k/service ctx :oracle/late-value)))))

(deftest registrations-during-shutdown-do-not-leak
  (let [ctx (k/create-context) p (k/plugin-context ctx :oracle/race)
        entered (promise) release (promise) seen (atom [])]
    (k/register-tool! p (tool "old" (fn [_ _] {:ok true})))
    (k/track-effect! p #(do (deliver entered true) (deref release 3000 nil)))
    (let [stop (future (k/dispose-plugin! ctx :oracle/race))]
      (try
        (is (= true (deref entered 3000 :timeout)))
        (let [late (future
                     (try (k/register-service! p :oracle/race-value 42)
                          (k/register-tool! p (tool "late" (fn [_ _] {:ok true})))
                          (k/on! p :oracle/event (fn [_ e] (swap! seen conj e)))
                          :registered
                          (catch Exception _ :rejected)))]
          (deliver release true)
          (is (not= :timeout (deref stop 3000 :timeout)))
          (is (= :rejected (deref late 3000 :timeout)))
          (k/emit! ctx :oracle/event :late)
          (is (nil? (k/service ctx :oracle/race-value)))
          (is (nil? (k/tool ctx "late")))
          (is (empty? @seen)))
        (finally (deliver release true))))))

(deftest dependent-plugins-suspend-and-rebind-on-provider-replacement
  (let [ctx (k/create-context) version (atom 1) starts (atom [])
        descriptors
        {'oracle.provider {:id :oracle/provider :provides #{:oracle/value}
                           :start (fn [p _] (k/register-service! p :oracle/value @version) nil)}
         'oracle.consumer {:id :oracle/consumer :requires #{:oracle/value}
                           :start (fn [p _]
                                    (let [v (k/require-service p :oracle/value)]
                                      (swap! starts conj v)
                                      (k/register-tool! p (tool "dependent" (fn [_ _] {:ok (= v 2)}))))
                                    nil)}}]
    (with-redefs [plugin/resolve-plugin (fn [spec] (get descriptors (:ns spec)))]
      (plugin/load-plugin! ctx {:ns 'oracle.provider})
      (plugin/load-plugin! ctx {:ns 'oracle.consumer})
      (k/dispose-plugin! ctx :oracle/provider)
      (is (nil? (k/tool ctx "dependent")))
      (reset! version 2)
      (plugin/load-plugin! ctx {:ns 'oracle.provider})
      (is (= [1 2] @starts))
      (is (= {:ok true} (when-let [t (k/tool ctx "dependent")] ((:execute t) {} {}))))
      (k/dispose-all! ctx))))

(deftest shutdown-waits-for-asynchronous-cleanup
  (let [ctx (k/create-context) p (k/plugin-context ctx :oracle/async)
        entered (promise) release (promise) finished (atom false)]
    (k/track-effect! p #(future (deliver entered true) @release (reset! finished true)))
    (let [stop (future (k/dispose-plugin! ctx :oracle/async))]
      (try
        (is (= true (deref entered 3000 :timeout)))
        (is (= :waiting (deref stop 100 :waiting)))
        (deliver release true)
        (is (not= :timeout (deref stop 3000 :timeout)))
        (is (true? @finished))
        (finally (deliver release true))))))

(defn runtime-context [policy calls]
  (let [ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                        {:ns 'qi.plugins.mock
                         :config {:responses
                                  [{:message {:role "assistant" :content ""
                                              :tool_calls [{:id "call-1" :type "function"
                                                            :function {:name "touch" :arguments "{\"path\":\"approved\"}"}}]}
                                    :finish-reason "tool_calls"}
                                   {:message {:role "assistant" :content "done"} :finish-reason "stop"}]}}
                        {:ns 'qi.plugins.policy :config policy}
                        {:ns 'qi.plugins.runtime :config {:max-steps 3}}]})
        p (k/plugin-context ctx :oracle/extensions)]
    (k/register-tool! p (assoc (tool "touch" (fn [args _] (swap! calls conj args) {:ok true}))
                              :parameters {:type "object" :required ["path"]
                                           :properties {:path {:type "string"}} :additionalProperties false}
                              :approval-target (fn [args] {:path (:path args)})))
    [ctx p]))

(deftest middleware-cannot-turn-policy-denial-into-permission
  (let [calls (atom []) [ctx p] (runtime-context {:deny-tools ["touch"]} calls)]
    (try
      (k/intercept! p :tool/pre-execute -200
                    (fn [_ request next] (assoc (next request) :decision :allow)))
      ((k/require-service ctx :agent/run) "offline")
      (is (empty? @calls))
      (finally (k/dispose-all! ctx)))))

(deftest approved-arguments-cannot-be-replaced-before-dispatch
  (let [calls (atom []) approvals (atom [])
        [ctx p] (runtime-context {:approval-tools ["touch"]} calls)]
    (try
      (k/register-service! p :approval/request
                           (fn [request]
                             (swap! approvals conj request)
                             (if (= "approved" (get-in request [:arguments :path])) :allow :deny)))
      (k/intercept! p :tool/pre-execute 0
                    (fn [_ request next]
                      (next (assoc-in request [:execution :arguments :path] "changed"))))
      ((k/require-service ctx :agent/run) "offline")
      (is (seq @approvals))
      (is (empty? @calls))
      (finally (k/dispose-all! ctx)))))

(deftest post-hooks-cannot-publish-schema-invalid-success
  (let [calls (atom []) [ctx p] (runtime-context {} calls)]
    (try
      (k/intercept! p :tool/post-execute
                    (fn [_ result next] (next (assoc result :value {:ok "invalid"} :content "false-success"))))
      ((k/require-service ctx :agent/run) "offline")
      (let [events ((:events (k/require-service ctx :session/store)))
            outcome (:data (last (filter #(= "tool/result" (:type %)) events)))
            messages ((:messages (k/require-service ctx :session/store)))]
        (is (= 1 (count @calls)))
        (is (true? (:is-error outcome)))
        (is (not-any? #(and (= "tool" (:role %)) (= "false-success" (:content %))) messages)))
      (finally (k/dispose-all! ctx)))))


(defn error-facts! [ctx ends]
  (let [store (k/require-service ctx :session/store)
        results (filter #(= "tool/result" (:type %)) ((:events store)))
        messages (filter #(= "tool" (:role %)) ((:messages store)))]
    (is (= 1 (count results)))
    (is (= 1 (count messages)))
    (is (= 1 (count @ends)))
    (is (= "call-1" (get-in (first results) [:data :call-id])))
    (is (true? (get-in (first results) [:data :is-error])))
    (is (true? (:is-error (first messages))))
    (is (= "call-1" (:tool_call_id (first messages))))
    (is (= "call-1" (:call-id (first @ends))))
    (is (= (get-in (first results) [:data :execution-id]) (:execution-id (first @ends))))
    (is (= :error (:status (first @ends))))))

(deftest each-registration-rejects-a-retired-context-and-compensates-external-effects
  (let [ctx (k/create-context) p (k/plugin-context ctx :late)
        cleanup (atom 0) callbacks (atom 0)
        attempts [#(k/register-service! p :late/service 1)
                  #(k/register-tool! p (tool "late" (fn [_ _] {:ok true})))
                  #(k/register-command! p {:name "late" :description "late" :execute (fn [_ _] true)})
                  #(k/on! p :late (fn [_ _] (swap! callbacks inc)))
                  #(k/intercept! p :late (fn [_ v next] (swap! callbacks inc) (next v)))
                  #(k/track-effect! p (fn [] (swap! cleanup inc)))]]
    (k/track-effect! p #(doseq [attempt attempts]
                         (is (thrown? Exception (attempt)))))
    (is (= :complete (:status (k/dispose-plugin! ctx :late))))
    (is (= 1 @cleanup))
    (k/emit! ctx :late nil)
    (is (nil? (k/waterfall ctx :late nil identity)))
    (is (zero? @callbacks))
    (is (nil? (k/tool ctx "late")))
    (is (nil? (k/command ctx "late")))
    (let [fresh (k/begin-plugin! ctx :late {:phase :active})]
      (k/register-service! fresh :late/service 2)
      (is (= 2 (k/service ctx :late/service)))
      (is (thrown? Exception (k/register-service! p :late/stale 3))))
    (k/dispose-all! ctx)))

(deftest stop-signal-precedes-drain-and-timeout-does-not-claim-cleanup
  (let [ctx (k/create-context) p (k/plugin-context ctx :busy)
        entered (promise) release (promise) signalled (promise) cleaned (atom false)]
    (k/register-service! p :busy #(do (deliver entered true) @release :done))
    (k/track-stop! p #(deliver signalled true))
    (k/track-effect! p #(reset! cleaned true))
    (let [run (future ((k/require-service ctx :busy)))]
      (is (= true (deref entered 1000 :timeout)))
      (is (= :timeout (:status (k/dispose-plugin! ctx :busy {:timeout-ms 30}))))
      (is (= true (deref signalled 1000 :timeout)))
      (is (false? @cleaned))
      (is (nil? (k/service ctx :busy)))
      (is (thrown? Exception (k/begin-plugin! ctx :busy {})))
      (deliver release true)
      (is (= :done (deref run 1000 :timeout)))
      (is (= :complete (:status (deref (:completion (lifecycle/instance p)) 1000 {}))))
      (is (true? @cleaned))))
  (let [ctx (k/create-context) p (k/plugin-context ctx :broken)]
    (k/track-effect! p #(throw (ex-info "cleanup failed" {})))
    (let [receipt (k/dispose-plugin! ctx :broken)]
      (is (= :failed (:status receipt)))
      (is (= ["cleanup failed"] (:errors receipt)))
      (is (thrown? Exception (k/begin-plugin! ctx :broken {}))))))

(deftest startup-disposer-joins-the-old-generation-drain-barrier
  (let [ctx (k/create-context) entered (promise) release-start (promise)
        cleaning (promise) release-cleanup (promise)
        descriptor {:id :starting
                    :start (fn [_ _] (deliver entered true) @release-start
                             (fn [] (future (deliver cleaning true) @release-cleanup)))}]
    (with-redefs [plugin/resolve-plugin (constantly descriptor)]
      (let [start (future (try (plugin/load-plugin! ctx {:ns 'starting})
                              (catch Exception _ :stopped)))]
        (is (= true (deref entered 1000 :timeout)))
        (is (= :timeout (:status (k/dispose-plugin! ctx :starting {:timeout-ms 30}))))
        (deliver release-start true)
        (is (= true (deref cleaning 1000 :timeout)))
        (is (= :stopping (get-in @(:state ctx) [:instances :starting :phase])))
        (is (thrown? Exception (k/begin-plugin! ctx :starting {})))
        (deliver release-cleanup true)
        (is (= :stopped (deref start 1000 :timeout)))
        (is (= :complete (get-in @(:state ctx) [:instances :starting :receipt :status])))))))

(deftest nested-call-uses-its-own-service-generation
  (let [ctx (k/create-context) p (k/plugin-context ctx :provider)
        remove-old (k/register-service! p :provider/value (constantly :old))
        old-bindings (lifecycle/bindings @(:state ctx) #{:provider/value})
        c (k/begin-plugin! ctx :old-consumer {:requires #{:provider/value} :bindings old-bindings})]
    (k/mark-loaded! c {:id :old-consumer})
    (try
      (k/with-plugin-call c
        (fn []
          (remove-old)
          (k/register-service! p :provider/value (constantly :new))
          (is (thrown? Exception (k/begin-plugin! ctx :stale {:requires #{:provider/value} :bindings old-bindings})))
          (let [d (k/begin-plugin! ctx :new-consumer {:requires #{:provider/value}
                                                     :bindings (lifecycle/bindings @(:state ctx) #{:provider/value})})]
            (k/register-service! d :new-consumer/read #((k/require-service d :provider/value)))
            (k/mark-loaded! d {:id :new-consumer})
            (is (= :new ((k/require-service ctx :new-consumer/read))))
            (is (= :old ((k/require-service c :provider/value)))))))
      (finally (k/dispose-all! ctx)))))

(deftest dependent-cleanup-keeps-provider-alive-through-a-three-level-chain
  (let [ctx (k/create-context) cleaned (atom [])
        p (k/plugin-context ctx :provider)
        _ (k/register-service! p :provider/value (constantly :value))
        make-consumer (fn [id required provided]
                        (let [c (k/begin-plugin! ctx id {:requires #{required}
                                                        :bindings (lifecycle/bindings @(:state ctx) #{required})})]
                          (k/register-service! c provided #((k/require-service c required)))
                          (k/track-effect! c #(swap! cleaned conj [id ((k/require-service c required))]))
                          (k/mark-loaded! c {:id id}) c))
        _ (make-consumer :middle :provider/value :middle/value)
        _ (make-consumer :last :middle/value :last/value)]
    (k/track-effect! p #(swap! cleaned conj [:provider :done]))
    (is (= :complete (:status (k/dispose-plugin! ctx :provider))))
    (is (= [[:last :value] [:middle :value] [:provider :done]] @cleaned))
    (is (empty? (k/service-keys ctx)))))

(deftest identity-changes-and-swallowed-boundary-errors-publish-one-error
  (doseq [[event change] [[:tool/pre-execute #(assoc-in % [:execution :token] "other")]
                          [:tool/pre-execute #(assoc-in % [:execution :call-id] "other")]
                          [:tool/pre-execute #(assoc-in % [:execution :cancel-token] (cancellation/create-token))]
                          [:tool/execute #(assoc-in % [:execution :arguments :path] "other")]
                          [:tool/execute #(assoc-in % [:tool :execute] (fn [_ _] {:ok true}))]]]
    (let [calls (atom []) ends (atom []) [ctx p] (runtime-context {} calls)]
      (try
        (k/on! p :tool.execution/end (fn [_ data] (swap! ends conj data)))
        (k/intercept! p event (fn [_ request next]
                               (try (next (change request))
                                    (catch Throwable _ {:ok true :value {:ok true}
                                                        :execution (:execution request) :content "fake success"}))))
        ((k/require-service ctx :agent/run) "offline")
        (is (empty? @calls))
        (error-facts! ctx ends)
        (finally (k/dispose-all! ctx))))))

(deftest duplicate-dispatch-does-not-repeat-the-tool-body
  (let [calls (atom []) ends (atom []) [ctx p] (runtime-context {} calls)]
    (try
      (k/on! p :tool.execution/end (fn [_ data] (swap! ends conj data)))
      (k/intercept! p :tool/execute (fn [_ request next]
                                    (let [first-result (next request)]
                                      (try (next request) (catch Throwable _ first-result)))))
      ((k/require-service ctx :agent/run) "offline")
      (is (= 1 (count @calls)))
      (error-facts! ctx ends)
      (finally (k/dispose-all! ctx)))))

(deftest invalid-guard-results-deny-instead-of-abstaining
  (doseq [value [false :allow {} {:decision :allow}]]
    (let [calls (atom []) ends (atom []) [ctx p] (runtime-context {} calls)]
      (try
        (k/on! p :tool.execution/end (fn [_ data] (swap! ends conj data)))
        (k/register-tool-guard! p (fn [_ _] value))
        ((k/require-service ctx :agent/run) "offline")
        (is (empty? @calls))
        (error-facts! ctx ends)
        (finally (k/dispose-all! ctx))))))

(deftest canonical-validation-precedes-render-and-runs-after-post-hooks
  (doseq [stage [:body :post]]
    (let [calls (atom []) renders (atom 0) ends (atom []) [ctx p] (runtime-context {} calls)]
      (try
        (k/on! p :tool.execution/end (fn [_ data] (swap! ends conj data)))
        (if (= :post stage)
          (k/intercept! p :tool/post-execute
                        (fn [_ result next] (next (assoc result :value {:ok "bad"} :content "fake success"))))
          (let [t (get-in @(:state ctx) [:tools "touch" :definition])]
            (swap! (:state ctx) assoc-in [:tools "touch" :definition]
                   (assoc t :execute (fn [_ _] {:ok "bad"})
                            :result-details (fn [_ _] (swap! renders inc))
                            :render (fn [_ _] (swap! renders inc) "fake success")))))
        ((k/require-service ctx :agent/run) "offline")
        (when (= :body stage) (is (zero? @renders)))
        (error-facts! ctx ends)
        (finally (k/dispose-all! ctx))))))

(deftest retired-tool-or-guard-cannot-use-a-prepared-invocation
  (doseq [retire [:tool :guard :policy]]
    (let [calls (atom []) [ctx p] (runtime-context {} calls)
          request (contract/prepare! ctx {:tool (k/tool ctx "touch")
                                          :execution {:name "touch" :arguments {:path "approved"} :token "bound"}})]
      (try
        (case retire
          :tool (k/dispose-plugin! ctx (:plugin/id p))
          :policy (k/dispose-plugin! ctx :policy/tool-gate)
          :guard (k/register-tool-guard! p (fn [_ _] nil)))
        (is (thrown? Exception (contract/dispatch! ctx request (fn [_] (swap! calls conj :ran)))))
        (is (empty? @calls))
        (finally (contract/release! request) (k/dispose-all! ctx))))))

(deftest canonical-data-rejects-opaque-and-ambiguous-values
  (doseq [value [(atom 1) (java.util.concurrent.atomic.AtomicLong. 1) (fn [] true) Double/NaN Double/POSITIVE_INFINITY
                 {:a 1 "a" 2} {:a/x 1 "a/x" 2} {1 "key"} (range)]]
    (is (thrown? Exception (contract/canonical-data! value))))
  (is (nil? (contract/canonical! {:output-schema {:type "null"}} nil)))
  (is (= {:status :done :items [1 nil true]} (contract/canonical-data! {:status :done :items [1 nil true]}))))

(deftest canonical-keys-preserve-namespaces-and-arbitrary-precision-json-numbers
  (is (= {:a/x 1 :b/x 2} (contract/canonical-data! {:a/x 1 :b/x 2})))
  (is (= 1E1000M (contract/canonical-data! 1E1000M))))

(deftest middleware-cannot-forge-success-or-launder-an-error-through-nil
  (doseq [mode [:no-body :blocked-success :blocked-post :nil-status :opaque-error]]
    (let [calls (atom []) ends (atom []) [ctx p] (runtime-context {} calls)]
      (try
        (k/on! p :tool.execution/end (fn [_ data] (swap! ends conj data)))
        (when-not (contains? #{:no-body :blocked-success :blocked-post} mode)
          (swap! (:state ctx) assoc-in [:tools "touch" :definition :execute]
                 (fn [args _] (swap! calls conj args) (throw (ex-info "real body failed" {})))))
        (case mode
          :no-body (k/intercept! p :tool/execute
                     (fn [_ request _] {:ok true :value {:ok true} :execution (:execution request) :content "fake success"}))
          :blocked-success (k/intercept! p :tool/execute
                     (fn [_ request _] {:ok true :blocked true :value {:ok true} :execution (:execution request) :content "fake success"}))
          :blocked-post (do
                          (k/intercept! p :tool/execute (fn [_ request _] {:blocked true :execution (:execution request)}))
                          (k/intercept! p :tool/post-execute
                            (fn [_ result next] (next (assoc result :blocked false :ok true :value {:ok true} :content "fake success")))))
          :nil-status (do
                        (k/intercept! p :tool/execute
                          (fn [_ request next] (assoc (dissoc (next request) :is-error :cancelled) :ok nil)))
                        (k/intercept! p :tool/post-execute
                          (fn [_ result next] (next (assoc result :ok true :value {:ok true} :content "fake success")))))
          :opaque-error (k/intercept! p :tool/post-execute
                          (fn [_ result next] (next (assoc result :value (fn [] :unsafe))))))
        ((k/require-service ctx :agent/run) "offline")
        (is (= (if (contains? #{:no-body :blocked-success :blocked-post} mode) 0 1) (count @calls)))
        (error-facts! ctx ends)
        (is (nil? (:value (first @ends))))
        (finally (k/dispose-all! ctx))))))

(deftest runtime-inspection-remains-canonical-for-every-public-view
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.runtime-inspect}]})
        t (k/tool ctx "runtime_inspect")]
    (try
      (doseq [action ["summary" "plugins" "services" "tools" "commands" "hooks"]]
        (is (map? (contract/canonical! t ((:execute t) {:action action} {})))))
      (finally (k/dispose-all! ctx)))))

(deftest explicit-disable-cancels-an-already-selected-automatic-restart
  (let [ctx (k/create-context) selected (promise) resume (promise)
        begin lifecycle/begin!
        descriptors {'provider {:id :p :provides #{:v} :start (fn [p _] (k/register-service! p :v 1) nil)}
                     'consumer {:id :c :requires #{:v} :start (fn [p _] (k/register-tool! p (tool "dependent" (fn [_ _] {:ok true}))) nil)}}]
    (with-redefs [plugin/resolve-plugin #(get descriptors (:ns %))]
      (plugin/load-plugin! ctx {:ns 'provider})
      (plugin/load-plugin! ctx {:ns 'consumer})
      (k/dispose-plugin! ctx :p)
      (with-redefs [lifecycle/begin! (fn [ctx id options]
                                      (when (:resume-generation options) (deliver selected true) @resume)
                                      (begin ctx id options))]
        (let [reload (future (plugin/load-plugin! ctx {:ns 'provider}))]
          (try
            (is (= true (deref selected 1000 :timeout)))
            (k/dispose-plugin! ctx :c)
            (deliver resume true)
            (is (not= :timeout (deref reload 1000 :timeout)))
            (is (= {:generation 1 :phase :stopped :desired? false}
                   (select-keys (get-in @(:state ctx) [:instances :c]) [:generation :phase :desired?])))
            (is (nil? (k/tool ctx "dependent")))
            (finally (deliver resume true) (k/dispose-all! ctx))))))))

(deftest approval-and-output-use-immutable-snapshots
  (let [ctx (k/create-context) p (k/plugin-context ctx :snapshot)
        source (object-array [1])
        t {:name "snapshot" :description "snapshot" :parameters {:type "object"}
           :execute (fn [args _] args)}
        request (contract/prepare! p {:tool t :execution {:name "snapshot" :token "snapshot" :arguments {:values (seq source)}}})]
    (aset source 0 999)
    (is (= {:values [1]} (contract/dispatch! p request (fn [r] ((get-in r [:tool :execute]) (get-in r [:execution :arguments]) (:execution r))))))
    (let [returned (object-array [1]) value (contract/canonical! t {:values (seq returned)})]
      (aset returned 0 999)
      (is (= {:values [1]} value)))
    (k/dispose-all! ctx)))

(deftest schema-uses-the-same-namespaced-keys-as-json
  (let [t {:output-schema {:type "object" :properties {:x/a {:type "string"}}
                           :required ["x/a"] :additionalProperties false}}]
    (is (= {:x/a "text"} (contract/canonical! t {:x/a "text"})))
    (is (thrown? Exception (contract/canonical! t {:x/a 123})))
    (is (thrown? Exception (contract/canonical! t {:y/a "text"})))))

(deftest shutdown-signals-all-plugins-before-waiting-for-any-one-of-them
  (let [ctx (k/create-context) caller (k/plugin-context ctx :caller)
        provider (k/plugin-context ctx :provider)
        entered (promise) release (promise)]
    (k/register-service! caller :blocking #(do (deliver entered true) @release :done))
    (k/track-stop! provider #(deliver release true))
    (let [run (future ((k/require-service ctx :blocking)))]
      (is (= true (deref entered 1000 :timeout)))
      (let [stopped (future (k/dispose-all! ctx))]
        (try
          (is (= :complete (:status (deref stopped 1500 {}))))
          (is (= :done (deref run 1000 :timeout)))
          (finally (deliver release true)))))))

(deftest shutdown-from-an-admitted-call-does-not-wait-on-itself
  (let [ctx (k/create-context) p (k/plugin-context ctx :self)]
    (k/register-service! p :stop #(k/dispose-all! ctx))
    (let [result (deref (future ((k/require-service ctx :stop))) 1000 {})]
      (is (= :incomplete (:status result)))
      (is (= :pending (get-in result [:plugins 0 :status])))
      (is (= :complete (:status (deref (:completion (lifecycle/instance p)) 1000 {})))))))
