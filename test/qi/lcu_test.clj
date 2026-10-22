(ns qi.lcu-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugins.lcu :as lcu]
            [qi.plugin :as plugin]))

(defn fixture [& [opts]]
  (let [root (fs/create-temp-dir {:prefix "qi-lcu-test-"})
        ctx (kernel/create-context)
        owner (kernel/plugin-context ctx :test/lcu)
        requests (atom [])
        responses (atom [])
        prompts (atom [])
        trusted (or (:trusted opts) (atom true))]
    (fs/create-dirs (fs/path root "adapters"))
    (fs/create-dirs (fs/path root "bin"))
    (fs/copy "test/fixtures/lcu-client.mjs" (fs/path root "adapters/client.mjs"))
    (spit (str (fs/path root "bin/lcu")) "fixture")
    (kernel/register-service! owner :execution/world (merge {:provider :local :sandbox :none :root (str root)} (:world opts)))
    (kernel/register-service! owner :project/trust {:trusted? #(deref trusted)})
    (kernel/register-service! owner :approval/request (constantly :allow))
    (kernel/register-service! owner :llm/registry {:current (constantly {:id :test :input-modalities #{:text :image}})})
    (kernel/register-service! owner :llm/generate
                              (fn [request]
                                (swap! requests conj request)
                                (let [response (first @responses)]
                                  (swap! responses subvec 1)
                                  response)))
    (when-not (:headless opts)
      (kernel/register-service! owner :ui/prompt
                                {:select! (fn [request]
                                            (swap! prompts conj request)
                                            (if-let [select! (:select! opts)]
                                              (select! request) :allow-session))}))
    (kernel/mark-loaded! ctx {:id :test/lcu})
    (plugin/load-all! ctx [{:ns 'qi.plugins.session}
                           {:ns 'qi.plugins.policy}
                           {:ns 'qi.plugins.computer-use}
                           {:ns 'qi.plugins.lcu :config (merge {:enabled true :lcu-home (str root)} (:config opts))}
                           {:ns 'qi.plugins.runtime :config {:retry-delay-ms 1}}])
    {:ctx ctx :root root :requests requests :responses responses :prompts prompts :trusted trusted}))

(defn events [{:keys [root]}]
  (let [path (str (fs/path root "events.jsonl"))]
    (if (fs/exists? path) (mapv #(json/parse-string % true) (str/split-lines (slurp path))) [])))

(defn run! [{:keys [ctx responses]} codes & [options]]
  (reset! responses (conj (mapv (fn [code]
                                  {:message {:role "assistant" :tool_calls
                                             [{:id (str "call-" code) :type "function"
                                               :function {:name "computer_js" :arguments {:code code}}}]}
                                   :finish-reason "tool_calls"}) codes)
                         {:message {:role "assistant" :content "Verified"} :finish-reason "stop"}))
  ((kernel/require-service ctx :agent/run) "Use the isolated test app" (or options {})))

(defn dispose! [{:keys [ctx root]}]
  (kernel/dispose-all! ctx)
  (fs/delete-tree root))

(deftest deferred-lcu-connect-keeps-untrusted-sessions-usable-without-launching
  (let [trusted (atom false)
        {:keys [ctx] :as f} (fixture {:trusted trusted :config {:connect-on-start false}})
        status #((:status (kernel/service ctx :computer-use/runtime)))
        command #((:execute (kernel/command ctx "computer")) % {})]
    (try
      (is (= :untrusted (:state (status))))
      (is (empty? (events f)))
      (is (empty? (kernel/tools ctx)))
      (is (thrown-with-msg? Exception #"trusted project" (command "connect")))
      (is (empty? (events f)))
      (reset! trusted true)
      (is (:connected (command "connect")))
      (is (:connected (command "connect")))
      (is (= 1 (count (filter #(= "connect" (:event %)) (events f)))))
      (let [prepared (kernel/tool ctx "computer_js")]
        (is (= :disconnected (:state (command "disconnect"))))
        (is (empty? (kernel/tools ctx)))
        (is (thrown-with-msg? Exception #"catalog changed" ((:execute prepared) {:code "stale"} {}))))
      (command "disconnect")
      (is (:connected (command "connect")))
      (is (= 2 (count (filter #(= "connect" (:event %)) (events f)))))
      (finally (dispose! f)))))

(deftest lcu-surfaces-are-explicit-and-do-not-inherit-browser-access
  (doseq [[args expected] [[[] ["computer"]] [["--chrome"] ["browser" "computer"]]]]
    (let [{:keys [ctx] :as f} (fixture {:config {:lcu-args args}})]
      (try
        (let [status ((:status (kernel/service ctx :computer-use/runtime)))]
          (is (= expected (get-in status [:capabilities :surfaces])))
          (is (= (if (seq args) :interactive :disabled) (get-in status [:capabilities :browser-origin-consent])))
          (is (= "0" (:audio (first (events f)))))
          (is (= "0" (:replAudio (first (events f)))))
          (is (= (str/join "," expected) (:surfaces (first (events f))))))
        (finally (dispose! f))))))

(deftest lcu-rejects-unsupported-launch-modes-before-starting
  (doseq [args [["--audio"] ["browser" "install"] ["--help"]]]
    (is (thrown-with-msg? Exception #"only.*--chrome"
                          (let [f (fixture {:config {:lcu-args args}})] (dispose! f))))))

(deftest desktop-timeout-remains-uncertain-until-an-explicit-reconnect
  (let [{:keys [ctx] :as f} (fixture {:config {:request-timeout-ms 100}})
        command #((:execute (kernel/command ctx "computer")) % {})]
    (try
      (is (thrown? Exception (run! f ["hang"])))
      (is (= :uncertain (:state (command "status"))))
      (command "disconnect")
      (is (thrown-with-msg? Exception #"Inspect the desktop" (command "connect")))
      (is (:connected (command "reconnect")))
      (is (nil? (:uncertain (command "status"))))
      (finally (dispose! f)))))

(deftest lcu-tool-errors-cannot-prove-that-input-was-not-delivered
  (let [{:keys [ctx] :as f} (fixture)]
    (try
      (is (thrown? Exception (run! f ["error"])))
      (let [status ((:status (kernel/service ctx :computer-use/runtime)))
            result (last (filter #(= "tool/result" (:type %)) ((:events (kernel/service ctx :session/store)))))]
        (is (= :uncertain (:state status)))
        (is (false? (:connected status)))
        (is (get-in result [:data :details :uncertain]))
        (is (seq (get-in result [:data :images])))
        (is (thrown-with-msg? Exception #"Inspect the desktop"
                              ((:execute (kernel/command ctx "computer")) "connect" {}))))
      (finally (dispose! f)))))

(deftest active-turn-cannot-be-disrupted-by-connection-commands
  (let [{:keys [ctx] :as f} (fixture)
        token (cancellation/create-token)
        running (future (try (run! f ["hang"] {:cancel-token token}) (catch Exception _ :cancelled)))]
    (try
      (loop [left 500]
        (when (and (pos? left) (not (some #(= "call" (:event %)) (events f))))
          (Thread/sleep 10) (recur (dec left))))
      (is (some #(= "call" (:event %)) (events f)))
      (doseq [command ["connect" "disconnect" "reconnect"]]
        (is (thrown-with-msg? Exception #"idle session"
                              ((:execute (kernel/command ctx "computer")) command {}))))
      (is (:connected ((:status (kernel/service ctx :computer-use/runtime)))))
      (finally
        (cancellation/cancel! token)
        (is (not= :timeout (deref running 15000 :timeout)))
        (dispose! f)))))

(deftest independent-sessions-have-distinct-bridges-and-lifecycle-identities
  (let [a (fixture) b (fixture)]
    (try
      (run! a ["one"])
      (run! b ["two"])
      (is (not= (:pid (first (events a))) (:pid (first (events b)))))
      (is (not= (:sessionId (first (filter #(= "call" (:event %)) (events a))))
                (:sessionId (first (filter #(= "call" (:event %)) (events b))))))
      (is (= ["Stop"] (mapv :hook (filter #(= "turn-end" (:event %)) (events a)))))
      (is (= ["Stop"] (mapv :hook (filter #(= "turn-end" (:event %)) (events b)))))
      (finally (dispose! a) (dispose! b)))))

(deftest web-runtime-status-exposes-the-same-gated-lcu-state
  (let [{:keys [ctx] :as f} (fixture {:config {:connect-on-start false}})]
    (try
      (plugin/load-all! ctx [{:ns 'qi.plugins.remote-registry} {:ns 'qi.plugins.remote-api}])
      (let [invoke! (:invoke! (kernel/service ctx :remote/registry))]
        (is (= :disconnected (get-in (invoke! "runtime.status" {}) [:computer-use :state])))
        (is (get-in (invoke! "command.execute" {:command "/computer connect"}) [:output :connected]))
        (is (= ["computer_js" "computer_js_reset"] (get-in (invoke! "runtime.status" {}) [:computer-use :tools])))
        (invoke! "command.execute" {:command "/computer disconnect"})
        (is (empty? (:tools (invoke! "runtime.status" {})))))
      (finally (dispose! f)))))

(deftest bridge-runs-agent-loop-with-original-instructions-images-identities-and-cleanup
  (let [{:keys [ctx requests] :as f} (fixture)]
    (try
      (is (= ["computer_js" "computer_js_reset"] (mapv :name (kernel/tools ctx))))
      (is (= "Original js" (:description (kernel/tool ctx "computer_js"))))
      (run! f ["observe" "input" "verify"])
      (is (every? #(str/includes? (:system-prompt %) "ORIGINAL LCU INSTRUCTIONS") @requests))
      (is (seq (:images (last (:messages (second @requests))))))
      (let [calls (filter #(= "call" (:event %)) (events f))
            ends (filter #(= "turn-end" (:event %)) (events f))]
        (is (= 3 (count calls)))
        (is (= 1 (count (distinct (map :turnId calls)))))
        (is (= (:session-id (kernel/service ctx :session/store)) (:sessionId (first calls))))
        (is (= "call-observe" (:toolCallId (first calls))))
        (is (= ["Stop"] (mapv :hook ends)))
        (is (= (:turnId (first calls)) (:turnId (first ends)))))
      (run! f ["again"])
      (is (= 2 (count (distinct (map :turnId (filter #(= "call" (:event %)) (events f)))))))
      (finally (dispose! f)))))

(deftest app-consent-is-rendered-verbatim-and-tool-allow-does-not-auto-approve
  (doseq [headless [false true]]
    (let [{:keys [prompts] :as f} (fixture {:headless headless})]
      (try
        (if headless
          (is (thrown? Exception (run! f ["approve"])))
          (run! f ["approve"]))
        (let [answer (:result (first (filter #(= "approval" (:event %)) (events f))))]
          (is (= (if headless "cancel" "accept") (:action answer)))
          (when-not headless (is (= "session" (get-in answer [:_meta :persist])))))
        (when-not headless
          (is (= "Original app approval text" (:message (first @prompts))))
          (is (= [:allow :allow-session :deny] (mapv :value (:items (first @prompts))))))
        (finally (dispose! f))))))

(deftest cleanup-failure-disconnects-and-reconnect-restores-a-new-client
  (let [{:keys [ctx] :as f} (fixture)]
    (try
      (run! f ["cleanup-fail"])
      (is (false? (:connected ((:status (kernel/service ctx :computer-use/runtime))))))
      ((:execute (kernel/command ctx "computer")) "reconnect" {})
      (run! f ["recovered"])
      (is (:connected ((:status (kernel/service ctx :computer-use/runtime)))))
      (finally (dispose! f)))))

(deftest pending-app-approval-pauses-request-deadline
  (let [f (fixture {:config {:request-timeout-ms 150}
                    :select! (fn [_] (Thread/sleep 350) :allow-session)})]
    (try
      (run! f ["approve"])
      (is (= "session" (get-in (first (filter #(= "approval" (:event %)) (events f))) [:result :_meta :persist])))
      (finally (dispose! f)))))

(deftest cancellation-dismisses-app-prompt-and-reaps-bridge
  (let [entered (promise)
        token (cancellation/create-token)
        f (fixture {:select! (fn [{:keys [cancel-token]}]
                              (deliver entered true)
                              (let [done (promise)
                                    detach (cancellation/on-cancel! cancel-token #(deliver done true))]
                                (try @done :deny (finally (detach)))))})]
    (try
      (let [running (future (try (run! f ["approve"] {:cancel-token token})
                                (catch Exception _ :cancelled)))]
        (is (= true (deref entered 5000 :timeout)))
        (cancellation/cancel! token)
        (is (not= :timeout (deref running 15000 :timeout))))
      (is (false? (:connected ((:status (kernel/service (:ctx f) :computer-use/runtime))))))
      (finally (dispose! f)))))

(deftest disabled-lcu-never-loads-the-library-or-reserves-desktop
  (let [{:keys [ctx] :as f} (fixture {:config {:enabled false :lcu-home "/missing-lcu"}})]
    (try
      (is (empty? (events f)))
      (is (empty? (kernel/tools ctx)))
      (is (nil? ((:provider-name (kernel/service ctx :computer-use/registry)))))
      (finally (dispose! f)))))

(deftest sdk-exceptions-after-input-are-uncertain-and-block-subsequent-dispatch
  (let [{:keys [ctx] :as f} (fixture)]
    (try
      (let [error (try (run! f ["throw" "must-not-run"]) nil (catch Exception error error))]
        (is (= :no-progress (:reason (ex-data error))))
        (is (= :external-result-unreconciled (get-in (ex-data error) [:diagnostic-plan :evidence-gap]))))
      (is (= ["throw"] (mapv #(get-in % [:args :code]) (filter #(= "call" (:event %)) (events f)))))
      (is (get-in ((:status (kernel/service ctx :computer-use/runtime))) [:uncertain :uncertain]))
      (finally (dispose! f)))))

(deftest failed-run-and-following-success-report-distinct-lifecycle-events
  (let [{:keys [ctx responses] :as f} (fixture)]
    (try
      (is (thrown? Exception (run! f ["observe"] {:max-steps 1})))
      (run! f ["recovered"])
      (is (= ["Interrupt" "Stop"] (mapv :hook (filter #(= "turn-end" (:event %)) (events f)))))
      (finally (dispose! f)))))

(deftest original-app-consent-can-be-resolved-through-the-real-rpc-interaction-service
  (let [{:keys [ctx] :as f} (fixture {:headless true})
        owner (kernel/plugin-context ctx :test/remote)]
    (try
      (kernel/register-service! owner :remote/registry {:register! (fn [_] (fn []))})
      (kernel/mark-loaded! ctx {:id :test/remote})
      (plugin/load-plugin! ctx {:ns 'qi.plugins.remote-interaction :config {:timeout-ms 5000}})
      (let [service (kernel/service ctx :interaction/remote)
            running (future (run! f ["approve"]))
            prompt (loop [remaining 500]
                     (if-let [prompt (first ((:pending service)))] prompt
                       (when (pos? remaining) (Thread/sleep 10) (recur (dec remaining)))))]
        (is (= "Original app approval text" (:message prompt)))
        (is (= [:allow :allow-session :deny] (mapv :value (:items prompt))))
        ((:resolve! service) (:id prompt) "allow-session")
        (is (not= :timeout (deref running 5000 :timeout)))
        (is (empty? ((:pending service))))
        (is (= "session" (get-in (first (filter #(= "approval" (:event %)) (events f))) [:result :_meta :persist]))))
      (finally (dispose! f)))))

(defn origin-request [origin]
  {:mode "form" :message (str "Allow Browser use to access " origin "?")
   :requestedSchema {:type "object" :properties {}}
   :_meta {:codex_approval_kind "mcp_tool_call" :connector_id "browser-use"
           :tool_name "access_browser_origin" :origin origin :tool_params {:origin origin} :persist "always"}})
(defn browser-code [params] (str "browser:" (json/generate-string params)))
(defn browser-events [f event] (filter #(= event (:event %)) (events f)))
(defn attempt! [f codes] (try (run! f codes) (catch Exception error {:fixture-error (ex-data error)})))

(deftest browser-origin-consent-is-explicit-and-scoped-to-one-connection
  (let [{:keys [ctx prompts] :as f} (fixture {:config {:lcu-args ["--chrome"]} :select! (constantly :allow)})
        command #((:execute (kernel/command ctx "computer")) % {})]
    (try
      (is (= "Verified" (:content (attempt! f [(browser-code (origin-request "https://example.test"))]))))
      (is (= "Verified" (:content (attempt! f [(browser-code (origin-request "https://example.test"))]))))
      (is (= 1 (count @prompts)))
      (is (= 2 (count (browser-events f "browser-action"))))
      (is (= [:deny :allow] (mapv :value (:items (first @prompts)))))
      (is (= :cancel (:default (first @prompts))))
      (is (str/includes? (or (:title (first @prompts)) "") "https://example.test"))
      (is (str/includes? (or (:label (some #(when (= :allow (:value %)) %) (:items (first @prompts)))) "") "connection"))
      (let [first-root (:runtimeRoot (first (events f)))]
        (is (string? first-root))
        (is (= 448 (:mode (first (events f)))))
        (is (= [] (:allowedOrigins (first (events f)))))
        (command "disconnect")
        (when first-root (is (not (fs/exists? first-root))))
        (command "reconnect")
        (is (not= first-root (:runtimeRoot (last (browser-events f "connect")))))
        (attempt! f [(browser-code (origin-request "https://example.test"))])
        (is (= 2 (count @prompts))))
      (finally (dispose! f)))))

(deftest browser-refusal-headless-and-other-origins-never-inherit-an-allow
  (doseq [mode [:deny :headless :cross-origin :lookalike :native-only]]
    (let [selections (atom 0)
          {:keys [ctx prompts] :as f}
          (fixture {:config {:lcu-args (if (= :native-only mode) [] ["--chrome"])}
                    :headless (= :headless mode)
                    :select! (fn [_] (if (and (contains? #{:cross-origin :lookalike} mode)
                                              (= 1 (swap! selections inc))) :allow :deny))})]
      (try
        (when (contains? #{:cross-origin :lookalike} mode)
          (attempt! f [(browser-code (origin-request "https://example.test"))]))
        (attempt! f [(browser-code (origin-request (case mode
                                                   :lookalike "https://example.test.attacker.invalid"
                                                   :cross-origin "https://other.test" "https://example.test")))])
        (is (= (if (contains? #{:cross-origin :lookalike} mode) 1 0) (count (browser-events f "browser-action"))))
        (is (false? (:connected ((:status (kernel/service ctx :computer-use/runtime))))))
        (when (contains? #{:cross-origin :lookalike} mode) (is (= 2 (count @prompts))))
        (finally (dispose! f))))))

(deftest browser-unknown-or-noncanonical-elicitation-is-cancelled-without-a-prompt
  (let [valid (origin-request "https://example.test")]
    (doseq [params (concat
                   (map origin-request ["HTTPS://EXAMPLE.TEST" "https://example.test:443" "https://example.test/"
                                        "https://example.test/path" "https://user@example.test" "file:///tmp/page" "null"])
                   [(assoc valid :mode "url")
                    (assoc-in valid [:requestedSchema :properties] {:secret {:type "string"}})
                    (assoc-in valid [:_meta :tool_name] "read_browser_history")
                    (assoc-in valid [:_meta :connector_id] "unknown")
                    (-> valid (assoc-in [:_meta :connector_id] "computer-use")
                        (assoc-in [:_meta :tool_params :app] "qi.test"))
                    (assoc-in valid [:_meta :tool_params :origin] "https://different.test")])]
      (let [{:keys [prompts] :as f} (fixture {:config {:lcu-args ["--chrome"]} :select! (constantly :allow)})]
        (try
          (attempt! f [(browser-code params)])
          (is (empty? @prompts))
          (is (empty? (browser-events f "browser-action")))
          (is (= "cancel" (get-in (first (browser-events f "browser-approval")) [:result :action])))
          (finally (dispose! f)))))))

(deftest browser-response-cannot-cross-origin-session-workspace-or-generation
  (doseq [field [:origin :sessionId :workspace :generation :turnId :approvalId]]
    (let [original @#'lcu/approval!]
      (with-redefs-fn {#'lcu/approval! (fn [& args]
                                      (let [answer (apply original args)]
                                        (assoc-in answer [:scope field] "stale-or-foreign")))}
        #(let [f (fixture {:config {:lcu-args ["--chrome"]} :select! (constantly :allow)})]
           (try
             (attempt! f [(browser-code (origin-request "https://example.test"))])
             (is (empty? (browser-events f "browser-action")))
             (is (= "cancel" (get-in (first (browser-events f "browser-approval")) [:result :action])))
             (finally (dispose! f))))))))

(deftest browser-startup-failures-clean-the-owned-preference-root
  (doseq [marker ["fail-connect" "blank-instructions"]]
    (let [{:keys [ctx root] :as f} (fixture {:config {:lcu-args ["--chrome"] :connect-on-start false}})]
      (try
        (spit (str (fs/path root marker)) "fixture")
        (is (thrown? Exception ((:execute (kernel/command ctx "computer")) "connect" {})))
        (let [runtime-root (:runtimeRoot (first (events f)))]
          (is (string? runtime-root))
          (when runtime-root (is (not (fs/exists? runtime-root)))))
        (finally (dispose! f))))))

(deftest browser-prompt-timeout-is-cancel-not-a-persisted-decline
  (let [{:keys [ctx] :as f} (fixture {:config {:lcu-args ["--chrome"]} :headless true})
        owner (kernel/plugin-context ctx :test/browser-remote)]
    (try
      (kernel/register-service! owner :remote/registry {:register! (fn [_] (fn []))})
      (kernel/mark-loaded! ctx {:id :test/browser-remote})
      (plugin/load-plugin! ctx {:ns 'qi.plugins.remote-interaction :config {:timeout-ms 50}})
      (attempt! f [(browser-code (origin-request "https://example.test"))])
      (is (empty? (browser-events f "browser-action")))
      (is (= "cancel" (get-in (first (browser-events f "browser-approval")) [:result :action])))
      (finally (dispose! f)))))

(deftest cancelled-browser-approval-cannot-be-accepted-late-or-replayed-on-reconnect
  (let [entered (promise) release (promise) token (cancellation/create-token)
        {:keys [ctx] :as f} (fixture {:config {:lcu-args ["--chrome"]}
                                     :select! (fn [_] (deliver entered true) (deref release 5000 :cancel))})
        root (:runtimeRoot (first (events f)))]
    (try
      (let [running (future (try (run! f [(browser-code (origin-request "https://example.test"))] {:cancel-token token})
                                 (catch Exception _ :cancelled)))]
        (is (= true (deref entered 5000 :timeout)))
        (cancellation/cancel! token)
        (is (not= :timeout (deref running 15000 :timeout)))
        (deliver release :allow)
        (is (empty? (browser-events f "browser-action")))
        (when root (is (not (fs/exists? root))))
        ((:execute (kernel/command ctx "computer")) "reconnect" {})
        (is (empty? (browser-events f "browser-action")))
        (is (= "Verified" (:content (attempt! f [(browser-code (origin-request "https://example.test"))]))))
        (is (= 1 (count (browser-events f "browser-action"))))
        (is (not= root (:runtimeRoot (last (browser-events f "connect"))))))
      (finally (deliver release :cancel) (dispose! f)))))

(defn install-remote! [ctx]
  (let [owner (kernel/plugin-context ctx :test/scoped-remote)]
    (kernel/register-service! owner :remote/registry {:register! (fn [_] (fn []))})
    (kernel/mark-loaded! ctx {:id :test/scoped-remote})
    (plugin/load-plugin! ctx {:ns 'qi.plugins.remote-interaction :config {:timeout-ms 5000}})
    (kernel/service ctx :interaction/remote)))

(defn await-prompt [service]
  (loop [left 500]
    (or (first ((:pending service)))
        (when (pos? left) (Thread/sleep 10) (recur (dec left))))))

(deftest switching-session-does-not-transfer-origin-approval-in-a-shared-workspace
  (let [a (fixture {:config {:lcu-args ["--chrome"]} :headless true})
        b (fixture {:config {:lcu-args ["--chrome"]} :headless true :world {:root (str (:root a))}})
        remote-a (install-remote! (:ctx a)) remote-b (install-remote! (:ctx b))
        code (browser-code (origin-request "http://127.0.0.1:8080"))]
    (try
      (let [run-a (future (attempt! a [code])) run-b (future (attempt! b [code]))
            prompt-a (await-prompt remote-a) prompt-b (await-prompt remote-b)]
        (is (map? prompt-a)) (is (map? prompt-b))
        (is (not= (:id prompt-a) (:id prompt-b)))
        (is (thrown? Exception ((:resolve! remote-b) (:id prompt-a) "allow")))
        (is (empty? (browser-events b "browser-action")))
        ((:resolve! remote-a) (:id prompt-a) "allow")
        ((:resolve! remote-b) (:id prompt-b) "deny")
        (is (= "Verified" (:content (deref run-a 5000 {}))))
        (is (not= :timeout (deref run-b 5000 :timeout)))
        (is (= 1 (count (browser-events a "browser-action"))))
        (is (empty? (browser-events b "browser-action")))
        (is (not= (:runtimeRoot (first (events a))) (:runtimeRoot (first (events b))))))
      (finally (dispose! a) (dispose! b)))))

(deftest unexpected-idle-bridge-exit-cleans-owned-browser-state
  (let [{:keys [ctx root] :as f} (fixture {:config {:lcu-args ["--chrome"] :connect-on-start false}})]
    (try
      (spit (str (fs/path root "idle-exit")) "fixture")
      ((:execute (kernel/command ctx "computer")) "connect" {})
      (let [runtime-root (:runtimeRoot (first (events f)))]
        (is (string? runtime-root))
        (loop [left 500]
          (when (and (pos? left) runtime-root (fs/exists? runtime-root))
            (Thread/sleep 10) (recur (dec left))))
        (is (not (fs/exists? runtime-root)))
        (is (false? (:connected ((:status (kernel/service ctx :computer-use/runtime)))))))
      (finally (dispose! f)))))

(deftest browser-state-removal-failure-remains-visible-until-explicit-reconnect
  (let [{:keys [ctx] :as f} (fixture {:config {:lcu-args ["--chrome"]}})
        root (:runtimeRoot (first (events f))) remove-tree fs/delete-tree]
    (try
      (with-redefs [fs/delete-tree (fn [path & args]
                                    (if (= root (str path))
                                      (throw (ex-info "Synthetic state removal failure" {}))
                                      (apply remove-tree path args)))]
        (is (thrown? Exception ((:execute (kernel/command ctx "computer")) "disconnect" {})))
        (let [status ((:status (kernel/service ctx :computer-use/runtime)))]
          (is (= :uncertain (:state status)))
          (is (= :cleanup-failed (get-in status [:uncertain :reason]))))
        (is (fs/exists? root)))
      ((:execute (kernel/command ctx "computer")) "reconnect" {})
      (is (not (fs/exists? root)))
      (is (:connected ((:status (kernel/service ctx :computer-use/runtime)))))
      (finally (dispose! f)))))
