(ns qi.lcu-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

(defn fixture [& [opts]]
  (let [root (fs/create-temp-dir {:prefix "qi-lcu-test-"})
        ctx (kernel/create-context)
        owner (kernel/plugin-context ctx :test/lcu)
        requests (atom [])
        responses (atom [])
        prompts (atom [])]
    (fs/create-dirs (fs/path root "adapters"))
    (fs/create-dirs (fs/path root "bin"))
    (fs/copy "test/fixtures/lcu-client.mjs" (fs/path root "adapters/client.mjs"))
    (spit (str (fs/path root "bin/lcu")) "fixture")
    (kernel/register-service! owner :execution/world {:provider :local :sandbox :none :root (str root)})
    (kernel/register-service! owner :project/trust {:trusted? (constantly true)})
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
    {:ctx ctx :root root :requests requests :responses responses :prompts prompts}))

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
        (run! f ["approve"])
        (let [answer (:result (first (filter #(= "approval" (:event %)) (events f))))]
          (is (= (if headless "cancel" "session") (:choice answer))))
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
      (is (= "session" (get-in (first (filter #(= "approval" (:event %)) (events f))) [:result :choice])))
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
        (is (= "session" (get-in (first (filter #(= "approval" (:event %)) (events f))) [:result :choice]))))
      (finally (dispose! f)))))
