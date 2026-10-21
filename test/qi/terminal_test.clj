(ns qi.terminal-test
  (:require [clojure.test :refer [deftest is]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.terminal-process :as transport]
            [qi.plugins.workspace-tools :as workspace]))

(defn fixture [options]
  (let [ctx (kernel/create-context) owner (kernel/plugin-context ctx :test/terminal)
        trusted (atom (get options :trusted true)) calls (atom []) closed (promise)
        factory (fn []
                  (let [state (atom {:status "cold" :cleanup_confirmed true})]
                    {:status #(deref state)
                     :start! (fn [admit! _ _] (admit! 98765) (swap! calls conj :open) (reset! state {:status "running" :cleanup_confirmed false}))
                     :request! (fn [args] (swap! calls conj args) (merge @state (when (= "read" (:op args)) {:output "fixture" :cursor 7})))
                     :close! (fn [] (swap! calls conj :close) (deliver closed true) (reset! state {:status "closed" :cleanup_confirmed true}))}))]
    (kernel/register-service! owner :execution/world {:provider :test :sandbox :seatbelt :terminal-controller factory
                                                     :workspace-runtime {:available? true :python-version "fixture"}})
    (kernel/register-service! owner :project/trust {:trusted? #(deref trusted)})
    (kernel/register-service! owner :approval/request (or (:approve options) (constantly :allow)))
    (kernel/register-service! owner :execution/process-admission {:admit! #(swap! calls conj [:admit %])})
    (kernel/mark-loaded! ctx {:id :test/terminal})
    (plugin/load-all! ctx [{:ns 'qi.plugins.remote-registry}
                           {:ns 'qi.plugins.policy :config (:policy options {})}
                           {:ns 'qi.plugins.terminal}])
    {:ctx ctx :trusted trusted :calls calls :closed closed
     :rpc (fn [method params] ((:invoke! (kernel/service ctx :remote/registry)) method params))}))

(deftest terminal-inherits-bash-deny-and-project-trust-before-any-admission
  (doseq [options [{:policy {:deny-tools ["bash"]}} {:policy {:deny-tools ["terminal"]}} {:trusted false}]]
    (let [{:keys [ctx calls rpc]} (fixture options)]
      (try (is (thrown? Exception (rpc "terminal.execute" {:action "open"})))
           (is (empty? @calls))
           (finally (kernel/dispose-all! ctx))))))

(deftest terminal-rpc-uses-approval-and-the-execution-boundary-with-session-ownership
  (let [approvals (atom []) {:keys [ctx calls rpc]} (fixture {:approve #(do (swap! approvals conj %) :allow)})]
    (try
      (let [opened (rpc "terminal.execute" {:action "open"}) id (:terminal_id opened)]
        (is (= [:admit 98765] (first @calls)))
        (is (= "terminal" (:name (first @approvals))))
        (is (= "running" (:status opened)))
        (is (= "fixture" (:output (rpc "terminal.read" {:terminal_id id :since 0}))))
        (is (= 1 (count @approvals)))
        (is (thrown? Exception (rpc "terminal.read" {:terminal_id "foreign-session-terminal"})))
        (let [owner (kernel/plugin-context ctx :test/plan)]
          (kernel/intercept! owner :tool/execute -1000 (fn [_ _ _] {:blocked true}))
          (is (:blocked (rpc "terminal.execute" {:action "input" :terminal_id id :text "fixture\n"})))
          (is (not-any? #(= "input" (:op %)) (filter map? @calls))))
        (is (:cleanup_confirmed (rpc "terminal.stop" {:terminal_id id}))))
      (finally (kernel/dispose-all! ctx)))))

(deftest user-cancellation-during-approval-never-starts-a-terminal
  (let [entered (promise)
        {:keys [ctx calls rpc]} (fixture {:approve (fn [request]
                                                    (deliver entered true)
                                                    (loop [attempt 0]
                                                      (cancellation/throw-if-cancelled! (:cancel-token request))
                                                      (when (> attempt 100) (throw (ex-info "fixture deadline" {})))
                                                      (Thread/sleep 5) (recur (inc attempt))))})
        id (str (random-uuid))
        result (future (try (rpc "terminal.execute" {:action "open" :request_id id}) (catch Throwable _ :cancelled)))]
    (try
      (is (= true (deref entered 1000 :timeout)))
      (is (:cancelled (rpc "terminal.cancel" {:request_id id})))
      (is (= :cancelled (deref result 1000 :timeout)))
      (is (empty? @calls))
      (finally (kernel/dispose-all! ctx)))))

(deftest trust-revocation-requests-stop-and-plugin-removal-removes-its-rpcs
  (let [{:keys [ctx rpc trusted closed]} (fixture {})]
    (try
      (rpc "terminal.execute" {:action "open"})
      (reset! trusted false)
      (is (= true (deref closed 1200 :timeout)))
      (is (thrown? Exception (rpc "terminal.execute" {:action "input" :terminal_id "missing" :text "x"})))
      (kernel/dispose-plugin! ctx :execution/terminal)
      (is (nil? ((:method (kernel/service ctx :remote/registry)) "terminal.status")))
      (is (nil? (kernel/tool ctx "terminal")))
      (finally (kernel/dispose-all! ctx)))))

(deftest terminal-command-preserves-the-selected-sandbox-and-shell-quotes-remain-literal
  (let [assets {:python "/bundle/python" :helper "/bundle/helper" :root "/bundle"}
        command (transport/command "/workspace" assets :seatbelt "(deny default)\n")]
    (is (= "/usr/bin/sandbox-exec" (first command)))
    (is (some #{"WORKSPACE=/workspace"} command))
    (is (some #{"RUNTIME=/bundle"} command))
    (is (some #(and (string? %) (.contains % "(deny default)")) command))
    (is (thrown? Exception (transport/command "/workspace" assets :unavailable "")))
    (is (= "'a'\\''$(secret)'" (workspace/quote-argument "a'$(secret)")))))

(deftest unproven-native-containment-cannot-create-private-state-or-start-a-guardian
  (is (false? (:available? (transport/capability))))
  (let [controller (transport/controller "/fixture-must-not-be-created" {:available? true} :seatbelt "")]
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"detached shell descendants"
                         ((:start! controller) (fn [_] (throw (ex-info "must not admit" {}))) 90 24)))
    (is (:cleanup_confirmed ((:status controller))))))
