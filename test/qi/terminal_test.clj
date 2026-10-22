(ns qi.terminal-test
  (:require [clojure.test :refer [deftest is]]
            [clojure.edn :as edn]
            [babashka.fs :as fs]
            [cheshire.core :as json]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.terminal-process :as transport]
            [qi.workspace-runtime :as runtime]
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

(deftest terminal-cancel-before-queued-open-prevents-approval-and-admission
  (let [approvals (atom 0)
        {:keys [ctx calls rpc]} (fixture {:approve (fn [_] (swap! approvals inc) :allow)})
        id (str (random-uuid))]
    (try
      (is (:cancelled (rpc "terminal.cancel" {:request_id id})))
      (is (thrown? Exception (rpc "terminal.execute" {:action "open" :request_id id})))
      (is (zero? @approvals))
      (is (empty? @calls))
      (finally (kernel/dispose-all! ctx)))))

(deftest terminal-cancel-before-queued-input-or-resize-never-reaches-the-terminal
  (let [approvals (atom 0)
        {:keys [ctx calls rpc]} (fixture {:approve (fn [_] (swap! approvals inc) :allow)})]
    (try
      (let [terminal-id (:terminal_id (rpc "terminal.execute" {:action "open"}))
            before @calls]
        (doseq [operation [{:action "input" :text "must not run\n"} {:action "resize" :cols 80 :rows 20}]]
          (let [id (str (random-uuid))]
            (is (:cancelled (rpc "terminal.cancel" {:request_id id})))
            (is (thrown? Exception (rpc "terminal.execute" (assoc operation :terminal_id terminal-id :request_id id))))))
        (is (= 1 @approvals))
        (is (= before @calls)))
      (finally (kernel/dispose-all! ctx)))))

(deftest model-tool-cannot-reuse-a-manual-terminal-request-identity
  (let [{:keys [ctx calls rpc]} (fixture {}) id (str (random-uuid))]
    (try
      (rpc "terminal.cancel" {:request_id id})
      (let [tool (kernel/tool ctx "terminal")]
        (is (not (contains? (get-in tool [:parameters :properties]) :request_id)))
        (is (thrown? Exception ((:execute tool) {:action "open" :request_id id} {})))
        (is (empty? @calls)))
      (finally (kernel/dispose-all! ctx)))))

(deftest terminal-cancellation-limit-closes-new-admission-without-losing-cleanup
  (let [{:keys [ctx calls rpc]} (fixture {})
        ids (vec (repeatedly 129 #(str (random-uuid))))]
    (try
      (let [terminal-id (:terminal_id (rpc "terminal.execute" {:action "open"}))]
        (doseq [id ids] (is (:cancelled (rpc "terminal.cancel" {:request_id id}))))
        (is (false? (:available (rpc "terminal.status" {}))))
        (doseq [id [(first ids) (last ids) (str (random-uuid))]]
          (is (thrown? Exception (rpc "terminal.execute" {:action "open" :request_id id}))))
        (is (thrown? Exception ((:execute (kernel/tool ctx "terminal"))
                               {:action "input" :terminal_id terminal-id :text "must not run\n"} {})))
        (is (= 1 (count (filter #{:open} @calls))))
        (is (= "fixture" (:output (rpc "terminal.read" {:terminal_id terminal-id}))))
        (is (= "running" (:status (rpc "terminal.execute" {:action "interrupt" :terminal_id terminal-id}))))
        (is (:cleanup_confirmed (rpc "terminal.stop" {:terminal_id terminal-id}))))
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

(deftest native-process-group-mode-is-explicit-and-does-not-claim-descendant-containment
  (doseq [mode [:strict :native-process-group]]
    (let [root (fs/create-temp-dir {:prefix "qi-terminal-mode-unit-"})
          ctx (kernel/create-context)]
      (try
        (with-redefs [runtime/describe (constantly {:available? true :python-version "fixture"})]
          (plugin/load-all! ctx [{:ns 'qi.plugins.execution-world
                                 :config {:root (str root) :sandbox :none :terminal-cleanup-mode mode}}]))
        (let [world (kernel/service ctx :execution/world)
              capability (:terminal-capability world)]
          (is (= (name mode) (:cleanup-mode capability)))
          (is (false? (:descendant-containment capability)))
          (is (nil? (:terminal-controller world)) "native allocation never makes an unsandboxed command world available")
          (when (= mode :native-process-group)
            (is (= "registered-process-groups" (:cleanup-scope capability)))
            (is (seq (:limitations capability)))))
        (finally (kernel/dispose-all! ctx) (fs/delete-tree root))))))

(deftest native-mode-keeps-command-policy-and-model-parameters-fixed
  (let [args (transport/command "/fixture" {:python "/bundle/python" :helper "/bundle/helper" :root "/bundle"}
                                :seatbelt "(deny default)" :native-process-group)]
    ;; Architecture change: trusted allocator precedes the original command
    ;; policy. The policy is a fixed argv value, never a model/RPC parameter.
    (is (= "/bundle/python" (first args)))
    (is (= ["--cleanup-mode" "native-process-group"] (vec (take 2 (drop 8 args)))))
    (is (some #{"--seatbelt-profile"} args)))
  (is (thrown? Exception (transport/capability :unsupported)))
  (let [{:keys [ctx rpc calls]} (fixture {})]
    (try
      (is (thrown? Exception (rpc "terminal.execute" {:action "open" :cleanup_mode "native-process-group"})))
      (is (empty? @calls))
      (finally (kernel/dispose-all! ctx)))))

(deftest native-allocator-requires-seatbelt-on-the-command-child
  (let [assets {:python "/bundle/python" :helper "/bundle/helper" :root "/bundle"}
        policy "(deny default)"
        args (transport/command "/fixture" assets :seatbelt policy :native-process-group)]
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"Seatbelt"
                         (transport/command "/fixture" assets :none policy :native-process-group)))
    (is (= "/bundle/python" (first args)) "trusted allocator starts before the command child's fixed sandbox")
    (is (= ["--seatbelt-profile" (str policy "\n(allow file-read* (subpath (param \"RUNTIME\")))\n")
            "--runtime-root" "/bundle"] (vec (take-last 4 args))))))

(deftest desktop-profile-selects-limited-native-mode-without-overriding-explicit-strict
  (doseq [requested [nil :strict]]
    (let [root (fs/create-temp-dir {:prefix "qi-terminal-profile-unit-"})
          path (str (fs/path root "agent.edn"))
          config (cond-> {:root "." :sandbox :auto} requested (assoc :terminal-cleanup-mode requested))]
      (try
        (spit path (pr-str {:plugins [{:ns 'qi.plugins.execution-world :config config}]}))
        (binding [*command-line-args* [path]] (load-file "scripts/desktop/profile.clj"))
        (let [entries (:plugins (edn/read-string (slurp path))) world (first entries)]
          (is (= (or requested :native-process-group) (get-in world [:config :terminal-cleanup-mode])))
          (is (= :auto (get-in world [:config :sandbox])))
          (is (false? (get-in (first (filter #(= 'qi.plugins.lcu (:ns %)) entries)) [:config :enabled]))))
        (finally (fs/delete-tree root))))))

(defn office-fixture [options]
  (let [root (fs/create-temp-dir {:prefix "qi-office-mock-"})
        ctx (kernel/create-context) owner (kernel/plugin-context ctx :test/office)
        calls (atom [])]
    (kernel/register-service! owner :execution/world
                              {:root (str root) :capabilities #{:process} :workspace-runtime {:available? true}
                               :resolve! #(str (fs/path root %)) :resolve-write! #(str (fs/path root %))
                               :spawn! (fn [request]
                                         (swap! calls conj request)
                                         (if-let [spawn (:spawn options)] (spawn request)
                                           {:exit-code 0 :stdout (json/generate-string {:output "report.preview.pdf" :bytes 12})}))})
    (kernel/register-service! owner :project/trust {:trusted? (constantly (get options :trusted true))})
    (kernel/register-service! owner :approval/request (or (:approve options) (constantly :allow)))
    (kernel/mark-loaded! ctx {:id :test/office})
    (plugin/load-all! ctx [{:ns 'qi.plugins.remote-registry} {:ns 'qi.plugins.policy :config (:policy options {})}
                           {:ns 'qi.plugins.workspace-tools}])
    {:root root :ctx ctx :calls calls
     :rpc (fn [method params] ((:invoke! (kernel/service ctx :remote/registry)) method params))}))

(def office-assets {:available? true :node "/bundle/node" :office-helper "/bundle/office.mjs"})

(deftest office-manual-preview-honors-bash-deny-trust-and-explicit-approval
  (doseq [options [{:trusted false} {:policy {:deny-tools ["bash"]}} {:policy {:deny-tools ["office_preview"]}}]]
    (let [{:keys [ctx root calls rpc]} (office-fixture options)]
      (try (with-redefs [runtime/describe (constantly office-assets)]
             (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf"})))
             (is (empty? @calls)))
           (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))
  (let [approval (atom nil) {:keys [ctx root calls rpc]} (office-fixture {:approve #(do (reset! approval %) :allow)})]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (is (:available (rpc "workspace.runtime-status" {})))
           (is (= "report.preview.pdf" (:output (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf"}))))
           (is (= "office_preview" (:name @approval)))
           (is (= 1 (count @calls)))
           (spit (str (fs/path root "report.preview.pdf")) "preserved")
           (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf"})))
           (is (= "preserved" (slurp (str (fs/path root "report.preview.pdf")))))
           (is (= 1 (count @calls))))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-duplicate-click-and-cancel-during-approval-never-spawn
  (let [entered (promise) release (promise)
        {:keys [ctx root calls rpc]} (office-fixture {:approve (fn [_] (deliver entered true) (deref release 1000 :deny))})
        id (str (random-uuid))]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (let [operation (future (try (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf" :request_id id})
                                       (catch Throwable _ :cancelled)))]
             (is (= true (deref entered 1000 :timeout)))
             (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "second.pdf"})))
             (is (:cancelled (rpc "workspace.office-cancel" {:request_id id})))
             (deliver release :allow)
             (is (= :cancelled (deref operation 1000 :timeout)))
             (is (empty? @calls))))
         (finally (deliver release :deny) (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-cancel-after-spawn-is-uncertain-and-rpcs-dispose-with-plugin
  (let [entered (promise)
        {:keys [ctx root rpc]} (office-fixture {:spawn (fn [{:keys [cancel-token]}]
                                                       (deliver entered true)
                                                       (loop [attempt 0]
                                                         (cancellation/throw-if-cancelled! cancel-token)
                                                         (when (> attempt 200) (throw (ex-info "fixture deadline" {})))
                                                         (Thread/sleep 5) (recur (inc attempt))))})
        id (str (random-uuid))]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (let [operation (future (try (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf" :request_id id})
                                       (catch Throwable error (ex-data error))))]
             (is (= true (deref entered 1000 :timeout)))
             (is (:cancelled (rpc "workspace.office-cancel" {:request_id id})))
             (is (= "uncertain" (:status (deref operation 1000 {}))))))
         (kernel/dispose-plugin! ctx :tools/workspace-runtime)
         (is (nil? ((:method (kernel/service ctx :remote/registry)) "workspace.office-preview")))
         (is (nil? (kernel/tool ctx "office_preview")))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-plan-short-circuit-is-not-a-successful-conversion
  (let [{:keys [ctx root calls rpc]} (office-fixture {})]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (kernel/intercept! (kernel/plugin-context ctx :test/office-plan) :tool/execute -1000 (fn [_ _ _] {:blocked true}))
           (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf"})))
           (is (empty? @calls)))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-cancel-can-arrive-before-the-queued-conversion
  (let [approvals (atom 0) {:keys [ctx root calls rpc]} (office-fixture {:approve (fn [_] (swap! approvals inc) :allow)})
        id (str (random-uuid))]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (is (:cancelled (rpc "workspace.office-cancel" {:request_id id})))
           (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf" :request_id id})))
           (is (zero? @approvals))
           (is (empty? @calls)))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-invalid-or-replaced-output-is-an-uncertain-result
  (let [{:keys [ctx root rpc]} (office-fixture {:spawn (fn [_] {:exit-code 0 :stdout "{\"output\":\"other.pdf\",\"bytes\":12}"})})]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (is (= "uncertain" (try (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf"})
                                   (catch Throwable error (:status (ex-data error)))))))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))

(deftest office-cancellation-ledger-is-bounded-and-never-forgets-an-earlier-cancel
  (let [{:keys [ctx root calls rpc]} (office-fixture {}) ids (repeatedly 129 #(str (random-uuid)))]
    (try (with-redefs [runtime/describe (constantly office-assets)]
           (doseq [id ids] (is (:cancelled (rpc "workspace.office-cancel" {:request_id id}))))
           (is (false? (:available (rpc "workspace.runtime-status" {}))))
           (is (thrown? Exception (rpc "workspace.office-preview" {:path "report.docx" :output "report.preview.pdf" :request_id (first ids)})))
           (is (empty? @calls)))
         (finally (kernel/dispose-all! ctx) (fs/delete-tree root)))))
