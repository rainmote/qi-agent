(ns qi.computer-use-test
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.mcp-stdio :as mcp]
            [qi.plugin :as plugin]
            [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(def ^:private tool-schema
  {:type "object" :properties {:target {:type "string"}}
   :required ["target"] :additionalProperties false})
(def ^:private screen-tool
  {:name "snapshot" :description "Read the selected window" :inputSchema tool-schema})
(def ^:private image-content
  {:content [{:type "text" :text "Window observed"}
             {:type "image" :mimeType "image/png" :data "AQIDBA=="}]})
(def ^:private expected-image
  {:type :image :url "data:image/png;base64,AQIDBA==" :detail "auto"})

(defn- fixture
  ([] (fixture {}))
  ([{:keys [world trusted? modalities path real-models]
     :or {world {:provider :local :sandbox :none :root "."}
          trusted? true modalities #{:text :image}}}]
   (let [ctx (kernel/create-context)
         owner (kernel/plugin-context ctx :test/computer-services)
         trusted (atom trusted?)
         model (atom {:id :offline :model "offline-model" :input-modalities modalities})
         approval (atom :allow)
         approvals (atom [])
         responses (atom [])
         requests (atom [])
         generate (fn [request]
                    (swap! requests conj request)
                    (let [response (first @responses)]
                      (when-not response (throw (ex-info "Offline response queue exhausted" {})))
                      (swap! responses subvec 1)
                      response))]
     (kernel/register-service! owner :execution/world world)
     (kernel/register-service! owner :project/trust {:trusted? #(deref trusted)})
     (kernel/register-service! owner :approval/request
                               (fn [request] (swap! approvals conj request) @approval))
     (kernel/mark-loaded! ctx {:id :test/computer-services})
     (if real-models
       (do
         (plugin/load-plugin! ctx {:ns 'qi.plugins.model-registry})
         (doseq [entry real-models]
           (kernel/track-effect! owner
                                ((:register! (kernel/require-service ctx :llm/registry))
                                 (assoc entry :generate generate)))))
       (do
         (kernel/register-service! owner :llm/registry {:current #(deref model)})
         (kernel/register-service! owner :llm/generate generate)))
     (plugin/load-all! ctx [{:ns 'qi.plugins.computer-use}
                            {:ns 'qi.plugins.session :config (cond-> {} path (assoc :path path))}
                            {:ns 'qi.plugins.policy}
                            {:ns 'qi.plugins.runtime :config {:retry-delay-ms 1}}])
     {:ctx ctx :trusted trusted :model model :approval approval :approvals approvals
      :responses responses :requests requests})))

(defn- fake-driver
  ([] (fake-driver {}))
  ([{:keys [list! call! on-close!]
     :or {list! (fn [_] {:tools [screen-tool]})
          call! (fn [_ _] image-content)
          on-close! (fn [])}}]
   (let [alive (atom true)
         closes (atom 0)
         requests (atom [])]
     {:alive alive :closes closes :requests requests
      :client {:alive? #(deref alive)
               :close! (fn []
                         (when (compare-and-set! alive true false)
                           (swap! closes inc)
                           (on-close!)))
               :request! (fn [method params execution]
                           (swap! requests conj [method params])
                           (case method
                             "tools/list" (list! params)
                             "tools/call" (call! params execution)
                             (throw (ex-info "Unexpected mock request" {:method method}))))}})))

(defn- start! [ctx & [config]]
  (plugin/load-plugin! ctx {:ns 'qi.plugins.cua-driver-mcp
                            :config (merge {:enabled true} config)}))

(defn- status [ctx]
  ((:status (kernel/require-service ctx :computer-use/runtime))))

(defn- reconnect! [ctx]
  ((:execute (kernel/command ctx "computer")) "reconnect" {}))

(defn- execute! [ctx & [execution]]
  ((:execute (kernel/tool ctx "computer_snapshot")) {:target "window:1"} (or execution {})))

(defn- tool-call
  ([] (tool-call "screen-1" {:target "window:1"}))
  ([id arguments]
   {:id id :type "function" :function {:name "computer_snapshot" :arguments arguments}}))

(defn- run-calls!
  ([f calls] (run-calls! f calls {}))
  ([{:keys [ctx responses]} calls options]
   (reset! responses [{:message {:role "assistant" :content nil :tool_calls calls}
                       :finish-reason "tool_calls"}
                      {:message {:role "assistant" :content "Observed the result"}
                       :finish-reason "stop"}])
   ((kernel/require-service ctx :agent/run) "Inspect the offline fixture window" options)))

(defn- tool-results [ctx]
  (->> ((:events (kernel/require-service ctx :session/store)))
       (filter #(= "tool/result" (:type %))) (mapv :data)))

(defn- error-of [f]
  (try (f) nil (catch Throwable error error)))

(deftest disabled-provider-does-not-start-or-reserve-a-desktop
  (let [{:keys [ctx]} (fixture)
        connects (atom 0)]
    (try
      (with-redefs [mcp/connect! (fn [_] (swap! connects inc) (throw (Exception. "must not connect")))]
        (start! ctx {:enabled false})
        (is (= false (:enabled (status ctx))))
        (is (nil? (:provider (status ctx))))
        (is (empty? (kernel/tools ctx)))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"disabled" (reconnect! ctx)))
        (is (zero? @connects)))
      (finally (kernel/dispose-all! ctx)))))

(deftest provider-reservation-is-exclusive-and-stale-disposers-cannot-release-it
  (let [{:keys [ctx]} (fixture)]
    (try
      (let [{:keys [register! provider-name]} (kernel/require-service ctx :computer-use/registry)
            first-release (register! "first")]
        (is (= "first" (provider-name)))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"already registered" (register! "second")))
        (first-release)
        (let [second-release (register! "second")]
          (first-release)
          (is (= "second" (provider-name)))
          (second-release)
          (is (nil? (provider-name)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest driver-startup-requires-trusted-unsandboxed-local-world
  (doseq [options [{:trusted? false}
                   {:world {:provider :remote :sandbox :none :root "."}}
                   {:world {:provider :local :sandbox :workspace :root "."}}]]
    (let [{:keys [ctx]} (fixture options)
          connects (atom 0)]
      (try
        (with-redefs [mcp/connect! (fn [_] (swap! connects inc) (throw (Exception. "must not connect")))]
          (is (some? (error-of #(start! ctx))))
          (is (zero? @connects))
          (is (nil? (kernel/service ctx :computer-use/runtime)))
          (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry)))))
          (is (empty? (kernel/tools ctx))))
        (finally (kernel/dispose-all! ctx))))))

(deftest paginated-driver-catalog-preserves-schemas-and-cleans-up-on-disposal
  (let [{:keys [ctx]} (fixture)
        second-tool {:name "click" :description "Click a fresh element"
                     :inputSchema {:type "object" :properties {:element {:type "string"}}
                                   :required ["element"]}}
        driver (fake-driver {:list! (fn [{:keys [cursor]}]
                                     (if cursor {:tools [second-tool]}
                                       {:tools [screen-tool] :nextCursor "page-two"}))})]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (is (= [["tools/list" {}] ["tools/list" {:cursor "page-two"}]] @(:requests driver)))
        (is (= ["computer_click" "computer_snapshot"] (mapv :name (kernel/tools ctx))))
        (let [tool (kernel/tool ctx "computer_snapshot")]
          (is (= tool-schema (:parameters tool)))
          (is (= :sequential (:execution-mode tool)))
          (is (true? (:stop-batch-on-error tool)))
          (is (true? (:requires-trust tool)))
          (is (true? (:requires-approval tool))))
        (kernel/dispose-plugin! ctx :computer-use/cua-driver-mcp)
        (is (= 1 @(:closes driver)))
        (is (empty? (kernel/tools ctx)))
        (is (nil? (kernel/command ctx "computer")))
        (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest invalid-catalogs-and-partial-startup-release-all-owned-resources
  (doseq [[label list! config]
          [[:duplicate (fn [_] {:tools [screen-tool screen-tool]}) {}]
           [:bad-name (fn [_] {:tools [(assoc screen-tool :name "../click")]}) {}]
           [:bad-schema (fn [_] {:tools [(assoc screen-tool :inputSchema {:type "array"})]}) {}]
           [:not-array (fn [_] {:tools (list screen-tool)}) {}]
           [:empty (fn [_] {:tools []}) {}]
           [:cursor-loop (fn [_] {:tools [screen-tool] :nextCursor "repeat"}) {}]
           [:over-limit (fn [_] {:tools [screen-tool (assoc screen-tool :name "click")]}) {:max-tools 1}]]]
    (testing (name label)
      (let [{:keys [ctx]} (fixture)
            driver (fake-driver {:list! list!})]
        (try
          (with-redefs [mcp/connect! (constantly (:client driver))]
            (is (some? (error-of #(start! ctx config))))
            (is (= 1 @(:closes driver)))
            (is (empty? (kernel/tools ctx)))
            (is (nil? (kernel/service ctx :computer-use/runtime)))
            (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry))))))
          (finally (kernel/dispose-all! ctx))))))
  (testing "Failure after the first tool registration unwinds that tool and preserves a preexisting tool"
    (let [{:keys [ctx]} (fixture)
          driver (fake-driver {:list! (fn [_] {:tools [screen-tool (assoc screen-tool :name "occupied")]})})
          owner (kernel/plugin-context ctx :test/computer-services)]
      (try
        (kernel/register-tool! owner {:name "computer_occupied" :description "Existing tool"
                                      :parameters {:type "object"} :execute (fn [_ _] nil)})
        (with-redefs [mcp/connect! (constantly (:client driver))]
          (is (thrown-with-msg? clojure.lang.ExceptionInfo #"already registered" (start! ctx)))
          (is (= ["computer_occupied"] (mapv :name (kernel/tools ctx))))
          (is (= 1 @(:closes driver)))
          (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest runtime-enforces-tool-schema-trust-and-approval-before-driver-dispatch
  (doseq [condition [:deny :untrusted :invalid-arguments :allow]]
    (let [{:keys [ctx trusted approval approvals] :as f} (fixture)
          driver (fake-driver)]
      (try
        (with-redefs [mcp/connect! (constantly (:client driver))]
          (start! ctx)
          (when (= condition :deny) (reset! approval :deny))
          (when (= condition :untrusted) (reset! trusted false))
          (run-calls! f [(tool-call "screen-1" (if (= condition :invalid-arguments) {} {:target "window:1"}))])
          (let [calls (filter #(= "tools/call" (first %)) @(:requests driver))
                result (last (tool-results ctx))]
            (is (= (= condition :allow) (:ok result)))
            (is (= (if (= condition :allow) 1 0) (count calls)))
            (is (= (if (#{:allow :deny} condition) 1 0) (count @approvals)))
            (when (= condition :allow)
              (is (= {:provider "cua-driver-mcp" :command "snapshot" :scope :host-desktop}
                     (:target (first @approvals)))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest current-model-and-trust-are-rechecked-at-execution-time
  (let [{:keys [ctx model trusted]} (fixture)
        driver (fake-driver)]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (swap! model assoc :input-modalities #{:text})
        (is (false? (:image-model (status ctx))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"image-capable" (execute! ctx)))
        (swap! model assoc :input-modalities #{:text :image})
        (reset! trusted false)
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"trusted project" (execute! ctx)))
        (is (= 1 (count @(:requests driver)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest screenshots-reach-the-next-model-request-and-survive-session-reload
  (let [root (fs/create-temp-dir {:prefix "qi-computer-session-"})
        path (str (fs/path root "session.jsonl"))
        {:keys [ctx requests] :as f} (fixture {:path path})
        driver (fake-driver)]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (run-calls! f [(tool-call)])
        (let [result (last (tool-results ctx))
              message (last (:messages (second @requests)))]
          (is (= [expected-image] (:images result)))
          (is (= [expected-image] (:images message)))
          (is (= "tool" (:role message)))
          (is (= "Window observed\n[Screenshot 1]" (:content message)))
          (is (not (str/includes? (:content message) "base64")))
          (is (not (contains? result :value)))))
      (kernel/dispose-all! ctx)
      (let [resumed (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}]})]
        (try
          (let [store (kernel/require-service resumed :session/store)
                message (first (filter #(= "tool" (:role %)) ((:messages store))))]
            (is (= (:url expected-image) (get-in message [:images 0 :url])))
            (is (= "image" (get-in message [:images 0 :type])))
            (is (= "Window observed\n[Screenshot 1]" (:content message))))
          (finally (kernel/dispose-all! resumed))))
      (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest mcp-tool-error-is-recorded-and-presented-to-the-next-model-as-an-error
  (let [{:keys [ctx requests] :as f} (fixture)
        driver (fake-driver {:call! (fn [_ _] {:isError true :content [{:type "text" :text "Window token expired"}]})})]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (run-calls! f [(tool-call)])
        (is (false? (:ok (last (tool-results ctx)))))
        (is (true? (:is-error (last (tool-results ctx)))))
        (is (true? (:is-error (last (:messages (second @requests))))))
        (is (nil? (:uncertain (status ctx))))
        (is (true? (:connected (status ctx)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest uncertain-tool-outcomes-block-further-input-until-explicit-reconnect
  (let [{:keys [ctx]} (fixture)
        first-driver (fake-driver {:call! (fn [_ _]
                                           (throw (ex-info "reply lost" {:uncertain true :method "tools/call" :request-id 7})))})
        second-driver (fake-driver)
        connects (atom 0)]
    (try
      (with-redefs [mcp/connect! (fn [_] (:client (if (= 1 (swap! connects inc)) first-driver second-driver)))]
        (start! ctx)
        (is (true? (:uncertain (ex-data (error-of #(execute! ctx))))))
        (is (true? (get-in (status ctx) [:uncertain :uncertain])))
        (is (false? (:connected (status ctx))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"uncertain outcome" (execute! ctx)))
        (is (= 1 (count (filter #(= "tools/call" (first %)) @(:requests first-driver)))))
        (is (:connected (reconnect! ctx)))
        (is (nil? (:uncertain (status ctx))))
        (is (= [expected-image] (:images (execute! ctx))))
        (is (= 2 @connects)))
      (finally (kernel/dispose-all! ctx)))))

(deftest malformed-or-over-limit-screenshot-results-fail-closed-without-data-in-errors
  (doseq [[result config]
          [[{:content [{:type "image" :mimeType "image/svg+xml" :data "c2VjcmV0"}]} {}]
           [{:content [{:type "image" :mimeType "image/png" :data "secret-payload"}]} {}]
           [image-content {:max-image-bytes 3}]
           [{:content [{:type "image" :mimeType "image/png" :data "AQIDBA=="}
                       {:type "image" :mimeType "image/png" :data "AQIDBA=="}]} {:max-images 1}]
           [{:content [{:type "text" :text {:invalid true}}]} {}]
           [{:invalid "no content vector"} {}]]]
    (let [{:keys [ctx]} (fixture)
          driver (fake-driver {:call! (fn [_ _] result)})]
      (try
        (with-redefs [mcp/connect! (constantly (:client driver))]
          (start! ctx config)
          (let [error (error-of #(execute! ctx))]
            (is (true? (:uncertain (ex-data error))))
            (is (not (str/includes? (str (ex-message error) (ex-data error)) "secret"))))
          (is (= 1 @(:closes driver)))
          (is (thrown-with-msg? clojure.lang.ExceptionInfo #"uncertain outcome" (execute! ctx))))
        (finally (kernel/dispose-all! ctx))))))

(deftest cancellation-before-dispatch-does-not-contact-the-driver
  (let [{:keys [ctx]} (fixture)
        driver (fake-driver)
        token (cancellation/create-token)]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (cancellation/cancel! token)
        (is (true? (:cancelled (ex-data (error-of #(execute! ctx {:cancel-token token}))))))
        (is (= 1 (count @(:requests driver))))
        (is (nil? (:uncertain (status ctx)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest disposal-closes-a-running-call-before-draining-it-and-releases-the-reservation
  (let [{:keys [ctx]} (fixture)
        entered (promise)
        closed (promise)
        driver (fake-driver {:call! (fn [_ _]
                                     (deliver entered true)
                                     (deref closed 2000 nil)
                                     (throw (ex-info "connection closed during input" {:uncertain true})))
                             :on-close! #(deliver closed true)})]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (let [tool (kernel/tool ctx "computer_snapshot")
              running (future (error-of #((:execute tool) {:target "window:1"} {})))]
          (is (= true (deref entered 2000 ::timeout)))
          (let [stopping (future (kernel/dispose-plugin! ctx :computer-use/cua-driver-mcp) :disposed)]
            (is (= :disposed (deref stopping 2000 ::timeout)))
            (is (some? (deref running 2000 nil)))
            (is (= 1 @(:closes driver)))
            (is (empty? (kernel/tools ctx)))
            (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry)))))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo #"stopping"
                                 ((:execute tool) {:target "window:1"} {}))))))
      (finally (deliver closed true) (kernel/dispose-all! ctx)))))

(deftest prepared-tool-handles-cannot-cross-a-reconnection-generation
  (let [{:keys [ctx]} (fixture)
        listing (promise)
        release (promise)
        first-driver (fake-driver)
        second-driver (fake-driver {:list! (fn [_]
                                            (deliver listing true)
                                            (deref release 2000 nil)
                                            {:tools [(assoc screen-tool :inputSchema
                                                            {:type "object" :properties {:new_target {:type "string"}}
                                                             :required ["new_target"]})]})})
        connects (atom 0)]
    (try
      (with-redefs [mcp/connect! (fn [_] (:client (if (= 1 (swap! connects inc)) first-driver second-driver)))]
        (start! ctx)
        (let [old-tool (kernel/tool ctx "computer_snapshot")
              reconnecting (future (reconnect! ctx))]
          (is (= true (deref listing 2000 ::timeout)))
          (let [old-call (future (error-of #((:execute old-tool) {:target "old-window"} {})))]
            ;; The old prepared call may be blocked or rejected, but must never
            ;; execute while discovery of the replacement catalog is pending.
            (deref old-call 30 ::pending)
            (is (empty? (filter #(= "tools/call" (first %)) @(:requests second-driver))))
            (deliver release true)
            (is (:connected (deref reconnecting 2000 {})))
            (is (some? (deref old-call 2000 nil)))
            (is (empty? (filter #(= "tools/call" (first %)) @(:requests second-driver)))))))
      (finally (deliver release true) (kernel/dispose-all! ctx)))))

(deftest a-failed-desktop-action-prevents-later-input-in-the-same-batch
  (doseq [failure [:tool-error :invalid-arguments :denied]]
    (testing (name failure)
      (let [{:keys [ctx approval approvals] :as f} (fixture)
            sent (atom [])
            driver (fake-driver
                    {:list! (fn [_] {:tools [(assoc screen-tool :name "click")
                                             (assoc screen-tool :name "type_text")]})
                     :call! (fn [{:keys [name]} _]
                              (swap! sent conj name)
                              (if (= "click" name)
                                {:isError true
                                 :content [{:type "text" :text "Window token expired"}]}
                                {:content [{:type "text" :text "Typed into previous focus"}]}))})
            click (assoc-in (tool-call "click" (if (= failure :invalid-arguments)
                                                 {} {:target "window:1"}))
                            [:function :name] "computer_click")
            typing (assoc-in (tool-call "type" {:target "window:1"})
                             [:function :name] "computer_type_text")]
        (try
          (with-redefs [mcp/connect! (constantly (:client driver))]
            (start! ctx)
            (when (= failure :denied)
              ;; Deny the first call but allow the second during serial
              ;; preflight, so its missing dispatch must be the batch stop.
              (reset! approval :deny)
              (kernel/on!
               (kernel/plugin-context ctx :test/computer-services)
               :tool.execution/confirming
               (fn [_ _] (when (seq @approvals) (reset! approval :allow)))))
            (run-calls! f [click typing])
            (is (= (if (= failure :tool-error) ["click"] []) @sent))
            (let [results (tool-results ctx)]
              (is (= ["click" "type"] (mapv :call-id results)))
              (is (every? #(false? (:ok %)) results))
              (is (true? (get-in results [1 :details :skipped])))
              (is (= "click" (get-in results [1 :details :blocked-by])))
              (is (nil? (:started-at (second results)))))
            ;; A definite MCP error halts this batch without poisoning the
            ;; connection; a later turn can observe and recover.
            (is (true? (:connected (status ctx))))
            (is (nil? (:uncertain (status ctx)))))
          (finally (kernel/dispose-all! ctx)))))))

(deftest desktop-preflight-failure-also-stops-following-ordinary-tools
  (let [{:keys [ctx] :as f} (fixture)
        driver (fake-driver)
        ordinary-calls (atom 0)]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (kernel/register-tool!
         (kernel/plugin-context ctx :test/computer-services)
         {:name "ordinary" :description "Ordinary parallel tool"
          :parameters {:type "object" :properties {}}
          :execute (fn [_ _] (swap! ordinary-calls inc) "executed")})
        (run-calls! f [(tool-call "invalid-desktop" {})
                       {:id "ordinary" :type "function"
                        :function {:name "ordinary" :arguments {}}}])
        (is (zero? @ordinary-calls))
        (is (true? (get-in (tool-results ctx) [1 :details :skipped])))
        (is (= "invalid-desktop" (get-in (tool-results ctx) [1 :details :blocked-by]))))
      (finally (kernel/dispose-all! ctx)))))

(deftest unloading-policy-prevents-surviving-desktop-tools-from-dispatching
  (let [{:keys [ctx] :as f} (fixture)
        driver (fake-driver)]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (kernel/dispose-plugin! ctx :policy/tool-gate)
        (run-calls! f [(tool-call)])
        (is (empty? (filter #(= "tools/call" (first %)) @(:requests driver))))
        (let [result (last (tool-results ctx))]
          (is (false? (:ok result)))
          (is (str/includes? (:content result) ":tool/policy"))))
      (finally (kernel/dispose-all! ctx)))))

(deftest effective-provider-route-and-alias-control-image-capability-without-changing-selection
  (doseq [[selected requested allowed?] [[:vision :text false]
                                       [:text :vision true]
                                       [:text :desktop-alias true]]]
    (let [{:keys [ctx] :as f} (fixture {:real-models [{:id :vision :model "offline-vision" :input-modalities #{:text :image}}
                                                    {:id :text :model "offline-text" :input-modalities #{:text}}]})
          registry (kernel/require-service ctx :llm/registry)
          driver (fake-driver)]
      (try
        (kernel/track-effect! (kernel/plugin-context ctx :test/computer-services)
                             ((:alias! registry) :desktop-alias :vision))
        ((:select! registry) selected)
        (is (= #{:text :image} (:input-modalities ((:lookup registry) :desktop-alias))))
        (is (not (contains? ((:lookup registry) :desktop-alias) :generate)))
        (is (= #{:text :image} (:input-modalities (first (filter #(= :vision (:id %)) ((:providers registry)))))))
        (with-redefs [mcp/connect! (constantly (:client driver))]
          (start! ctx)
          (run-calls! f [(tool-call)] {:model-options {:provider requested}})
          (is (= allowed? (:ok (last (tool-results ctx)))))
          (is (= (if allowed? 1 0) (count (filter #(= "tools/call" (first %)) @(:requests driver)))))
          (is (= selected (:id ((:current registry)))))
          (when-not allowed?
            (is (str/includes? (:content (last (tool-results ctx))) "image-capable"))))
        (finally (kernel/dispose-all! ctx))))))

(deftest cancellation-of-dispatched-desktop-input-persists-uncertain-outcome
  (let [{:keys [ctx] :as f} (fixture)
        entered (promise)
        cancelled (promise)
        token (cancellation/create-token)
        driver (fake-driver {:call! (fn [_ execution]
                                     (let [dispose (cancellation/on-cancel! (:cancel-token execution)
                                                                          #(deliver cancelled true))]
                                       (try
                                         (deliver entered true)
                                         (deref cancelled 2000 nil)
                                         (throw (ex-info "MCP input cancelled" {:cancelled true :uncertain true}))
                                         (finally (dispose)))))})]
    (try
      (with-redefs [mcp/connect! (constantly (:client driver))]
        (start! ctx)
        (let [running (future (error-of #(run-calls! f [(tool-call)] {:cancel-token token})))]
          (is (= true (deref entered 2000 ::timeout)))
          (cancellation/cancel! token)
          (is (not= ::timeout (deref running 2000 ::timeout)))
          (let [result (last (tool-results ctx))]
            (is (true? (:cancelled result)))
            (is (true? (get-in result [:details :uncertain])))
            (is (str/includes? (:content result) "uncertain")))
          (is (true? (get-in (status ctx) [:uncertain :uncertain])))
          (is (= 1 @(:closes driver)))))
      (finally (deliver cancelled true) (kernel/dispose-all! ctx)))))

(deftest concurrent-reconnects-own-at-most-one-transport-and-disposal-drains-startup
  (let [{:keys [ctx]} (fixture)
        second-listing (promise)
        release (promise)
        second-driver (fake-driver {:list! (fn [_]
                                            (deliver second-listing true)
                                            (deref release 2000 nil)
                                            {:tools [screen-tool]})})
        drivers [(fake-driver) second-driver (fake-driver)]
        connects (atom 0)]
    (try
      (with-redefs [mcp/connect! (fn [_]
                                 (is (not-any? #(deref (:alive %)) (take @connects drivers))
                                     "Prior transport must be closed before starting a replacement")
                                 (:client (nth drivers (dec (swap! connects inc)))))]
        (start! ctx)
        (let [first-reconnect (future (error-of #(reconnect! ctx)))]
          (is (= true (deref second-listing 2000 ::timeout)))
          (let [second-reconnect (future (error-of #(reconnect! ctx)))
                stopping (future (kernel/dispose-plugin! ctx :computer-use/cua-driver-mcp) :disposed)]
            (deliver release true)
            (is (not= ::timeout (deref first-reconnect 2000 ::timeout)))
            (is (not= ::timeout (deref second-reconnect 2000 ::timeout)))
            (is (= :disposed (deref stopping 2000 ::timeout)))
            (is (not-any? #(deref (:alive %)) (take @connects drivers)))
            (is (empty? (kernel/tools ctx)))
            (is (nil? ((:provider-name (kernel/require-service ctx :computer-use/registry))))))))
      (finally (deliver release true) (kernel/dispose-all! ctx)))))
