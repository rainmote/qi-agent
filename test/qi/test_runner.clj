(ns qi.test-runner
  (:require [qi.cancellation :as cancellation]
            [qi.command :as command]
            [qi.cli :as cli]
            [qi.install :as install]
            [qi.api :as api]
            [qi.env :as env]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.presets :as presets]
            [qi.presets-test]
            [qi.runtime-inspect-test]
            [qi.runtime-lab-test]
            [qi.runtime-recovery-test]
            [qi.run-outcome-test]
            [qi.openai-integrity-test]
            [qi.credential-boundary-test]
            [qi.chatgpt-catalog-test]
            [qi.owner-uid-test]
            [qi.responses-schema-test]
            [qi.tool-recovery-test]
            [qi.context-integrity-test]
            [qi.midturn-compaction-test]
            [qi.generation-test]
            [qi.provenance-test]
            [qi.remote-snapshot-test]
            [qi.remote-interaction-cancel-test]
            [qi.computer-use-test]
            [qi.lcu-test]
            [qi.terminal-test]
            [qi.mcp-stdio-test]
            [qi.mcp-deadline-test]
            [qi.tool-images-test]
            [qi.attachments-test]
            [qi.jobs-test]
            [qi.mcp-http-test]
            [qi.mcp-client-test]
            [qi.web-tools-test]
            [qi.orchestration-test]
            [qi.orchestration-recovery-test]
            [qi.planning-protocol-test]
            [qi.automation-test]
            [qi.plugin-manager-test]
            [qi.session-title-test]
            [qi.protocol :as protocol]
            [qi.sandbox :as sandbox]
            [qi.ui :as ui]
            [qi.web-test]
            [babashka.process :as process]
            [qi.plugins.chatgpt]
            [qi.plugins.omp]
            [qi.plugins.openai]
            [qi.plugins.openai-responses]
            [qi.plugins.bb-repl :as process-repl]
            [qi.plugins.remote-api :as remote-api]
            [qi.plugins.subagent]
            [qi.plugins.subagent-in-process]
            [qi.plugins.subagent-tools]
            [qi.plugins.trust :as trust]
            [qi.plugins.tui :as tui]
            [qi.schema :as schema]
            [qi.streaming :as streaming]
            [qi.system-prompt :as system-prompt]
            [babashka.fs :as fs]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is run-tests testing]]))

(declare delete-tree! tool-call)

(deftest shipped-harness-profiles-mount-offline-with-parent-only-capabilities
  (let [new-plugins '#{qi.plugins.jobs qi.plugins.mcp-client qi.plugins.web-tools
                      qi.plugins.planning qi.plugins.workflow qi.plugins.team
                      qi.plugins.automation qi.plugins.plugin-manager}
        expected-services #{:execution/jobs :mcp/runtime :web/runtime
                            :planning/runtime :workflow/runtime :team/runtime
                            :automation/control :plugins/manager}]
    (doseq [path ["agent.edn" "presets/standard/agent.edn" "presets/creator/agent.edn"]]
      (let [root (fs/real-path (fs/create-temp-dir {:prefix "qi-harness-profile-"}))
            config (plugin/read-config path)
            specs (:plugins config)
            child-config (some #(when (= 'qi.plugins.subagent-in-process (:ns %))
                                  (:config %)) specs)
            namespaces (mapv :ns specs)
            isolated
            (update config :plugins
                    #(mapv (fn [spec]
                             (update spec :config
                                     (fn [options]
                                       (let [options (or options {})
                                             options (cond-> options
                                                       (contains? options :root) (assoc :root (str root)))]
                                         (case (:ns spec)
                                           qi.plugins.session-catalog (assoc options :directory (str (fs/path root "sessions")))
                                           qi.plugins.trust (assoc options :trusted false :trust-file (str (fs/path root "trust.edn")))
                                           qi.plugins.resources (assoc options :user-dir (str (fs/path root "resources")))
                                           qi.plugins.presets (assoc options :user-root (str (fs/path root "presets")))
                                           qi.plugins.plugin-manager (assoc options :user-dir (str (fs/path root "packages")))
                                           options))))) %))]
        (try
          (is (every? (set namespaces) new-plugins) path)
          (is (< (.indexOf namespaces 'qi.plugins.jobs) (.indexOf namespaces 'qi.plugins.tools)) path)
          (is (not-any? new-plugins (map :ns (get-in child-config [:child-profile :plugins]))) path)
          (is (not-any? #{"bash" "write" "edit" "job_kill" "web_search" "plugin_manage"}
                        (:allowed-tools child-config)) path)
          ;; Mount the real composition without reading personal trust, resource,
          ;; provider-settings, session or plugin-package data. No model runs.
          (with-redefs [env/get (fn [& _] nil) env/home (constantly (str root))]
            (let [ctx (plugin/boot! isolated)]
              (try
                (is (every? #(kernel/service ctx %) expected-services) path)
                (is (= [] (:servers ((:status (kernel/require-service ctx :mcp/runtime))))) path)
                (is (false? (:search-enabled ((:status (kernel/require-service ctx :web/runtime))))) path)
                (is (false? (:available? (kernel/require-service ctx :automation/control))) path)
                (is (empty? ((:list (kernel/require-service ctx :execution/jobs)))) path)
                (finally (kernel/dispose-all! ctx)))))
          (finally (fs/delete-tree root)))))))

(deftest shared-read-only-method-catalog-keeps-new-mutations-private
  (let [catalog (json/parse-string (slurp "protocol/methods.json") true)
        read-only (set (:readOnly catalog))
        exempt (into read-only (:connection catalog))]
    (is (every? read-only ["mcp.status" "web.status" "planning.show"
                          "workflow.show" "workflow.status" "team.show" "team.mailbox"
                          "plugins.list" "plugins.inspect" "plugins.ui-slots"]))
    (is (not-any? exempt ["mcp.control" "mcp.configure" "plugins.manage"
                         "planning.submit" "planning.approve" "workflow.run"
                         "workflow.resume" "workflow.cancel" "team.claim"
                         "team.send" "schedule.add" "schedule.update" "schedule.pause"
                         "schedule.resume" "schedule.cancel" "goal.set" "goal.update"
                         "goal.pause" "goal.resume" "goal.cancel" "goal.complete"
                         "automation.resolve"]))
    (is (= (count (:readOnly catalog)) (count read-only)))))

(deftest legacy-plugin-namespaces-resolve-to-qi-builtins
  (let [ctx (plugin/boot! {:plugins [{:ns 'agent.plugins.math}]})]
    (try
      (is (= 'qi.plugins.math
             (:namespace (first (kernel/loaded-plugins ctx)))))
      (is (= ["calculate"] (mapv :name (kernel/tools ctx))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest global-installer-keeps-code-data-and-the-callers-workspace-separated
  (let [launcher (install/launcher-script "/opt/qi-agent"
                                          "/var/lib/qi-agent-user"
                                          "/opt/bin")]
    (is (str/includes? launcher "# Managed by qi-agent `bb install`."))
    (is (str/includes? launcher "QI_AGENT_HOME='/var/lib/qi-agent-user'"))
    (is (str/includes? launcher "\"${1:-}\" = \"upgrade\""))
    (is (str/includes? launcher "bb --config \"$INSTALL_DIR/bb.edn\" update"))
    (is (str/includes?
         launcher
         "\"$INSTALL_DIR/apps/tui-rs/target/release/qi-agent\""))
    (is (str/includes? launcher "--repository-root \"$INSTALL_DIR\""))
    (is (str/includes? launcher "--config \"$QI_AGENT_HOME/agent.edn\""))
    (is (str/includes? launcher "\"$@\""))
    (is (not (str/includes? launcher "cd ")))
    (is (install/path-entry? "/usr/bin:/opt/tools" "/opt/tools"))
    (is (not (install/path-entry? "/usr/bin:/opt/toolsmith" "/opt/tools")))))

(deftest installer-rejects-overlapping-code-and-data-layouts
  (let [assert-safe! (var-get (ns-resolve 'qi.install 'assert-safe-layout!))]
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"must not overlap"
                          (assert-safe! "/srv/qi/source"
                                        "/srv/qi/source/installed"
                                        "/var/lib/qi-agent")))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"must not overlap"
                          (assert-safe! "/srv/qi/source"
                                        "/srv/qi"
                                        "/var/lib/qi-agent")))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"must not be inside"
                          (assert-safe! "/srv/qi/source"
                                        "/opt/qi-agent"
                                        "/opt/qi-agent/user-data")))))

(deftest installer-restores-the-old-application-when-activation-fails
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-activation-rollback-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        installed (io/file root "app")
        missing-stage (io/file root "missing-stage")
        activate! (var-get (ns-resolve 'qi.install 'activate-stage!))]
    (try
      (.mkdirs installed)
      (spit (io/file installed "version") "old")
      (is (thrown? Throwable (activate! missing-stage installed)))
      (is (= "old" (slurp (io/file installed "version"))))
      (finally (delete-tree! root)))))

(deftest installer-reports-backup-cleanup-separately-from-activation
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-activation-cleanup-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        installed (io/file root "app")
        stage (io/file root "stage")
        warnings (java.io.StringWriter.)
        activate! (var-get (ns-resolve 'qi.install 'activate-stage!))]
    (try
      (.mkdirs installed)
      (.mkdirs stage)
      (spit (io/file installed "version") "old")
      (spit (io/file stage "version") "new")
      (with-redefs [fs/delete-tree
                    (fn [_]
                      (throw (ex-info "simulated cleanup failure" {})))]
        (binding [*err* warnings]
          (is (nil? (activate! stage installed)))))
      (is (= "new" (slurp (io/file installed "version"))))
      (is (str/includes? (str warnings) "old application backup"))
      (finally (delete-tree! root)))))

(deftest installer-prunes-build-intermediates-and-keeps-one-release-binary
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-install-stage-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        stage (io/file root "stage")
        prune-build-stage! (var-get (ns-resolve 'qi.install
                                                'prune-build-stage!))]
    (try
      (let [release (io/file stage "apps/tui-rs/target/release")]
        (.mkdirs release)
        (spit (io/file release "qi-agent") "binary")
        (spit (io/file release "intermediate") "cache")
        (prune-build-stage! stage)
        (is (= ["qi-agent"]
               (->> (.listFiles release) (map #(.getName %)) sort vec))))
      (finally (delete-tree! root)))))

(deftest installer-migrates-the-legacy-in-app-profile-to-private-user-data
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-config-preservation-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        install-path (io/file root "installed")
        data-path (io/file root "user-data")
        template (io/file root "default-agent.edn")
        ensure! (var-get (ns-resolve 'qi.install 'ensure-user-profile!))]
    (try
      (.mkdirs install-path)
      (spit (io/file install-path "agent.edn") "{:provider :chatgpt}")
      (spit template "{:provider :openai}")

      (is (= :migrated (ensure! data-path install-path template false)))
      (is (= "{:provider :chatgpt}"
             (slurp (io/file data-path "agent.edn"))))

      (is (= :preserved (ensure! data-path install-path template false)))
      (is (= "{:provider :chatgpt}"
             (slurp (io/file data-path "agent.edn"))))

      (is (= :reset (ensure! data-path install-path template true)))
      (is (= "{:provider :openai}"
             (slurp (io/file data-path "agent.edn"))))
      (finally (delete-tree! root)))))

(defn- git-test! [directory & arguments]
  (-> (apply process/shell {:dir (str directory) :out :string :err :string}
             "git" arguments)
      :out
      str/trim))

(defn- write-test-file! [root path value]
  (let [file (io/file (str root) path)]
    (.mkdirs (.getParentFile file))
    (spit file value)
    file))

(defn- fake-release-build! [stage]
  (let [binary (write-test-file! stage
                                 "apps/tui-rs/target/release/qi-agent"
                                 "test-binary")]
    (.setExecutable binary true false)
    binary))

(deftest git-install-and-update-preserve-all-user-and-project-data
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-git-update-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        origin (io/file root "origin.git")
        source (io/file root "source")
        data (io/file root "home")
        installed (io/file data "app")
        bin (io/file root "bin")
        workspace (io/file root "workspace")
        install-options {:source-root (str source)
                         :repository (str "file://" origin)
                         :branch "main"
                         :install-dir (str installed)
                         :data-dir (str data)
                         :bin-dir (str bin)
                         :build-fn fake-release-build!
                         :validate-fn (constantly true)}]
    (try
      (.mkdirs source)
      (git-test! root "init" "--bare" (str origin))
      (git-test! source "init" "--initial-branch=main")
      (git-test! source "config" "user.name" "qì Agent Test")
      (git-test! source "config" "user.email" "test@qi-agent.invalid")
      (doseq [[path value]
              [[".gitignore" "target/\n"]
               ["bb.edn" "{:paths [\"src\" \"plugins\"]}\n"]
               ["agent.edn" "{:profile :default-v1}\n"]
               ["src/qi/install.clj" "(ns qi.install)\n"]
               ["src/qi/version.clj" "(def version 1)\n"]
               ["plugins/.keep" ""]
               ["presets/.keep" ""]
               ["apps/tui-rs/Cargo.toml" "[package]\nname='fixture'\nversion='0.1.0'\n"]]]
        (write-test-file! source path value))
      (git-test! source "add" ".")
      (git-test! source "commit" "-m" "initial")
      (git-test! source "remote" "add" "origin" (str origin))
      (git-test! source "push" "-u" "origin" "main")

      (install/install! install-options)
      (is (.isDirectory (io/file installed ".git")))
      (is (= "{:profile :default-v1}\n"
             (slurp (io/file data "agent.edn"))))
      (is (str/includes? (slurp (io/file bin "qi-agent"))
                         "--config \"$QI_AGENT_HOME/agent.edn\""))

      (spit (io/file data "agent.edn") "{:profile :personal}\n")
      (write-test-file! data "memories/MEMORY.md" "remember-me\n")
      (write-test-file! data "trust.edn" "{:roots {\"/workspace\" :allow}}\n")
      (write-test-file! data "state/supervisor.sqlite" "database-sentinel")
      (write-test-file! data "web/providers.json" "provider-sentinel")
      (write-test-file! workspace ".qi-agent/sessions/history.jsonl"
                        "conversation-sentinel\n")

      (write-test-file! source "agent.edn" "{:profile :default-v2}\n")
      (write-test-file! source "src/qi/version.clj" "(def version 2)\n")
      (git-test! source "add" ".")
      (git-test! source "commit" "-m" "update")
      (git-test! source "push" "origin" "main")

      (let [result (install/update! (dissoc install-options :source-root))]
        (is (true? (:updated result)))
        (is (not= (:previous result) (:current result))))
      (is (= "(def version 2)\n"
             (slurp (io/file installed "src/qi/version.clj"))))
      (is (= "{:profile :default-v2}\n"
             (slurp (io/file installed "agent.edn"))))
      (is (= "{:profile :personal}\n" (slurp (io/file data "agent.edn"))))
      (is (= "remember-me\n" (slurp (io/file data "memories/MEMORY.md"))))
      (is (= "{:roots {\"/workspace\" :allow}}\n"
             (slurp (io/file data "trust.edn"))))
      (is (= "database-sentinel"
             (slurp (io/file data "state/supervisor.sqlite"))))
      (is (= "provider-sentinel" (slurp (io/file data "web/providers.json"))))
      (is (= "conversation-sentinel\n"
             (slurp (io/file workspace ".qi-agent/sessions/history.jsonl"))))
      (is (str/blank? (git-test! installed "status" "--porcelain"
                                  "--untracked-files=all")))

      (let [result (install/update! (assoc (dissoc install-options :source-root)
                                           :check true))]
        (is (false? (:available result)))
        (is (false? (:updated result))))

      (write-test-file! source "src/qi/version.clj" "(def version 3)\n")
      (git-test! source "add" ".")
      (git-test! source "commit" "-m" "broken-build-candidate")
      (git-test! source "push" "origin" "main")
      (let [error (try
                    (install/update!
                     (assoc (dissoc install-options :source-root)
                            :build-fn
                            (fn [_]
                              (throw (ex-info "simulated build failure" {})))))
                    nil
                    (catch Throwable value value))]
        (is (some? error))
        (is (= "simulated build failure" (ex-message error))))
      (is (= "(def version 2)\n"
             (slurp (io/file installed "src/qi/version.clj"))))
      (is (= "{:profile :personal}\n" (slurp (io/file data "agent.edn"))))
      (is (= "conversation-sentinel\n"
             (slurp (io/file workspace ".qi-agent/sessions/history.jsonl"))))

      (let [result (install/update! (dissoc install-options :source-root))]
        (is (true? (:updated result))))
      (is (= "(def version 3)\n"
             (slurp (io/file installed "src/qi/version.clj"))))

      (spit (io/file installed "src/qi/version.clj") "local-edit\n")
      (let [error (try
                    (install/update! (dissoc install-options :source-root))
                    nil
                    (catch Throwable value value))]
        (is (some? error))
        (is (str/includes? (ex-message error) "local changes")))
      (is (= "{:profile :personal}\n" (slurp (io/file data "agent.edn"))))
      (is (= "conversation-sentinel\n"
             (slurp (io/file workspace ".qi-agent/sessions/history.jsonl"))))
      (finally (delete-tree! root)))))

(deftest reversible-kernel-effects
  (let [ctx (kernel/create-context)
        plugin-ctx (kernel/plugin-context ctx :test/plugin)
        seen (atom [])]
    (kernel/register-service! plugin-ctx :demo/value 42)
    (kernel/register-tool! plugin-ctx
                           {:name "demo"
                            :description "demo"
                            :parameters {:type "object"}
                            :execute (fn [_ _] {:ok true})})
    (kernel/on! plugin-ctx :demo/event
                (fn [_ event] (swap! seen conj event)))
    (is (= 42 (kernel/service ctx :demo/value)))
    (is (= ["demo"] (mapv :name (kernel/tools ctx))))
    (kernel/emit! ctx :demo/event {:value 1})
    (is (= [{:value 1}] @seen))
    (kernel/dispose-plugin! ctx :test/plugin)
    (is (nil? (kernel/service ctx :demo/value)))
    (is (empty? (kernel/tools ctx)))
    (kernel/emit! ctx :demo/event {:value 2})
    (is (= [{:value 1}] @seen))))

(defn- tui-test-context []
  (plugin/boot!
   {:plugins
    [{:ns 'qi.plugins.session}
     {:ns 'qi.plugins.mock :config {:responses []}}
     {:ns 'qi.plugins.runtime}
     {:ns 'qi.plugins.tui}]}))

(deftest rpc-mode-removes-console-streaming
  (let [profile {:plugins [{:ns 'qi.plugins.session}
                           {:ns 'qi.plugins.stream-console}]}
        for-mode (var-get #'cli/for-mode)]
    (is (= ['qi.plugins.session]
           (mapv :ns (:plugins (for-mode profile :rpc)))))))

(deftest remote-model-command-results-are-json-safe
  (let [sanitize (var-get #'remote-api/public-command-result)
        generate (fn [_] {:message {:role "assistant" :content "unused"}})
        result (sanitize
                "model"
                {:handled true
                 :ui :model-selector
                 :output {:current {:id :one :model "one" :generate generate}
                          :providers [{:id :one :model "one"
                                       :generate generate}]}})
        encoded (json/generate-string result)]
    (is (string? encoded))
    (is (nil? (get-in result [:output :current :generate])))
    (is (nil? (get-in result [:output :providers 0 :generate])))))

(deftest tui-prompts-for-an-undecided-project-before-tool-use
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-trust-prompt-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        trust-file (io/file directory "user" "trust.edn")
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock :config {:responses []}}
               {:ns 'qi.plugins.runtime}
               {:ns 'qi.plugins.trust
                :config {:root (str directory)
                         :trust-file (str trust-file)}}
               {:ns 'qi.plugins.tui}]})]
    (try
      (let [service (kernel/require-service ctx :ui/extensions)
            registries (:registries service)
            state (tui/initial-state ctx {} registries)
            trust-service (kernel/require-service ctx :project/trust)]
        (is (= "Trust this project?" (get-in state [:overlay :title])))
        (is (= :deny
               (get-in state [:overlay :items
                              (get-in state [:overlay :selected]) :value])))
        (is (false? ((:trusted? trust-service))))
        (is (:overlay (tui/handle-key ctx state :escape nil)))
        (is (false? (:running? (tui/handle-key ctx state :ctrl-c nil))))
        (is (false? (:explicit?
                     (trust/decision-info directory (str trust-file)))))
        (let [allowed (tui/handle-key
                       ctx (tui/handle-key ctx state :up nil) :enter nil)]
          (is (nil? (:overlay allowed)))
          (is ((:trusted? trust-service)))
          (is (= {:decision :allow :explicit? true}
                 (select-keys (trust/decision-info
                               directory (str trust-file))
                              [:decision :explicit?])))
          ;; The saved decision prevents the startup choice from reopening.
          (is (nil? (:overlay
                     (tui/initial-state ctx {} registries))))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest shared-command-dispatch-and-tui-editor
  (let [ctx (tui-test-context)]
    (try
      (let [plugin-ctx (kernel/plugin-context ctx :test/command)]
        (kernel/register-command!
         plugin-ctx
         {:name "hello" :description "test"
          :execute (fn [argument _] (str "hello " argument))})
        (is (= "hello world"
               (:output (command/dispatch! ctx "/hello world"))))
        (is (some #(= "hello" (:name %)) (command/commands ctx))))
      (let [editor (-> (tui/make-editor)
                       (tui/editor-insert "alpha")
                       (tui/editor-insert "\nβeta"))]
        (is (= "alpha\nβeta" (:text editor)))
        (is (= 10 (:cursor editor)))
        (is (= 4 (:cursor (tui/editor-vertical editor :up))))
        (is (= "alpha\nβet" (:text (tui/editor-backspace editor)))))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :width 60 :height 14
                         :editor (tui/make-editor "two\nlines"))
            rendered (tui/render-screen state)]
        (is (= 14 (count rendered)))
        (is (some #(str/includes? % "qì agent") rendered))
        (is (some #(str/includes? % "two") rendered)))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :editor (tui/make-editor "/th"))
            completed (tui/handle-key ctx state :tab nil)]
        (is (= "Commands" (get-in completed [:overlay :title])))
        (is (some #(= "/theme " (:value %))
                  (get-in completed [:overlay :items]))))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :agent-state {:phase :model
                                       :partial-assistant "**streaming** now"})]
        (is (some #(str/includes? (tui/strip-ansi %) "Assistant · live")
                  (tui/transcript-lines state 60))))
      (let [service (kernel/require-service ctx :ui/extensions)
            base (tui/replace-session-events
                  (tui/initial-state ctx {} (:registries service))
                  [{:type "tool/call"
                    :data {:name "bash" :call-id "live-1"
                           :arguments {:command "echo ok"}}}])
            updated (tui/update-state
                     ctx base
                     {:type :tool-update
                      :event {:call-id "live-1" :name "bash"
                              :update {:stream :stdout :chunk "ok\n"}}}
                     (:registries service))]
        (is (some #(str/includes? (tui/strip-ansi %) "running")
                  (tui/transcript-lines updated 60))))
      (let [catalog-ctx (kernel/plugin-context ctx :test/catalog)]
        (let [refresh-count (atom 0)]
        (kernel/register-service!
         catalog-ctx :session/catalog
         {:list (fn [] [{:name "picked" :path "/tmp/picked.jsonl"
                         :message-count 3}])
          :refresh! #(swap! refresh-count inc)})
        (let [service (kernel/require-service ctx :ui/extensions)
              state (assoc (tui/initial-state ctx {} (:registries service))
                           :editor (tui/make-editor "/sessions"))
              selector (tui/handle-key ctx state :enter nil)
              selected (tui/handle-key ctx selector :enter nil)]
          (is (= "/tmp/picked.jsonl" (:next-session selected)))
          (is (false? (:running? selected)))
          (is (= 1 @refresh-count)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest tui-editor-layout-and-transcript-regressions
  (let [ctx (tui-test-context)
        service (kernel/require-service ctx :ui/extensions)
        registries (:registries service)]
    (try
      (testing "editing operates on graphemes and visual columns"
        (is (= {:text "A😀" :cursor 3}
               (tui/editor-backspace (tui/make-editor "A😀é"))))
        (is (= {:text "A" :cursor 1}
               (-> (tui/make-editor "A😀é")
                   tui/editor-backspace
                   tui/editor-backspace)))
        (is (= 7
               (:cursor (tui/editor-vertical
                         {:text "中文\nabcdef" :cursor 2} :down)))))
      (testing "history restores the draft that existed before browsing"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :history ["old prompt"]
                           :editor (tui/make-editor "draft"))
              recalled (tui/handle-key ctx state :up nil)
              restored (tui/handle-key ctx recalled :down nil)]
          (is (= "old prompt" (get-in recalled [:editor :text])))
          (is (= (tui/make-editor "draft") (:editor restored)))))
      (testing "completion preserves suffixes and places the cursor at insertion"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :editor {:text "/thX" :cursor 3})
              overlay (tui/handle-key ctx state :tab nil)
              completed (tui/handle-key ctx overlay :enter nil)]
          (is (= "/theme X" (get-in completed [:editor :text])))
          (is (= 7 (get-in completed [:editor :cursor])))))
      (testing "editor and large selectors remain inside the terminal"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :width 40 :height 10
                           :editor (tui/make-editor
                                    (str/join "\n" (repeat 30 "line"))))]
          (is (= 10 (count (tui/render-screen state)))))
        (let [state (tui/update-state
                     ctx (assoc (tui/initial-state ctx {} registries)
                                :width 40 :height 10)
                     {:type :ui-request :kind :select :result (promise)
                      :request {:title "Many"
                                :items (mapv #(hash-map :label (str "Item " %)
                                                       :value %)
                                             (range 20))}}
                     registries)
              state (assoc-in state [:overlay :selected] 18)
              rendered (map tui/strip-ansi (tui/render-screen state))]
          (is (= 10 (count rendered)))
          (is (some #(str/includes? % "Item 18") rendered))))
      (testing "transcript scroll supports pages, mouse wheels, and live updates"
        (let [events (mapv (fn [index]
                             {:type "message"
                              :data {:message {:role "user"
                                               :content (str "history-" index)}}})
                           (range 30))
              state (assoc (tui/replace-session-events
                            (tui/initial-state ctx {} registries)
                            events)
                           :width 60 :height 12)
              scrolled (tui/handle-key ctx state :page-up nil)
              visible-history
              (fn [value]
                (set (re-seq #"history-\d+"
                             (str/join "\n"
                                       (map tui/strip-ansi
                                            (tui/render-screen value))))))
              before-update (visible-history scrolled)
              appended (tui/update-state
                        ctx scrolled
                        {:type :session-event
                         :event {:type "message"
                                 :data {:message {:role "user"
                                                  :content "history-30"}}}}
                        registries)]
          (is (pos? (:scroll scrolled)))
          (is (seq before-update))
          (is (= before-update (visible-history appended)))
          (is (> (:scroll appended) (:scroll scrolled)))
          (is (some #(str/includes? (tui/strip-ansi %) "history ↑")
                    (tui/render-screen appended)))
          (is (= :page-up (tui/mouse-wheel-key "[<64;20;8M")))
          (is (= :page-down (tui/mouse-wheel-key "[<65;20;8M")))
          (let [at-bottom (nth (iterate #(tui/handle-key
                                         ctx % :page-down nil)
                                        appended)
                               20)]
            (is (zero? (:scroll at-bottom)))
            (is (contains? (visible-history at-bottom) "history-30")))))
      (testing "clear/compaction projection matches the model-visible context"
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "message"
                       :data {:message {:role "user" :content "old"}}}
                      {:type "session/clear" :data {}}
                      {:type "message"
                       :data {:message {:role "user" :content "new"}}}])
              lines (str/join "\n" (map tui/strip-ansi
                                          (tui/transcript-lines state 60)))]
          (is (not (str/includes? lines "old")))
          (is (str/includes? lines "new")))
        (let [state (-> (tui/initial-state ctx {} registries)
                        (tui/replace-session-events
                         [{:type "message"
                           :data {:message {:role "user"
                                            :content "stale"}}}])
                        (assoc :editor (tui/make-editor "/clear")))
              cleared (tui/handle-key ctx state :enter nil)
              lines (str/join "\n" (map tui/strip-ansi
                                          (tui/transcript-lines cleared 60)))]
          (is (not (str/includes? lines "stale")))
          (is (some #(= "session/clear" (:type %)) (:events cleared)))))
      (testing "durable results release live tool buffers and queue is visible"
        (let [base (assoc (tui/initial-state ctx {} registries)
                          :live-tools {"call" {:updates [{:chunk "x"}]}})
              ended (tui/update-state
                     ctx base
                     {:type :session-event
                      :event {:type "tool/result"
                              :data {:call-id "call" :name "demo"
                                     :ok true :content "ok"}}}
                     registries)
              queued (tui/update-state
                      ctx ended
                      {:type :queue-update
                       :queue [{:kind :follow-up :message "later"}]}
                      registries)]
          (is (empty? (:live-tools ended)))
          (is (some #(str/includes? (tui/strip-ansi %) "follow-up: later")
                    (tui/render-screen queued)))))
      (testing "a tool call and result render as one informative execution card"
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call" :at "2026-08-16T00:00:00Z"
                       :data {:name "demo" :call-id "one"
                              :arguments {:value 42}}}
                      {:type "tool/result" :at "2026-08-16T00:00:00.017Z"
                       :data {:name "demo" :call-id "one" :ok true
                              :content "answer: 42"}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 60))]
          (is (= 1 (count (filter #(re-find #"^[◆✓✗] demo" %) lines))))
          (is (some #(= "✓ demo · done · 17 ms" %) lines))
          (is (some #(str/includes? % "args: {:value 42}") lines))
          (is (some #(str/includes? % "result: answer: 42") lines)))
        (let [base (tui/replace-session-events
                    (tui/initial-state ctx {} registries)
                    [{:type "tool/call"
                      :data {:name "demo" :call-id "live"
                             :arguments {:value 1}}}])
              ended (tui/update-state
                     ctx base
                     {:type :tool-end
                      :event {:name "demo" :call-id "live" :ok false
                              :error "boom" :content "boom"
                              :duration-ms 9}}
                     registries)
              lines (mapv tui/strip-ansi (tui/transcript-lines ended 60))]
          (is (= 1 (count (filter #(re-find #"^[◆✓✗] demo" %) lines))))
          (is (some #(= "✗ demo · error · 9 ms" %) lines))
          (is (some #(str/includes? % "error: boom") lines)))
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call"
                       :data {:name "bash" :call-id "bash-1"
                              :arguments {:command "printf hello"
                                          :cwd "src"}}}
                      {:type "tool/result"
                       :data {:name "bash" :call-id "bash-1" :ok true
                              :duration-ms 5
                              :details {:exit-code 0 :stdout-chars 5
                                        :stderr-chars 0 :truncated false}
                              :content "exit 0\nstdout:\nhello"}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 80))]
          (is (some #(= "✓ bash · exit 0 · 5 ms" %) lines))
          (is (some #(str/includes? % "command: $ printf hello · cwd src")
                    lines))
          (is (some #(str/includes? % "output: exit 0 · stdout 5 chars")
                    lines)))
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call"
                       :data {:name "read" :call-id "read-1"
                              :arguments {:path "README.md" :limit 20}}}
                      {:type "tool/result"
                       :data {:name "read" :call-id "read-1" :ok true
                              :duration-ms 2 :content "hello\nworld"
                              :details {:path "README.md" :offset 0
                                        :line-count 2 :total-lines 40
                                        :size 500 :truncated true}}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 80))]
          (is (some #(str/includes? % "file: README.md · 20 lines") lines))
          (is (some #(str/includes?
                      % "preview: lines 1-2/40 · 500 chars · more available")
                    lines))))
      (testing "durable entry rendering is reused across live updates"
        (let [render-count (atom 0)
              cached-registries
              (fn []
                (assoc-in (registries) [:message-renderers :user]
                          (fn [message _]
                            (swap! render-count inc)
                            [(str "cached " (:content message))])))
              events (conj
                      (mapv (fn [index]
                              {:id (str "cache-" index)
                               :type "message"
                               :data {:message {:role "user"
                                                :content (str index)}}})
                            (range 1000))
                      {:id "cache-tool" :type "tool/call"
                       :data {:name "bash" :call-id "cache-live"
                              :arguments {:command "echo ok"}}})
              loaded (tui/replace-session-events
                      (tui/initial-state ctx {} cached-registries) events)
              updated (tui/update-state
                       ctx loaded
                       {:type :tool-update
                        :event {:call-id "cache-live" :name "bash"
                                :update {:stream :stdout :chunk "ok"}}}
                       cached-registries)
              after-live-count @render-count
              appended (tui/update-state
                        ctx updated
                        {:type :session-event
                         :event {:id "cache-new" :type "message"
                                 :data {:message {:role "user"
                                                  :content "new"}}}}
                        cached-registries)]
          (is (= 1000 after-live-count))
          (is (= 1003 (count (tui/transcript-lines updated 80))))
          (is (= 1001 @render-count))
          (is (some #(str/includes? (tui/strip-ansi %) "cached new")
                    (tui/transcript-lines appended 80)))))
      (testing "idle Ctrl+C requires a deliberate second press"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :editor (tui/make-editor "discard me"))
              first-press (tui/handle-key ctx state :ctrl-c nil)
              second-press (tui/handle-key ctx first-press :ctrl-c nil)]
          (is (:running? first-press))
          (is (= "" (get-in first-press [:editor :text])))
          (is (false? (:running? second-press)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest tui-streaming-submit-matches-pi-steer-and-follow-up-semantics
  (let [ctx (kernel/create-context)
        plugin-ctx (kernel/plugin-context ctx :test/tui-submit)
        calls (atom [])]
    (try
      (kernel/register-service!
       plugin-ctx :agent/session
       {:steer! #(swap! calls conj [:steer %])
        :follow-up! #(swap! calls conj [:follow-up %])
        :abort! (fn [] false)})
      (let [state {:editor (tui/make-editor "now")
                   :agent-state {:phase :model}
                   :registries {:shortcuts {}}
                   :history [] :notifications [] :running? true}
            after-steer (tui/handle-key ctx state :enter nil)
            after-follow-up (tui/handle-key
                             ctx (assoc after-steer
                                        :editor (tui/make-editor "later"))
                             :alt-enter nil)]
        (is (= [[:steer "now"] [:follow-up "later"]] @calls))
        (is (= ["now" "later"] (:history after-follow-up))))
      (finally (kernel/dispose-all! ctx)))))

(deftest reversible-ui-extension-registry-and-overlay
  (let [ctx (tui-test-context)
        extension-ctx (kernel/plugin-context ctx :test/ui-extension)
        service (kernel/require-service ctx :ui/extensions)]
    (try
      (is (= "The TUI prompt service is not active"
             (try
               ((:select! (kernel/require-service ctx :ui/prompt))
                {:title "inactive" :items []})
               nil
               (catch Throwable error (ex-message error)))))
      (ui/register-message-renderer! extension-ctx :demo
                                     (fn [_ _] ["demo"]))
      (ui/register-tool-renderer! extension-ctx "demo_tool"
                                  (fn [_ _] ["tool"]))
      (ui/register-shortcut! extension-ctx "ctrl+g"
                             {:description "demo" :handler (fn [_])})
      (ui/set-status! extension-ctx :demo "ready")
      (ui/set-widget! extension-ctx :demo ["widget"])
      (let [registries (:registries ((:snapshot service)))]
        (is (contains? (:message-renderers registries) :demo))
        (is (contains? (:tool-renderers registries) "demo_tool"))
        (is (contains? (:shortcuts registries) "ctrl+g"))
        (is (= "ready" (get-in registries [:statuses :demo :value])))
        (is (contains? (:widgets registries) :demo)))
      (let [override-ctx (kernel/plugin-context ctx :test/ui-override)]
        (ui/set-status! override-ctx :demo "override")
        (is (= "override"
               (get-in ((:registries service)) [:statuses :demo :value])))
        (kernel/dispose-plugin! ctx :test/ui-override)
        (is (= "ready"
               (get-in ((:registries service)) [:statuses :demo :value]))))
      (let [state (tui/initial-state ctx {} (:registries service))
            result (promise)
            with-overlay
            (tui/update-state
             ctx state
             {:type :ui-request :kind :select :result result
              :request {:title "Pick"
                        :items [{:label "A" :value :a}
                                {:label "B" :value :b}]}}
             (:registries service))
            moved (tui/handle-key ctx with-overlay :down nil)
            selected (tui/handle-key ctx moved :enter nil)]
        (is (nil? (:overlay selected)))
        (is (= :b (deref result 100 :timeout))))
      (let [state (tui/initial-state ctx {} (:registries service))
            result (promise)
            with-overlay
            (tui/update-state
             ctx state
             {:type :ui-request :kind :custom :result result
              :request {:title "Counter" :model 0
                        :view (fn [model] [(str "Count " model)])
                        :update (fn [model {:keys [key]}]
                                  (if (= key :enter)
                                    {:model model :done? true :value model}
                                    {:model (inc model)}))}}
             (:registries service))
            incremented (tui/handle-key ctx with-overlay :right nil)
            selected (tui/handle-key ctx incremented :enter nil)]
        (is (nil? (:overlay selected)))
        (is (= 1 (deref result 100 :timeout))))
      (kernel/dispose-plugin! ctx :test/ui-extension)
      (let [registries (:registries ((:snapshot service)))]
        (is (empty? (:message-renderers registries)))
        (is (empty? (:tool-renderers registries)))
        (is (empty? (:shortcuts registries)))
        (is (empty? (:statuses registries)))
        (is (empty? (:widgets registries))))
      (finally (kernel/dispose-all! ctx)))))

(deftest model-rendering-and-live-tool-lifecycle-are-independent
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config
                {:responses
                 [{:message
                   {:role "assistant"
                    :tool_calls
                    [{:id "render-1" :type "function"
                      :function {:name "dual_render"
                                 :arguments "{\"value\":42}"}}]}
                   :finish-reason "tool_calls"}
                  {:message {:role "assistant" :content "done"}
                   :finish-reason "stop"}]}}
               {:ns 'qi.plugins.runtime}]})
        extension-ctx (kernel/plugin-context ctx :test/dual-render)
        lifecycle (atom [])
        started (atom [])
        ended (atom [])]
    (try
      (kernel/register-tool!
       extension-ctx
       {:name "dual_render"
        :description "dual renderer test"
        :parameters {:type "object" :required ["value"]
                     :properties {"value" {:type "integer"}}
                     :additionalProperties false}
        :execute (fn [{:keys [value]} _]
                   (swap! lifecycle conj :body)
                   {:value value})
        :render-model (fn [_ value] (str "model:" (:value value)))
        :render-tui (fn [_ _] ["visual-only"])})
      (kernel/on! extension-ctx :tool.execution/start
                  (fn [_ event]
                    (swap! lifecycle conj :start)
                    (swap! started conj event)))
      (kernel/on! extension-ctx :tool.execution/end
                  (fn [_ event] (swap! ended conj event)))
      ((kernel/require-service ctx :agent/run) "go")
      (is (= "model:42"
             (:content (last (filter #(= "tool" (:role %))
                                     ((:messages
                                       (kernel/require-service
                                        ctx :session/store))))))))
      (is (= {:value 42} (:value (first @ended))))
      (is (:ok (first @ended)))
      (is (= [:start :body] @lifecycle))
      (is (= "render-1" (:call-id (first @started))))
      (is (= "dual_render" (:name (first @started))))
      (is (string? (:execution-id (first @started))))
      (is (pos-int? (:started-at (first @started))))
      (finally (kernel/dispose-all! ctx)))))

(deftest approval-can-use-a-tui-prompt-service
  (let [ctx (kernel/create-context)
        prompt-ctx (kernel/plugin-context ctx :test/prompt)
        requests (atom [])]
    (try
      (kernel/register-service!
       prompt-ctx :ui/prompt
       {:select! (fn [request]
                   (swap! requests conj request)
                   :allow-session)})
      (plugin/load-plugin! ctx {:ns 'qi.plugins.approval
                                :config {:mode :ask}})
      (let [approve (kernel/require-service ctx :approval/request)]
        (is (= :allow (approve {:tool "write" :arguments {:path "a"}})))
        (is (= 1 (count @requests)))
        ;; The session grant is cached and does not reopen the overlay.
        (is (= :allow (approve {:tool "write" :arguments {:path "a"}})))
        (is (= 1 (count @requests))))
      (finally (kernel/dispose-all! ctx)))))

(deftest schema-boundary-validation
  (let [tool-schema {:type "object"
                     :required ["operation" "a"]
                     :properties {"operation" {:type "string"
                                                :enum ["add"]}
                                  "a" {:type "number"}}
                     :additionalProperties false}]
    (is (empty? (schema/errors tool-schema
                               {:operation "add" :a 2})))
    (is (= #{"$.a is required"
             "$.extra is not allowed"
             "$.operation must be one of [\"add\"]"}
           (set (schema/errors tool-schema
                               {:operation "delete" :extra true}))))))

(deftest babashka-repl-backend-is-persistent
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-repl-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.bb-repl
                :config {:root (str directory) :sandbox :none
                         :timeout-ms 5000}}
               {:ns 'qi.plugins.clojure-repl}]})]
    (try
      (let [repl (kernel/require-service ctx :execution/repl)
            define-result ((:eval! repl) "(def answer 41)")
            use-result ((:eval! repl)
                        "(do (println \"from-bb\") (inc answer))")
            tool (kernel/tool ctx "bb_repl")]
        (is (:ok define-result))
        (is (= "42" (:value use-result)))
        (is (= "from-bb\n" (:stdout use-result)))
        (is (= :babashka (:backend repl)))
        (is (= "bb_repl" (:name tool)))
        (is (empty? (schema/errors (:output-schema tool) use-result))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest interrupted-repl-cleanup-cannot-discard-the-next-evaluation
  (let [directory (fs/create-temp-dir {:prefix "qi-repl-interrupt-"})
        marker (fs/path directory "started")
        ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.bb-repl
                         :config {:root (str directory) :sandbox :none
                                  :timeout-ms 10000}}]})
        repl (kernel/require-service ctx :execution/repl)
        stop-var (ns-resolve 'qi.plugins.bb-repl 'stop-worker!)
        stop-worker! @stop-var
        intercepted? (atom false)
        killed (promise)
        release-cleanup (promise)]
    (try
      (with-redefs-fn
        {stop-var (fn [worker]
                    (if (compare-and-set! intercepted? false true)
                      (do (stop-worker! worker)
                          (deliver killed true)
                          (deref release-cleanup 5000 nil))
                      (stop-worker! worker)))}
        (fn []
          (let [running (future ((:eval! repl)
                                 (str "(do (spit " (pr-str (str marker))
                                      " \"started\") (Thread/sleep 8000))")))]
            (loop [remaining 300]
              (when (and (pos? remaining) (not (fs/exists? marker)))
                (Thread/sleep 10)
                (recur (dec remaining))))
            (is (fs/exists? marker) "the first evaluation reached its blocking operation")
            (let [interrupt (future ((:interrupt! repl) nil))]
              (is (= true (deref killed 5000 ::timeout)))
              (is (= false (:ok (deref running 5000 {}))))
              ;; Keep the interrupt's cleanup open after the old eval has
              ;; returned, then try to enter a new evaluation concurrently.
              (let [entering (promise)
                    next-eval (future (deliver entering true)
                                      ((:eval! repl) "(def survivor 42)"))]
                (is (= true (deref entering 5000 ::timeout)))
                (is (= ::waiting (deref next-eval 100 ::waiting)))
                (deliver release-cleanup true)
                (is (= true (deref interrupt 5000 ::timeout)))
                (is (= true (:ok (deref next-eval 5000 {}))))
                (is (= "42" (:value ((:eval! repl) "survivor")))))))))
      (is (= {:closed true} ((:close! repl))))
      (is (= :closed (:status ((:status repl)))))
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"REPL is closed"
                            ((:eval! repl) "42")))
      (finally
        (deliver release-cleanup true)
        (kernel/dispose-all! ctx)
        (fs/delete-tree directory)))))

(deftest jvm-clojure-repl-builds-an-isolated-project-classpath
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-jvm-repl-project-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        writable (io/file directory ".qi-agent" "sandbox" "agent-jvm")
        prepare! (ns-resolve 'qi.plugins.bb-repl 'prepare-jvm-project!)
        command-for (ns-resolve 'qi.plugins.bb-repl 'worker-command)]
    (try
      (.mkdirs (io/file directory "src"))
      (.mkdirs (io/file directory "test"))
      (.mkdirs writable)
      (spit (io/file directory "deps.edn")
            (pr-str {:paths ["src"]
                     :deps {'example/local {:local/root "../shared"}}
                     :aliases {:test {:extra-paths ["test"]}}}))
      (prepare! {:root (.getCanonicalPath directory)
                 :writable-root (.getCanonicalPath writable)})
      (let [generated (edn/read-string (slurp (io/file writable "deps.edn")))
            root (.getCanonicalPath directory)]
        (is (some #{(str (io/file root "src"))} (:paths generated)))
        (is (= (str (io/file root ".." "shared"))
               (get-in generated [:deps 'example/local :local/root])))
        (is (= [(str (io/file root "test"))]
               (get-in generated [:aliases :test :extra-paths]))))
      (is (= ["/opt/bin/clojure" "-Srepro" "-M" "-m"
              "qi.repl-worker"]
             (command-for {:backend :jvm-clojure
                           :command "/opt/bin/clojure"
                           :sandbox :none})))
      (finally
        (delete-tree! directory)))))

(deftest per-agent-backend-selection-preserves-explicit-child-overrides
  (let [resolve-backend (ns-resolve 'qi.plugins.bb-repl 'resolve-backend)]
    (is (= :jvm-clojure
           (resolve-backend {} :babashka "jvm-clojure")))
    (is (= :babashka
           (resolve-backend {:backend :babashka}
                            :babashka
                            "jvm-clojure")))))

(deftest jvm-clojure-repl-reports-a-missing-runtime
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-jvm-repl-missing-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))]
    (try
      (try
        (plugin/boot!
         {:plugins
          [{:ns 'qi.plugins.jvm-clojure-repl
            :config {:root (str directory)
                     :command "qi-agent-test-missing-clojure-runtime"
                     :sandbox :none}}]})
        (is false "missing JVM Clojure runtime should reject the profile")
        (catch clojure.lang.ExceptionInfo error
          (is (str/includes? (ex-message error)
                             "JVM Clojure command was not found"))
          (is (= :jvm-clojure (:backend (ex-data error))))))
      (finally
        (delete-tree! directory)))))

(deftest jvm-clojure-repl-provider-speaks-the-shared-worker-protocol
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-jvm-repl-protocol-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        launcher (io/file directory "test-clojure-launcher")
        shell-quote (fn [value]
                      (str "'" (str/replace (str value) "'" "'\"'\"'") "'"))
        classpath (->> (str/split (System/getProperty "java.class.path")
                                  (re-pattern
                                   (java.util.regex.Pattern/quote
                                    (System/getProperty "path.separator"))))
                       (map #(str (fs/absolutize %)))
                       (str/join (System/getProperty "path.separator")))]
    (try
      (spit launcher
            (str "#!/bin/sh\nexec " (shell-quote (fs/which "bb"))
                 " -cp " (shell-quote classpath)
                 " -m qi.repl-worker\n"))
      (.setExecutable launcher true)
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.jvm-clojure-repl
                    :config {:root (str directory)
                             :command (.getCanonicalPath launcher)
                             :sandbox :none
                             :aliases [:dev]
                             :timeout-ms 5000}}]})]
        (try
          (let [repl (kernel/require-service ctx :execution/repl)]
            (is (:ok ((:eval! repl) "(def answer 41)")))
            (is (= "42" (:value ((:eval! repl) "(inc answer)"))))
            (is (= "jvm-clojure-repl"
                   (:backend ((:eval! repl) "answer"))))
            (is (= :jvm-clojure (:backend ((:describe repl)))))
            (is (= [:dev] (:aliases ((:describe repl)))))
            (is (.isFile (io/file directory ".qi-agent" "sandbox"
                                  "ephemeral" "deps.edn"))))
          (finally
            (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! directory)))))

(deftest jvm-clojure-repl-backend-is-persistent-when-installed
  (if-let [clojure-command (fs/which "clojure")]
    (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                              "qi-agent-jvm-repl-"
                              (make-array java.nio.file.attribute.FileAttribute
                                          0)))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.jvm-clojure-repl
                  :config {:root (str directory)
                           :command (str clojure-command)
                           :sandbox :none
                           :timeout-ms 30000}}
                 {:ns 'qi.plugins.clojure-repl}]})]
      (try
        (let [repl (kernel/require-service ctx :execution/repl)
              define-result ((:eval! repl) "(def answer 41)")
              use-result ((:eval! repl)
                          "(do (println (System/getProperty \"java.vm.name\")) (inc answer))")
              tool (kernel/tool ctx "bb_repl")]
          (is (:ok define-result))
          (is (= "42" (:value use-result)))
          (is (str/includes? (:stdout use-result) "VM"))
          (is (= "jvm-clojure-repl" (:backend use-result)))
          (is (= :jvm-clojure (:backend repl)))
          (is (str/includes? (:description tool) "native JVM Clojure")))
        (finally
          (kernel/dispose-all! ctx)
          (delete-tree! directory))))
    (is true "native JVM integration test requires the clojure CLI")))

(deftest babashka-repl-replays-only-explicit-safe-cells
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-repl-recovery-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        session-path (str (io/file directory "session.jsonl"))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session :config {:path session-path}}
               {:ns 'qi.plugins.durable-state
                :config {:root (str directory) :agent-id "agent-recovery"}}
               {:ns 'qi.plugins.bb-repl
                :config {:root (str directory) :sandbox :none
                         :agent-id "agent-recovery" :timeout-ms 5000}}]})]
    (try
      (let [repl (kernel/require-service ctx :execution/repl)
            durable (kernel/require-service ctx :agent/durable-state)]
        (is (:ok ((:eval! repl) {:code "(def answer 41)"
                                 :replay-safe true})))
        (is (:ok ((:eval! repl) "(def transient-value 99)")))
        ((:put! durable) :plan {:remaining ["tests"]})
        (is (= {:reset true
                :namespace "qi.agent.agent-recovery"
                :replayed-cells 1}
               ((:reset! repl) {})))
        (is (= "42" (:value ((:eval! repl) "(inc answer)"))))
        (is (= "nil" (:value ((:eval! repl)
                                "(resolve 'transient-value)"))))
        (is (= "{:remaining [\"tests\"]}"
               (:value ((:eval! repl) "(qi.state/get :plan)"))))
        (is (= "repl/restarted" (:type (last ((:events
                                                (kernel/require-service
                                                 ctx :session/store))))))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest babashka-repl-agent-namespaces-are-isolated
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-repl-isolation-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        boot (fn [agent-id]
               (plugin/boot!
                {:plugins
                 [{:ns 'qi.plugins.bb-repl
                   :config {:root (str directory) :sandbox :none
                            :agent-id agent-id :timeout-ms 5000}}]}))
        first-ctx (boot "agent-one")
        second-ctx (boot "agent-two")]
    (try
      (let [first-repl (kernel/require-service first-ctx :execution/repl)
            second-repl (kernel/require-service second-ctx :execution/repl)]
        (is (:ok ((:eval! first-repl) "(def local-value :first)")))
        (is (:ok ((:eval! second-repl) "(def local-value :second)")))
        (is (= ":first" (:value ((:eval! first-repl) "local-value"))))
        (is (= ":second" (:value ((:eval! second-repl) "local-value"))))
        (is (not= (:namespace first-repl) (:namespace second-repl))))
      (finally
        (kernel/dispose-all! first-ctx)
        (kernel/dispose-all! second-ctx)
        (delete-tree! directory)))))

(deftest seatbelt-repl-denies-workspace-writes-and-outside-reads
  (when (= "Mac OS X" (System/getProperty "os.name"))
    (let [root (.getCanonicalFile (java.io.File. "."))
          outside (java.io.File/createTempFile
                   "qi-agent-secret-" ".txt" (.getParentFile root))
          denied-name (str "sandbox-denied-" (random-uuid) ".txt")
          denied-file (java.io.File. root denied-name)
          writable-name (str ".qi-agent-repl-test-" (random-uuid))
          writable-file (java.io.File. root writable-name)]
      (try
        (spit outside "must-not-be-readable")
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'qi.plugins.bb-repl
                      :config {:root "."
                               :sandbox :seatbelt
                               :writable-dir writable-name
                               :timeout-ms 5000}}]})]
          (try
            (let [repl (kernel/require-service ctx :execution/repl)
                  write-result ((:eval! repl)
                                (str "(spit " (pr-str denied-name)
                                     " \"blocked\")"))
                  read-result ((:eval! repl)
                               (str "(slurp " (pr-str (str outside)) ")"))]
              (is (= :seatbelt (:sandbox repl)))
              (is (false? (:ok write-result)))
              (is (false? (.exists denied-file)))
              (is (false? (:ok read-result)))
              (is (not (.contains (str read-result)
                                  "must-not-be-readable"))))
            (finally
              (kernel/dispose-all! ctx))))
        (finally
          (.delete outside)
          (when (.exists denied-file) (.delete denied-file))
          (delete-tree! writable-file))))))

(deftest project-trust-and-approval-gate
  (testing "untrusted projects fail before approval"
    (let [ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.trust
                  :config {:trusted false}}
                 {:ns 'qi.plugins.approval
                  :config {:mode :allow}}
                 {:ns 'qi.plugins.policy
                  :config {:trusted-tools ["danger"]
                           :approval-tools ["danger"]}}]})]
      (try
        (let [result (kernel/waterfall
                      ctx :tool/pre-execute
                      {:execution {:name "danger" :arguments {}}}
                      #(assoc % :decision :allow))]
          (is (= :deny (:decision result)))
          (is (= (str "Tool requires a trusted project; "
                      "use /trust allow to enable it.")
                 (:reason result))))
        (finally (kernel/dispose-all! ctx)))))
  (testing "a configured deny approval is audited and enforced"
    (let [ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.trust
                  :config {:trusted true}}
                 {:ns 'qi.plugins.approval
                  :config {:mode :deny}}
                 {:ns 'qi.plugins.policy
                  :config {:approval-tools ["danger"]}}]})]
      (try
        (let [confirming (atom [])
              observer (kernel/plugin-context ctx :test/approval-confirming)
              _ (kernel/on! observer :tool.execution/confirming
                            (fn [_ event] (swap! confirming conj event)))
              result (kernel/waterfall
                      ctx :tool/pre-execute
                      {:execution {:name "danger"
                                   :call-id "call-1"
                                   :token "execution-1"
                                   :arguments {:value 1}}}
                      #(assoc % :decision :allow))
              events ((:events (kernel/require-service ctx :session/store)))]
          (is (= :deny (:decision result)))
          (is (= [{:execution-id "execution-1"
                   :call-id "call-1"
                   :name "danger"}]
                 @confirming))
          (is (some #(and (= "approval/decision" (:type %))
                          (= "call-1" (get-in % [:data :call-id]))
                          (= "danger" (get-in % [:data :name])))
                    events)))
        (finally (kernel/dispose-all! ctx))))))

(deftest cancellation-closes-a-blocked-stream
  (let [token (cancellation/create-token)
        input (java.io.PipedInputStream.)
        output (java.io.PipedOutputStream. input)
        task (future
               (try
                 (streaming/consume-sse! input token (fn [_]))
                 :completed
                 (catch Throwable error (ex-data error))))]
    (try
      (.write output (.getBytes "data: {\"value\":1}\n" "UTF-8"))
      (.flush output)
      (Thread/sleep 25)
      (is (true? (cancellation/cancel! token)))
      (is (= {:cancelled true} (deref task 1000 :timeout)))
      (finally
        (.close output)
        (.close input)))))

(deftest console-trace-shows-tool-process
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.trace
                :config {:enabled true :show-results true}}]})
        output (java.io.StringWriter.)]
    (try
      (binding [*err* output]
        (kernel/emit! ctx :session/event
                      {:type "tool/call"
                       :data {:name "bb_repl"
                              :arguments {:code "(+ 20 22)"}}})
        (kernel/emit! ctx :session/event
                      {:type "tool/result"
                       :data {:name "bb_repl"
                              :ok true
                              :content "value:\n42"}}))
      (let [text (str output)]
        (is (.contains text "→ tool bb_repl"))
        (is (.contains text "(+ 20 22)"))
        (is (.contains text "← tool bb_repl ok"))
        (is (.contains text "value:\n42")))
      (finally
        (kernel/dispose-all! ctx)))))

(defn- tool-loop-config [policy]
  {:plugins
   [{:ns 'qi.plugins.session}
    {:ns 'qi.plugins.mock
     :config
     {:responses
      [{:message
        {:role "assistant"
         :content nil
         :tool_calls
         [{:id "call-1"
           :type "function"
           :function {:name "calculate"
                      :arguments "{\"operation\":\"add\",\"a\":2,\"b\":3}"}}]}
        :finish-reason "tool_calls"
        :usage {:total_tokens 10}}
       {:message {:role "assistant" :content "The result is 5."}
        :finish-reason "stop"
        :usage {:total_tokens 4}}]}}
    {:ns 'example.math}
    {:ns 'qi.plugins.policy :config policy}
    {:ns 'qi.plugins.runtime
     :config {:system-prompt "test" :max-steps 3}}]})

(deftest offline-tool-calling-loop
  (let [ctx (plugin/boot! (tool-loop-config {}))]
    (try
      (let [result ((kernel/require-service ctx :agent/run) "Add two and three")
            role-sequence (mapv :role (:messages result))
            tool-message (first (filter #(= "tool" (:role %))
                                        (:messages result)))
            events ((:events (kernel/require-service ctx :session/store)))
            call-event (first (filter #(= "tool/call" (:type %)) events))
            result-event (first (filter #(= "tool/result" (:type %)) events))]
        (is (= "The result is 5." (:content result)))
        (is (= 2 (:steps result)))
        (is (= 14 (get-in result [:usage :total_tokens])))
        (is (= ["user" "assistant" "tool" "assistant"] role-sequence))
        (is (= {:result 5}
               (json/parse-string (:content tool-message) true)))
        (is (= {:operation "add" :a 2 :b 3}
               (get-in call-event [:data :arguments])))
        (is (= "{\"result\":5}" (get-in result-event [:data :content])))
        (is (contains? (:data result-event) :details))
        (is (nat-int? (get-in result-event [:data :duration-ms]))))
      (finally
        (kernel/dispose-all! ctx)))
    (is (empty? (kernel/loaded-plugins ctx)))
    (is (empty? (kernel/service-keys ctx)))))

(deftest runtime-retries-transient-transport-errors-only
  (testing "a transient TLS/IO failure is retried by the provider-neutral loop"
    (let [calls (atom 0)
          retries (atom [])
          generate (fn [_]
                     (if (= 1 (swap! calls inc))
                       (throw (java.io.IOException.
                               "Remote host terminated the handshake"))
                       {:message {:role "assistant" :content "recovered"}
                        :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock :config {:generate generate}}
                 {:ns 'qi.plugins.runtime
                  :config {:max-retries 2 :retry-delay-ms 1}}]})
          observer (kernel/plugin-context ctx :test/retry-observer)]
      (try
        (kernel/on! observer :agent/retry
                    (fn [_ event] (swap! retries conj event)))
        (is (= "recovered"
               (:content ((kernel/require-service ctx :agent/run) "hello"))))
        (is (= 2 @calls))
        (is (= :provider-error (:reason (first @retries))))
        (finally (kernel/dispose-all! ctx)))))

  (testing "a permanent client error is not retried"
    (let [calls (atom 0)
          generate (fn [_]
                     (swap! calls inc)
                     (throw (ex-info "bad request" {:status 400})))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock :config {:generate generate}}
                 {:ns 'qi.plugins.runtime
                  :config {:max-retries 2 :retry-delay-ms 1}}]})]
      (try
        (is (= "bad request"
               (try
                 ((kernel/require-service ctx :agent/run) "hello")
                 nil
                 (catch Throwable error (ex-message error)))))
        (is (= 1 @calls))
        (finally (kernel/dispose-all! ctx))))))

(deftest policy-can-deny-without-changing-the-loop
  (let [ctx (plugin/boot! (tool-loop-config {:deny-tools ["calculate"]}))]
    (try
      (let [result ((kernel/require-service ctx :agent/run) "Add two and three")
            tool-message (first (filter #(= "tool" (:role %))
                                        (:messages result)))]
        (is (= "The result is 5." (:content result)))
        (is (.startsWith (:content tool-message) "ERROR: Denied")))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest openai-compatible-request-shape
  (let [captured (atom nil)]
    (with-redefs [http/post
                  (fn [url options]
                    (reset! captured [url options])
                    {:status 200
                     :body (json/generate-string
                            {:model "demo-model"
                             :choices [{:finish_reason "stop"
                                        :message {:role "assistant"
                                                  :content "ok"}}]
                             :usage {:total_tokens 3}})})]
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.openai
                    :config {:base-url "https://llm.example/v1/"
                             :model "demo-model"
                             :api-key "test-key"
                             :proxy {:host "192.168.90.9"
                                     :port 7893}}}]})]
        (try
          (let [response ((kernel/require-service ctx :llm/generate)
                          {:system-prompt "system"
                           :messages
                           [{:role "user"
                             :content [{:type :text :text "hello"}
                                       {:type :image
                                        :url "data:image/png;base64,AA=="
                                        :detail "low"}]}]
                           :tools [{:type "function"
                                    :function {:name "demo"
                                               :description "demo"
                                               :parameters {:type "object"}}}]})
                [url options] @captured
                body (json/parse-string (:body options) true)]
            (is (= "ok" (get-in response [:message :content])))
            (is (= "https://llm.example/v1/chat/completions" url))
            (is (= "Bearer test-key"
                   (get-in options [:headers "authorization"])))
            (is (= {:host "192.168.90.9" :port 7893}
                   (:proxy options)))
            (is (= "system" (get-in body [:messages 0 :role])))
            (is (= "user" (get-in body [:messages 1 :role])))
            (is (= "text" (get-in body [:messages 1 :content 0 :type])))
            (is (= "image_url"
                   (get-in body [:messages 1 :content 1 :type])))
            (is (= "data:image/png;base64,AA=="
                   (get-in body [:messages 1 :content 1 :image_url :url])))
            (is (= "auto" (:tool_choice body)))
            (is (true? (:stream body))))
          (finally
            (kernel/dispose-all! ctx)))))))

(deftest openai-compatible-stream-preserves-whitespace-deltas
  (let [stream-events (atom [])
        chunks ["##" " " "标题" "\n\n" "|问题|说明|" "\n"
                "|---|---|" "\n" "|空格|换行|"]
        body (str (apply str
                         (for [content chunks]
                           (str "data: "
                                (json/generate-string
                                 {:choices [{:delta {:content content}}]})
                                "\n\n")))
                  "data: "
                  (json/generate-string
                   {:choices [{:delta {} :finish_reason "stop"}]})
                  "\n\n")]
    (with-redefs [http/post (fn [_ _] {:status 200 :body body})]
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.openai
                    :config {:base-url "https://llm.example/v1"
                             :model "demo-model"
                             :api-key "test-key"}}]})]
        (try
          (kernel/on! (kernel/plugin-context ctx :test/openai-whitespace)
                      :llm/stream
                      (fn [_ event] (swap! stream-events conj event)))
          (let [response ((kernel/require-service ctx :llm/generate)
                          {:messages [{:role "user" :content "hello"}]})]
            (is (= (apply str chunks) (get-in response [:message :content])))
            (is (= chunks
                   (->> @stream-events
                        (filter #(= :text/delta (:type %)))
                        (mapv :delta)))))
          (finally
            (kernel/dispose-all! ctx)))))))

(defn- completed-event [response]
  (str (apply str
              (map-indexed
               (fn [index item]
                 (str (when (= "message" (:type item))
                        (apply str
                               (for [content (:content item)
                                     :when (= "output_text" (:type content))]
                                 (str "event: response.output_text.delta\n"
                                      "data: "
                                      (json/generate-string
                                       {:type "response.output_text.delta"
                                        :delta (:text content)})
                                      "\n\n"))))
                      "event: response.output_item.done\n"
                      "data: "
                      (json/generate-string
                       {:type "response.output_item.done"
                        :output_index index
                        :item item})
                      "\n\n"))
               (:output response)))
       "event: response.completed\n"
       "data: " (json/generate-string
                  {:type "response.completed"
                   ;; ChatGPT's subscription stream currently supplies the
                   ;; completed items in output_item.done events.
                   :response (assoc response :output [])})
       "\n\n"))

(deftest official-openai-responses-request-retry-and-replay
  (let [captured (atom [])
        stream-events (atom [])
        replies (atom
                 [{:status 429 :body "retry later"}
                  {:status 200
                   :body (completed-event
                          {:id "response-tool"
                           :status "completed"
                           :model "gpt-5.6-sol"
                           :output
                           [{:id "reason-1" :type "reasoning" :summary []}
                            {:id "function-1"
                             :type "function_call"
                             :call_id "call-1"
                             :name "demo"
                             :arguments "{\"value\":1}"}]})}
                  {:status 200
                   :body (completed-event
                          {:id "response-final"
                           :status "completed"
                           :model "gpt-5.6-sol"
                           :output
                           [{:id "message-1"
                             :type "message"
                             :role "assistant"
                             :content [{:type "output_text" :text "done"}]}]
                           :usage {:input_tokens 12 :output_tokens 2
                                   :total_tokens 14}})}])]
    (with-redefs [http/post
                  (fn [url options]
                    (swap! captured conj [url options])
                    (let [reply (first @replies)]
                      (swap! replies subvec 1)
                      reply))]
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.openai-responses
                    :config {:model "gpt-5.6-sol"
                             :api-key "test-key"
                             :max-retries 1
                             :retry-delay-ms 1}}]})]
        (try
          (kernel/on! (kernel/plugin-context ctx :test/openai-stream)
                      :llm/stream
                      (fn [_ event] (swap! stream-events conj event)))
          (let [generate (kernel/require-service ctx :llm/generate)
                tool-response
                (generate
                 {:system-prompt "system"
                  :messages [{:role "user"
                              :content [{:type :text :text "hello"}
                                        {:type :image
                                         :url "data:image/png;base64,AA=="
                                         :detail "low"}]}]
                  :tools [{:type "function"
                           :function {:name "demo"
                                      :description "demo"
                                      :parameters {:type "object"}}}]})
                assistant (:message tool-response)
                final-response
                (generate
                 {:system-prompt "system"
                  :messages [{:role "user" :content "hello"}
                             assistant
                             {:role "tool"
                              :tool_call_id "call-1"
                              :content {:ok true}}]
                  :tools []})
                [[first-url] [url first-options] [_ second-options]] @captured
                first-body (json/parse-string (:body first-options) true)
                second-body (json/parse-string (:body second-options) true)]
            (is (= 3 (count @captured)))
            (is (= first-url url))
            (is (= "https://api.openai.com/v1/responses" url))
            (is (= "Bearer test-key"
                   (get-in first-options [:headers "authorization"])))
            (is (nil? (get-in first-options
                              [:headers "chatgpt-account-id"])))
            (is (true? (:stream first-body)))
            (is (false? (:store first-body)))
            (is (= "system" (:instructions first-body)))
            (is (= "demo" (get-in first-body [:tools 0 :name])))
            (is (nil? (get-in first-body [:tools 0 :function])))
            (is (= "input_image"
                   (get-in first-body [:input 0 :content 1 :type])))
            (is (= "tool_calls" (:finish-reason tool-response)))
            (is (= "call-1" (get-in assistant [:tool_calls 0 :id])))
            (is (= "reasoning" (get-in second-body [:input 1 :type])))
            (is (= "function_call"
                   (get-in second-body [:input 2 :type])))
            (is (= "function_call_output"
                   (get-in second-body [:input 3 :type])))
            (is (= "{\"ok\":true}"
                   (get-in second-body [:input 3 :output])))
            (is (= "done" (get-in final-response [:message :content])))
            (is (= "stop" (:finish-reason final-response)))
            (is (= [:openai]
                   (->> @stream-events
                        (filter #(= :text/delta (:type %)))
                        (mapv :provider)))))
          (finally
            (kernel/dispose-all! ctx)))))))

(deftest official-openai-responses-refuses-key-exfiltration
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo
       #"Refusing to send an OpenAI API key"
       (plugin/boot!
        {:plugins
         [{:ns 'qi.plugins.openai-responses
           :config {:base-url "https://example.com/v1"
                    :model "gpt-5.6-sol"
                    :api-key "must-not-leak"}}]}))))

(deftest chatgpt-subscription-request-and-replay
  (let [auth-file (java.io.File/createTempFile "qi-agent-auth-" ".json")
        captured (atom [])
        stream-events (atom [])
        responses (atom
                   [{:id "resp-tool"
                     :status "completed"
                     :model "gpt-5.6-sol"
                     :output
                     [{:id "reason-1"
                       :type "reasoning"
                       :encrypted_content "opaque"
                       :summary []}
                      {:id "fc-1"
                       :type "function_call"
                       :call_id "call-1"
                       :name "demo"
                       :arguments "{\"value\":1}"}]
                     :usage {:input_tokens 10
                             :output_tokens 4
                             :total_tokens 14}}
                    {:id "resp-final"
                     :status "completed"
                     :model "gpt-5.6-sol"
                     :output
                     [{:id "msg-1"
                       :type "message"
                       :role "assistant"
                       :content [{:type "output_text" :text "done"}]}]
                     :usage {:input_tokens 18
                             :output_tokens 3
                             :total_tokens 21}}])]
    (try
      (spit auth-file
            (json/generate-string
             {:auth_mode "chatgpt"
              :tokens {:access_token "secret-token"
                       :account_id "account-1"
                       :refresh_token "must-not-leak"}}))
      (with-redefs
       [http/post
        (fn [url options]
          (swap! captured conj [url options])
          (let [response (first @responses)]
            (swap! responses subvec 1)
            {:status 200 :body (completed-event response)}))]
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'qi.plugins.chatgpt
                      :config {:model "gpt-5.6-sol"
                               :auth-file (str auth-file)
                               :check-permissions false}}]})]
          (try
            (kernel/on! (kernel/plugin-context ctx :test/stream-observer)
                        :llm/stream
                        (fn [_ event] (swap! stream-events conj event)))
            (let [generate (kernel/require-service ctx :llm/generate)
                  first-response
                  (generate
                   {:system-prompt "system"
                    :messages
                    [{:role "user"
                      :content [{:type :text :text "hello"}
                                {:type :image
                                 :url "data:image/png;base64,AA=="
                                 :detail "low"}]}]
                    :tools [{:type "function"
                             :function {:name "demo"
                                        :description "demo"
                                        :parameters {:type "object"}}}]})
                  assistant (:message first-response)
                  final-response
                  (generate
                   {:system-prompt "system"
                    :messages [{:role "user" :content "hello"}
                               assistant
                               {:role "tool"
                                :tool_call_id "call-1"
                                :content "{\"ok\":true}"}]
                    :tools []})
                  [[url first-options] [_ second-options]] @captured
                  first-body (json/parse-string (:body first-options) true)
                  second-body (json/parse-string (:body second-options) true)]
              (is (= "https://chatgpt.com/backend-api/codex/responses" url))
              (is (= "Bearer secret-token"
                     (get-in first-options [:headers "authorization"])))
              (is (= "account-1"
                     (get-in first-options
                             [:headers "chatgpt-account-id"])))
              (is (= :stream (:as first-options)))
              (is (true? (:stream first-body)))
              (is (false? (:store first-body)))
              (is (= "demo" (get-in first-body [:tools 0 :name])))
              (is (nil? (get-in first-body [:tools 0 :function])))
              (is (= "input_text"
                     (get-in first-body [:input 0 :content 0 :type])))
              (is (= "input_image"
                     (get-in first-body [:input 0 :content 1 :type])))
              (is (= "data:image/png;base64,AA=="
                     (get-in first-body [:input 0 :content 1 :image_url])))
              (is (= "tool_calls" (:finish-reason first-response)))
              (is (= "call-1" (get-in assistant [:tool_calls 0 :id])))
              (is (= "reasoning" (get-in second-body [:input 1 :type])))
              (is (= "function_call"
                     (get-in second-body [:input 2 :type])))
              (is (= "function_call_output"
                     (get-in second-body [:input 3 :type])))
              (is (= "done" (get-in final-response [:message :content])))
              (is (= "stop" (:finish-reason final-response)))
              (is (= ["done"]
                     (->> @stream-events
                          (filter #(= :text/delta (:type %)))
                          (mapv :delta)))))
            (finally
              (kernel/dispose-all! ctx)))))
      (finally
        (.delete auth-file)))))

(deftest chatgpt-transport-retries-with-a-fresh-http1-client
  (let [auth-file (java.io.File/createTempFile "qi-agent-auth-" ".json")
        client-options (atom [])
        requests (atom [])
        response {:id "resp-recovered"
                  :status "completed"
                  :model "gpt-5.6-sol"
                  :output [{:id "msg-recovered"
                            :type "message"
                            :role "assistant"
                            :content [{:type "output_text"
                                       :text "recovered"}]}]}]
    (try
      (spit auth-file
            (json/generate-string
             {:auth_mode "chatgpt"
              :tokens {:access_token "secret-token"
                       :account_id "account-1"}}))
      (with-redefs
       [http/client
        (fn [options]
          (swap! client-options conj options)
          {:test-client (count @client-options)})
        http/post
        (fn [_ options]
          (swap! requests conj options)
          (if (= 1 (count @requests))
            (throw (java.io.IOException.
                    "Remote host terminated the handshake"))
            {:status 200 :body (completed-event response)}))]
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'qi.plugins.chatgpt
                      :config {:model "gpt-5.6-sol"
                               :auth-file (str auth-file)
                               :check-permissions false
                               :transport-retries 1
                               :retry-delay-ms 1
                               :proxy {:host "127.0.0.1"
                                       :port 7897}}}]})]
          (try
            (is (= "recovered"
                   (get-in ((kernel/require-service ctx :llm/generate)
                            {:system-prompt "system"
                             :messages [{:role "user" :content "hello"}]
                             :tools []})
                           [:message :content])))
            (is (= 2 (count @requests)))
            (is (= 2 (count @client-options)))
            (is (every? #(= :http1.1 (:version %)) @client-options))
            (is (every? #(= {:host "127.0.0.1" :port 7897}
                            (:proxy %))
                        @client-options))
            (is (every? #(= :http1.1 (:version %)) @requests))
            (is (not= (:client (first @requests))
                      (:client (second @requests))))
            (finally
              (kernel/dispose-all! ctx)))))
      (finally
        (.delete auth-file)))))

(deftest session-recovers-compacts-forks-and-clears-append-only
  (let [source (java.io.File/createTempFile "qi-agent-session-" ".jsonl")
        destination (java.io.File/createTempFile "qi-agent-fork-" ".jsonl")]
    (.delete destination)
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.session
                    :config {:path (str source)
                             :retain-messages 2}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            (doseq [index (range 5)]
              ((:append! store) "message"
               {:message {:role (if (even? index) "user" "assistant")
                          :content (str "message-" index)}}))
            (let [compaction ((:compact! store))
                  fork ((:fork! store) (str destination))]
              (is (true? (:compacted compaction)))
              (is (= 3 (count ((:messages store)))))
              (is (= "user" (:role (first ((:messages store))))))
              (is (true? (:context-summary (first ((:messages store))))))
              (is (str/includes? (:content (first ((:messages store)))) "Untrusted historical context"))
              (is (.isFile destination))
              (is (not= (:session-id store) (:session-id fork)))
              (is (thrown? clojure.lang.ExceptionInfo
                           ((:fork! store) (str destination))))))
          (finally (kernel/dispose-all! ctx))))

      (spit source "{\"truncated\"\n" :append true)
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'qi.plugins.session
                             :config {:path (str source)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)
                size-before (.length source)]
            (is (= 1 (count ((:diagnostics store)))))
            (is (= 3 (count ((:messages store)))))
            ((:clear! store))
            (is (empty? ((:messages store))))
            (is (> (.length source) size-before)))
          (finally (kernel/dispose-all! ctx))))

      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'qi.plugins.session
                             :config {:path (str destination)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            (is (= 3 (count ((:messages store)))))
            (is (empty? ((:diagnostics store)))))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (.delete source)
        (.delete destination)))))

(defn- tool-call [id name arguments]
  {:id id :type "function"
   :function {:name name :arguments (json/generate-string arguments)}})

(defn- subagent-test-context
  ([generate] (subagent-test-context generate #{}))
  ([generate allowed-tools]
   (plugin/boot!
    {:plugins
     [{:ns 'qi.plugins.session}
      {:ns 'qi.plugins.subagent}
      {:ns 'qi.plugins.subagent-in-process
       :config
       {:allowed-tools allowed-tools
        :child-profile
        {:plugins
         [{:ns 'qi.plugins.session}
          {:ns 'qi.plugins.durable-state
           :config {:root (System/getProperty "java.io.tmpdir")}}
          {:ns 'qi.plugins.bb-repl
           :config {:root (System/getProperty "java.io.tmpdir")
                    :sandbox :none :timeout-ms 5000}}
          {:ns 'qi.plugins.clojure-repl}
          {:ns 'qi.plugins.mock :config {:generate generate}}
          {:ns 'example.math}
          {:ns 'qi.plugins.runtime :config {:max-steps 3}}]}}}
      {:ns 'qi.plugins.subagent-tools}]})))

(deftest subagent-providers-are-isolated-capability-checked-and-structured
  (let [request-seen (promise)
        ctx (subagent-test-context
             (fn [request]
               (deliver request-seen request)
               {:message {:role "assistant" :content "{\"answer\":42}"}
                :finish-reason "stop"})
             #{"calculate" "bb_repl"})]
    (try
      (let [runtime (kernel/require-service ctx :subagents/runtime)
            delegate (kernel/tool ctx "delegate_task")
            result ((:execute delegate)
                    {:prompt "Return the answer"
                     :persona "You are a terse verifier."
                     :tool_filter ["calculate"]
                     :output_schema
                     {:type "object"
                      :required ["answer"]
                      :properties {"answer" {:type "integer"}}
                      :additionalProperties false}}
                    {:cancel-token (cancellation/create-token)})
            request (deref request-seen 1000 :timeout)]
        (is (= :completed (:stop-reason result)))
        (is (= {:answer 42} (:structured result)))
        (is (str/includes? (:system-prompt request) "terse verifier"))
        (is (not (str/includes? (:system-prompt request)
                                "You have your own persistent Clojure-family REPL")))
        (is (= ["calculate"]
               (mapv #(get-in % [:function :name]) (:tools request))))
        (is (= [:completed] (mapv :status ((:jobs runtime)))))
        (is (str/starts-with? (:id (first ((:jobs runtime)))) "agent-"))
        (is (= #{:spawn :fork}
               (set (map :id ((:providers runtime))))))
        (is (thrown-with-msg?
             clojure.lang.ExceptionInfo
             #"not registered"
             ((:start! runtime) {:provider :missing :prompt "x"})))
        (is (thrown-with-msg?
             clojure.lang.ExceptionInfo
             #"depth limit"
             ((:start! runtime) {:provider :spawn :prompt "x"
                                 :parent-depth 1}))))
      (finally (kernel/dispose-all! ctx)))))

(deftest fork-agent-seeds-only-completed-parent-turns
  (let [request-seen (promise)
        ctx (subagent-test-context
             (fn [request]
               (deliver request-seen request)
               {:message {:role "assistant" :content "forked"}
                :finish-reason "stop"}))]
    (try
      (let [store (kernel/require-service ctx :session/store)]
        ((:append! store) "message"
         {:message {:role "user" :content "completed user"}})
        ((:append! store) "message"
         {:message {:role "assistant" :content "completed assistant"}})
        ((:append! store) "step/end" {:step 1 :tool-count 0})
        ((:append! store) "session/compaction"
         {:original_message_count 2
          :retained_message_count 1
          :replacement_messages
          [{:role "system" :content "completed summary"}]})
        ((:append! store) "message"
         {:message {:role "user" :content "open user"}})
        ((:append! store) "step/start" {:step 2})
        (let [fork (kernel/tool ctx "fork_agent")
              result ((:execute fork) {:prompt "child prompt"}
                      {:cancel-token (cancellation/create-token)})
              request (deref request-seen 1000 :timeout)
              contents (mapv :content (:messages request))]
          (is (= :completed (:stop-reason result)))
          (is (= ["completed summary" "child prompt"]
                 contents))
          (is (not-any? #{"open user"} contents))))
      (finally (kernel/dispose-all! ctx)))))

(deftest background-subagent-can-be-listed-interrupted-and-collected
  (let [started (promise)
        ctx (subagent-test-context
             (fn [{:keys [cancel-token]}]
               (deliver started true)
               (loop []
                 (cancellation/throw-if-cancelled! cancel-token)
                 (Thread/sleep 10)
                 (recur))))]
    (try
      (let [delegate (kernel/tool ctx "delegate_task")
            list-agents (kernel/tool ctx "list_agents")
            interrupt (kernel/tool ctx "interrupt_agent")
            wait-agent (kernel/tool ctx "wait_agent")
            delete-agent (kernel/tool ctx "delete_agent")
            job ((:execute delegate)
                 {:prompt "keep working" :run_in_background true}
                 {:cancel-token (cancellation/create-token)})
            run-id (:id job)]
        (is (= true (deref started 1000 :timeout)))
        (is (= [run-id]
               (mapv :id (:agents ((:execute list-agents) {} {})))))
        (is (true? (:interrupted
                    ((:execute interrupt) {:id run-id} {}))))
        (is (= :aborted
               (:stop-reason
                ((:execute wait-agent) {:id run-id :timeout_ms 1000} {}))))
        (is (= :cancelled
               (:status (first (:agents ((:execute list-agents) {} {}))))))
        (is (= run-id
               (get-in ((:execute delete-agent) {:id run-id} {})
                       [:tombstone :agent_id])))
        (is (empty? (:agents ((:execute list-agents) {} {})))))
      (finally (kernel/dispose-all! ctx)))))

(deftest retained-subagent-accepts-follow-up-and-owns-an-isolated-repl
  (let [requests (atom [])
        ctx (subagent-test-context
             (fn [request]
               (swap! requests conj request)
               {:message {:role "assistant"
                          :content (str "answered: "
                                        (:content (last (:messages request))))}
                :finish-reason "stop"})
             #{"bb_repl"})]
    (try
      (let [runtime (kernel/require-service ctx :subagents/runtime)
            delegate (kernel/tool ctx "delegate_task")
            first-result ((:execute delegate) {:prompt "first"}
                          {:cancel-token (cancellation/create-token)})
            first-id (:id first-result)
            _ (is (= :completed (:stop-reason first-result)))
            accepted ((:send! runtime) first-id "second")
            follow-up ((:wait! runtime) first-id 2000)
            second-job ((:start! runtime)
                        {:provider :spawn :prompt "sibling"
                         :parent-depth 0 :parent-context ctx
                         :cancel-token (cancellation/create-token)})
            second-id (:id second-job)]
        (is (:accepted accepted))
        (is (= "answered: second" (:output follow-up)))
        (is (= :completed (:stop-reason ((:wait! runtime) second-id 2000))))
        (is (every? #(str/includes? (:system-prompt %)
                                    "You have your own persistent Clojure-family REPL")
                    @requests))
        (is (every? #(= ["bb_repl"]
                        (mapv (fn [tool]
                                (get-in tool [:function :name]))
                              (:tools %)))
                    @requests))
        (is (:ok ((:invoke! runtime) first-id "repl.eval"
                  {:code "(def local-value :first)"})))
        (is (:ok ((:invoke! runtime) second-id "repl.eval"
                  {:code "(def local-value :second)"})))
        (is (= ":first" (:value ((:invoke! runtime) first-id "repl.eval"
                                  {:code "local-value"}))))
        (is (= ":second" (:value ((:invoke! runtime) second-id "repl.eval"
                                   {:code "local-value"}))))
        (is (not= (:namespace ((:invoke! runtime) first-id "repl.status" {}))
                  (:namespace ((:invoke! runtime) second-id "repl.status" {}))))
        (is (= 2 (count ((:jobs runtime)))))
        ((:delete! runtime) first-id)
        ((:delete! runtime) second-id))
      (finally (kernel/dispose-all! ctx)))))

(deftest retained-subagent-roster-restores-routing-after-worker-context-restart
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-child-roster-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        session-path (str (io/file directory ".qi-agent" "sessions"
                                   "root.jsonl"))
        generate (fn [request]
                   {:message {:role "assistant"
                              :content (str "child: "
                                            (:content (last (:messages request))))}
                    :finish-reason "stop"})
        profile
        {:plugins
         [{:ns 'qi.plugins.session :config {:path session-path}}
          {:ns 'qi.plugins.subagent}
          {:ns 'qi.plugins.subagent-in-process
           :config
           {:allowed-tools []
            :child-profile
            {:plugins
             [{:ns 'qi.plugins.session}
              {:ns 'qi.plugins.mock :config {:generate generate}}
              {:ns 'qi.plugins.runtime :config {:max-steps 2}}]}}}]}
        first-ctx (plugin/boot! profile)]
    (try
      (let [runtime (kernel/require-service first-ctx :subagents/runtime)
            job ((:start! runtime)
                 {:provider :spawn :prompt "initial" :parent-depth 0
                  :parent-context first-ctx
                  :cancel-token (cancellation/create-token)})
            agent-id (:id job)]
        (is (= :completed (:stop-reason ((:wait! runtime) agent-id 2000))))
        (let [session-id (:session-id (kernel/require-service
                                       first-ctx :session/store))
              roster (io/file directory ".qi-agent" "artifacts"
                              session-id "children.edn")]
          (is (.isFile roster))
          (is (str/includes? (slurp roster) agent-id)))
        (kernel/dispose-all! first-ctx)
        (let [second-ctx (plugin/boot! profile)]
          (try
            (let [restored (kernel/require-service second-ctx :subagents/runtime)]
              (is (= [agent-id] (mapv :id ((:jobs restored)))))
              (is (:accepted ((:send! restored) agent-id "after restore")))
              (is (= "child: after restore"
                     (:output ((:wait! restored) agent-id 2000))))
              (is (= agent-id
                     (:agent_id ((:delete! restored) agent-id)))))
            (finally (kernel/dispose-all! second-ctx)))))
      (finally
        (kernel/dispose-all! first-ctx)
        (delete-tree! directory)))))

(deftest controllable-agent-session-steers-follows-up-and-aborts
  (testing "steering enters before the next model request and follow-up waits"
    (let [started (promise)
          release (promise)
          requests (atom [])
          calls (atom 0)
          generate
          (fn [request]
            (swap! requests conj request)
            (case (swap! calls inc)
              1 (do
                  (deliver started true)
                  @release
                  {:message {:role "assistant" :content nil
                             :tool_calls
                             [(tool-call "control-call" "calculate"
                                         {:operation "add" :a 1 :b 1})]}
                   :finish-reason "tool_calls"})
              2 {:message {:role "assistant" :content "first stop"}
                 :finish-reason "stop"}
              3 {:message {:role "assistant" :content "after follow-up"}
                 :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock :config {:generate generate}}
                 {:ns 'example.math}
                 {:ns 'qi.plugins.runtime :config {:max-steps 5}}]})]
      (try
        (let [session (kernel/require-service ctx :agent/session)
              {:keys [result]} ((:submit! session) "start")]
          (is (= true (deref started 1000 :timeout)))
          ((:steer! session) "steer now")
          ((:follow-up! session) "do this later")
          (deliver release true)
          (let [{:keys [ok value]} (deref result 2000 :timeout)
                second-messages (:messages (second @requests))
                third-messages (:messages (nth @requests 2))]
            (is ok)
            (is (= "after follow-up" (:content value)))
            (is (some #(= "steer now" (:content %)) second-messages))
            (is (not-any? #(= "do this later" (:content %))
                          second-messages))
            (is (some #(= "do this later" (:content %)) third-messages))
            (is (= :idle (:phase ((:state session)))))
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo
                 #"accepting queued messages"
                 ((:follow-up! session) "too late")))))
        (finally (kernel/dispose-all! ctx)))))

  (testing "abort releases a cooperative blocked provider and records no final"
    (let [started (promise)
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock
                  :config
                  {:generate
                   (fn [{:keys [cancel-token]}]
                     (deliver started true)
                     (loop []
                       (cancellation/throw-if-cancelled! cancel-token)
                       (Thread/sleep 10)
                       (recur)))}}
                 {:ns 'qi.plugins.runtime}]})]
      (try
        (let [session (kernel/require-service ctx :agent/session)
              store (kernel/require-service ctx :session/store)
              {:keys [result]} ((:submit! session) "block")
              before (System/nanoTime)]
          (is (= true (deref started 1000 :timeout)))
          (kernel/emit! ctx :llm/stream {:type :text/delta :delta "working"})
          (kernel/emit! ctx :llm/stream {:type :reasoning/delta
                                         :delta "thinking"})
          (is (= "working" (:partial-assistant ((:state session)))))
          (is (= "thinking" (:partial-reasoning ((:state session)))))
          ((:follow-up! session) "must be discarded")
          (is (true? ((:abort! session))))
          (let [{:keys [ok error]} (deref result 1000 :timeout)
                elapsed-ms (/ (- (System/nanoTime) before) 1000000.0)
                events ((:events store))]
            (is (false? ok))
            (is (:cancelled (ex-data error)))
            (is (< elapsed-ms 1000))
            (is (some #(= "agent/aborted" (:type %)) events))
            (is (some #(= "queue/discarded" (:type %)) events))
            (is (= 1 (count ((:messages store)))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest late-no-tool-response-closes-the-step-as-aborted
  (let [started (promise)
        release (promise)
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config
                {:generate
                 (fn [_]
                   (deliver started true)
                   @release
                   {:message {:role "assistant" :content "late final"}
                    :finish-reason "stop"})}}
               {:ns 'qi.plugins.runtime}]})]
    (try
      (let [session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)
            {:keys [result]} ((:submit! session) "block then stop")]
        (is (= true (deref started 1000 :timeout)))
        (is (true? ((:abort! session))))
        (deliver release true)
        (let [{:keys [ok error]} (deref result 1000 :timeout)
              events ((:events store))
              step-end (first (filter #(= "step/end" (:type %)) events))
              event-types (mapv :type events)]
          (is (false? ok))
          (is (:cancelled (ex-data error)))
          (is (= {:step 1 :tool-count 0 :aborted true}
                 (:data step-end)))
          (is (not-any? #(and (= "message" (:type %))
                              (= "assistant"
                                 (get-in % [:data :message :role]))
                              (= "late final"
                                 (get-in % [:data :message :content])))
                        events))
          (is (some #(= "agent/aborted" (:type %)) events))
          (is (< (.indexOf event-types "step/end")
                 (.indexOf event-types "agent/aborted")))))
      (finally
        (deliver release true)
        (kernel/dispose-all! ctx)))))

(deftest late-tool-call-responses-are-dropped-after-abort
  (doseq [finish-reason ["tool_calls" "length"]]
    (testing (str "finish reason " finish-reason)
      (let [started (promise)
            release (promise)
            late-call (tool-call (str "late-" finish-reason)
                                 "late_tool"
                                 {:value finish-reason})
            ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.session}
                   {:ns 'qi.plugins.mock
                    :config
                    {:generate
                     (fn [_]
                       (deliver started true)
                       @release
                       {:message {:role "assistant"
                                  :content "late tool response"
                                  :tool_calls [late-call]}
                        :finish-reason finish-reason})}}
                   {:ns 'qi.plugins.runtime}]})]
        (try
          (let [session (kernel/require-service ctx :agent/session)
                store (kernel/require-service ctx :session/store)
                {:keys [result]} ((:submit! session) "block then return a tool")]
            (is (= true (deref started 1000 :timeout)))
            (is (true? ((:abort! session))))
            (deliver release true)
            (let [{:keys [ok error]} (deref result 1000 :timeout)
                  events ((:events store))
                  event-types (mapv :type events)
                  step-end (first (filter #(= "step/end" (:type %)) events))]
              (is (false? ok))
              (is (:cancelled (ex-data error)))
              (is (= {:step 1 :tool-count 0 :aborted true}
                     (:data step-end)))
              (is (not-any? #{"tool/call" "tool/result"} event-types))
              (is (not-any? #(and (= "message" (:type %))
                                  (= "assistant"
                                     (get-in % [:data :message :role])))
                            events))
              (is (= 1 (count ((:messages store)))))
              (is (< (.indexOf event-types "step/end")
                     (.indexOf event-types "agent/aborted")))))
          (finally
            (deliver release true)
            (kernel/dispose-all! ctx)))))))

(deftest late-provider-error-after-abort-is-canonical-cancellation
  (let [started (promise)
        release (promise)
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config
                {:generate
                 (fn [_]
                   (deliver started true)
                   @release
                   (throw (ex-info "late provider 400" {:status 400})))}}
               {:ns 'qi.plugins.runtime}]})]
    (try
      (let [session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)
            {:keys [result]} ((:submit! session) "block then fail")]
        (is (= true (deref started 1000 :timeout)))
        (is (true? ((:abort! session))))
        (deliver release true)
        (let [{:keys [ok error]} (deref result 1000 :timeout)
              events ((:events store))
              event-types (mapv :type events)
              step-end (first (filter #(= "step/end" (:type %)) events))]
          (is (false? ok))
          (is (:cancelled (ex-data error)))
          (is (= {:step 1 :tool-count 0 :aborted true}
                 (:data step-end)))
          (is (not-any? #{"agent/error" "tool/call" "tool/result"}
                        event-types))
          (is (some #{"agent/aborted"} event-types))
          (is (= 1 (count ((:messages store)))))
          (is (< (.indexOf event-types "step/end")
                 (.indexOf event-types "agent/aborted")))))
      (finally
        (deliver release true)
        (kernel/dispose-all! ctx)))))

(defn- batch-config [tool-calls]
  {:plugins
   [{:ns 'qi.plugins.session}
    {:ns 'qi.plugins.mock
     :config {:responses
              [{:message {:role "assistant" :content nil
                          :tool_calls tool-calls}
                :finish-reason "tool_calls"}
               {:message {:role "assistant" :content "done"}
                :finish-reason "stop"}]}}
    {:ns 'qi.plugins.runtime :config {:max-steps 3}}]})

(defn- delay-tool [name execution-mode delay-ms completed]
  (cond->
   {:name name
    :description name
    :parameters {:type "object" :additionalProperties false}
    :execute (fn [_ _]
               (Thread/sleep delay-ms)
               (swap! completed conj name)
               {:name name})}
    execution-mode (assoc :execution-mode execution-mode)))

(deftest parallel-tool-end-is-live-while-durable-results-stay-model-ordered
  (let [calls [(tool-call "slow-call" "slow_tool" {})
               (tool-call "fast-call" "fast_tool" {})]
        release-slow (promise)
        fast-ended (promise)
        live-ends (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/completion-order)
            observer (kernel/plugin-context ctx :test/completion-events)
            session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)]
        (kernel/register-tool!
         tool-ctx
         {:name "slow_tool"
          :description "blocked slow tool"
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ _]
                     @release-slow
                     {:speed :slow})})
        (kernel/register-tool!
         tool-ctx
         {:name "fast_tool"
          :description "immediate fast tool"
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ _] {:speed :fast})})
        (kernel/on! observer :tool.execution/end
                    (fn [_ event]
                      (swap! live-ends conj event)
                      (when (= "fast-call" (:call-id event))
                        (deliver fast-ended true))))
        (let [{:keys [result]} ((:submit! session) "completion order")]
          (is (= true (deref fast-ended 1000 :timeout)))
          (is (= ["fast-call"] (mapv :call-id @live-ends)))
          (is (empty? (filter #(= "tool/result" (:type %))
                              ((:events store)))))
          (deliver release-slow true)
          (let [{:keys [ok]} (deref result 2000 :timeout)
                events ((:events store))
                durable-results (filterv #(= "tool/result" (:type %))
                                          events)
                tool-messages (filterv #(= "tool" (:role %))
                                       ((:messages store)))]
            (is ok)
            (is (= ["fast-call" "slow-call"]
                   (mapv :call-id @live-ends)))
            (is (= ["slow-call" "fast-call"]
                   (mapv #(get-in % [:data :call-id]) durable-results)))
            (is (= ["slow-call" "fast-call"]
                   (mapv :tool_call_id tool-messages))))))
      (finally
        (deliver release-slow true)
        (kernel/dispose-all! ctx)))))

(deftest preflight-errors-end-before-a-later-approval-resolves
  (let [calls [(tool-call "unknown-call" "missing_tool" {})
               (tool-call "invalid-call" "validated_tool" {})
               (tool-call "approval-call" "danger" {})]
        approval-opened (promise)
        approval-decision (promise)
        live-ends (atom [])
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config {:responses
                         [{:message {:role "assistant" :content nil
                                     :tool_calls calls}
                           :finish-reason "tool_calls"}
                          {:message {:role "assistant" :content "done"}
                           :finish-reason "stop"}]}}
               {:ns 'qi.plugins.approval :config {:mode :ask}}
               {:ns 'qi.plugins.policy
                :config {:approval-tools ["danger"]}}
               {:ns 'qi.plugins.runtime :config {:max-steps 3}}]})]
    (try
      (let [prompt-ctx (kernel/plugin-context ctx :test/blocked-approval)
            tool-ctx (kernel/plugin-context ctx :test/preflight-tools)
            observer (kernel/plugin-context ctx :test/preflight-events)
            session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)]
        (kernel/register-service!
         prompt-ctx :ui/prompt
         {:active? (constantly true)
          :select! (fn [prompt]
                     (deliver approval-opened prompt)
                     @approval-decision)})
        (kernel/register-tool!
         tool-ctx
         {:name "validated_tool"
          :description "requires an argument"
          :parameters {:type "object"
                       :required ["value"]
                       :properties {"value" {:type "integer"}}
                       :additionalProperties false}
          :execute (fn [_ _] {:unexpected true})})
        (kernel/register-tool!
         tool-ctx
         {:name "danger"
          :description "approval-gated tool"
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ _] {:approved true})})
        (kernel/on! observer :tool.execution/end
                    (fn [_ event] (swap! live-ends conj event)))
        (let [{:keys [result]} ((:submit! session) "preflight timing")]
          (is (map? (deref approval-opened 1000 :timeout)))
          (is (= ["unknown-call" "invalid-call"]
                 (mapv :call-id @live-ends)))
          (is (every? #(= :error (:status %)) @live-ends))
          (is (empty? (filter #(= "tool/result" (:type %))
                              ((:events store)))))
          (deliver approval-decision :allow)
          (let [{:keys [ok]} (deref result 2000 :timeout)
                durable-results (filterv #(= "tool/result" (:type %))
                                          ((:events store)))]
            (is ok)
            (is (= ["unknown-call" "invalid-call" "approval-call"]
                   (mapv :call-id @live-ends)))
            (is (= 3 (count @live-ends)))
            (is (= ["unknown-call" "invalid-call" "approval-call"]
                   (mapv #(get-in % [:data :call-id]) durable-results))))))
      (finally
        (deliver approval-decision :deny)
        (kernel/dispose-all! ctx)))))

(deftest sequential-tool-abort-terminalizes-running-and-pending-calls
  (let [calls [(tool-call "first-call" "first_tool" {})
               (tool-call "second-call" "second_tool" {})]
        first-started (promise)
        second-executed? (atom false)
        starts (atom [])
        ends (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/sequential-cancel)
            observer (kernel/plugin-context ctx :test/sequential-events)
            session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)]
        (kernel/register-tool!
         tool-ctx
         {:name "first_tool"
          :description "cooperatively blocked first tool"
          :execution-mode :sequential
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ {:keys [cancel-token]}]
                     (deliver first-started true)
                     (loop []
                       (cancellation/throw-if-cancelled! cancel-token)
                       (Thread/sleep 5)
                       (recur)))})
        (kernel/register-tool!
         tool-ctx
         {:name "second_tool"
          :description "must remain unexecuted"
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ _]
                     (reset! second-executed? true)
                     {:unexpected true})})
        (kernel/on! observer :tool.execution/start
                    (fn [_ event] (swap! starts conj event)))
        (kernel/on! observer :tool.execution/end
                    (fn [_ event] (swap! ends conj event)))
        (let [{:keys [result]} ((:submit! session) "cancel tools")]
          (is (= true (deref first-started 1000 :timeout)))
          (is (= ["first-call" "second-call"]
                 (->> ((:events store))
                      (filter #(= "tool/call" (:type %)))
                      (mapv #(get-in % [:data :call-id])))))
          (is (true? ((:abort! session))))
          (let [{:keys [ok error]} (deref result 2000 :timeout)
                events ((:events store))
                durable-results (filterv #(= "tool/result" (:type %))
                                          events)
                event-types (mapv :type events)]
            (is (false? ok))
            (is (:cancelled (ex-data error)))
            (is (= ["first-call"] (mapv :call-id @starts)))
            (is (= ["first-call" "second-call"]
                   (mapv :call-id @ends)))
            (is (every? #(and (= :canceled (:status %))
                              (true? (:cancelled %)))
                        @ends))
            (is (= ["first-call" "second-call"]
                   (mapv #(get-in % [:data :call-id]) durable-results)))
            (is (every? #(and (= :canceled (get-in % [:data :status]))
                              (true? (get-in % [:data :cancelled])))
                        durable-results))
            (is (false? @second-executed?))
            (is (true? (get-in (first (filter #(= "step/end" (:type %))
                                              events))
                               [:data :aborted])))
            (is (< (.indexOf event-types "step/end")
                   (.indexOf event-types "agent/aborted"))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest approval-wait-abort-closes-the-entire-declared-tool-batch
  (let [calls [(tool-call "approval-first" "danger" {})
               (tool-call "approval-second" "danger" {})]
        prompt-opened (promise)
        executed? (atom false)
        ends (atom [])
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config {:responses
                         [{:message {:role "assistant" :content nil
                                     :tool_calls calls}
                           :finish-reason "tool_calls"}]}}
               {:ns 'qi.plugins.approval :config {:mode :ask}}
               {:ns 'qi.plugins.policy
                :config {:approval-tools ["danger"]}}
               {:ns 'qi.plugins.runtime :config {:max-steps 2}}]})]
    (try
      (let [prompt-ctx (kernel/plugin-context ctx :test/cancellable-approval)
            tool-ctx (kernel/plugin-context ctx :test/approval-tool)
            observer (kernel/plugin-context ctx :test/approval-end)
            session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)]
        (kernel/register-service!
         prompt-ctx :ui/prompt
         {:active? (constantly true)
          :select! (fn [{:keys [cancel-token] :as prompt}]
                     (deliver prompt-opened prompt)
                     (loop []
                       (if (cancellation/cancelled? cancel-token)
                         :deny
                         (do (Thread/sleep 5) (recur)))))})
        (kernel/register-tool!
         tool-ctx
         {:name "danger"
          :description "approval-gated tool"
          :parameters {:type "object" :additionalProperties false}
          :execute (fn [_ _]
                     (reset! executed? true)
                     {:unexpected true})})
        (kernel/on! observer :tool.execution/end
                    (fn [_ event] (swap! ends conj event)))
        (let [{:keys [result]} ((:submit! session) "wait for approval")
              prompt (deref prompt-opened 1000 :timeout)]
          (is (map? prompt))
          (is (some? (:cancel-token prompt)))
          (is (= ["approval-first" "approval-second"]
                 (->> ((:events store))
                      (filter #(= "tool/call" (:type %)))
                      (mapv #(get-in % [:data :call-id])))))
          (is (true? ((:abort! session))))
          (let [{:keys [ok error]} (deref result 2000 :timeout)
                durable-results (filterv #(= "tool/result" (:type %))
                                          ((:events store)))]
            (is (false? ok))
            (is (:cancelled (ex-data error)))
            (is (= ["approval-first" "approval-second"]
                   (mapv :call-id @ends)))
            (is (every? :cancelled @ends))
            (is (= ["approval-first" "approval-second"]
                   (mapv #(get-in % [:data :call-id]) durable-results)))
            (is (false? @executed?)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest deterministic-parallel-tool-batches
  (let [calls [(tool-call "slow-a" "slow_a" {}) (tool-call "slow-b" "slow_b" {})]
        entered [(promise) (promise)] release (promise) completed (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/delay-tools)]
        (doseq [[name ready] (map vector ["slow_a" "slow_b"] entered)]
          (kernel/register-tool! tool-ctx
                                (assoc (delay-tool name nil 0 completed)
                                       :execute (fn [_ _]
                                                  (deliver ready :entered)
                                                  (when (= :timeout (deref release 5000 :timeout))
                                                    (throw (ex-info "Parallel test release timed out" {})))
                                                  (swap! completed conj name)
                                                  {:name name}))))
        (let [pending (future ((kernel/require-service ctx :agent/run) "parallel"))]
          (try
            ;; Both bodies must enter before either is allowed to finish.
            ;; Scheduler speed is not evidence for or against overlap.
            (doseq [ready entered] (is (= :entered (deref ready 5000 :timeout))))
            (is (empty? @completed))
            (deliver release true)
            (let [result (deref pending 5000 :timeout)]
              (is (map? result))
              (is (= ["slow-a" "slow-b"]
                     (mapv :tool_call_id (filterv #(= "tool" (:role %)) (:messages result)))))
              (is (= #{"slow_a" "slow_b"} (set @completed))))
            (finally (deliver release true)))))
      (finally (deliver release true) (kernel/dispose-all! ctx))))

  (let [calls [(tool-call "ordered-a" "ordered_a" {}) (tool-call "ordered-b" "ordered_b" {})]
        first-entered (promise) second-entered (promise) release (promise) completed (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/ordered-tools)]
        (kernel/register-tool! tool-ctx
                              (assoc (delay-tool "ordered_a" :sequential 0 completed)
                                     :execute (fn [_ _]
                                                (deliver first-entered true)
                                                (when (= :timeout (deref release 5000 :timeout))
                                                  (throw (ex-info "Sequential test release timed out" {})))
                                                (swap! completed conj "ordered_a")
                                                {:name "ordered_a"})))
        (kernel/register-tool! tool-ctx
                              (assoc (delay-tool "ordered_b" nil 0 completed)
                                     :execute (fn [_ _]
                                                (deliver second-entered true)
                                                (is (= ["ordered_a"] @completed))
                                                (swap! completed conj "ordered_b")
                                                {:name "ordered_b"})))
        (let [pending (future ((kernel/require-service ctx :agent/run) "sequential"))]
          (try
            (is (true? (deref first-entered 5000 false)))
            (is (not (realized? second-entered)))
            (deliver release true)
            (is (map? (deref pending 5000 :timeout)))
            (is (realized? second-entered))
            (is (= ["ordered_a" "ordered_b"] @completed))
            (finally (deliver release true)))))
      (finally (deliver release true) (kernel/dispose-all! ctx)))))

(defn- delete-tree! [directory]
  (let [root (.toPath (io/file directory))]
    (when (java.nio.file.Files/exists
           root (make-array java.nio.file.LinkOption 0))
      (with-open [paths (java.nio.file.Files/walk
                         root
                         (make-array java.nio.file.FileVisitOption 0))]
        (doseq [path (reverse (vec (iterator-seq (.iterator paths))))]
          (java.nio.file.Files/deleteIfExists path))))))

(defn- posix-mode [file]
  (try
    (java.nio.file.attribute.PosixFilePermissions/toString
     (java.nio.file.Files/getPosixFilePermissions
      (.toPath (io/file file))
      (make-array java.nio.file.LinkOption 0)))
    (catch UnsupportedOperationException _ nil)))

(defn- process-alive? [pid]
  (let [handle (java.lang.ProcessHandle/of (long pid))]
    (and (.isPresent handle) (.isAlive (.get handle)))))

(deftest generated-agent-state-is-owner-only-and-migrates-old-files
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-private-state-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        state-root (io/file directory ".qi-agent")
        sessions (io/file state-root "sessions")
        active (io/file sessions "active.jsonl")
        sibling (io/file sessions "old.jsonl")]
    (try
      (.mkdirs sessions)
      (spit active "")
      (spit sibling "")
      (when (posix-mode sessions)
        (java.nio.file.Files/setPosixFilePermissions
         (.toPath sessions)
         (java.nio.file.attribute.PosixFilePermissions/fromString "rwxrwxrwx"))
        (doseq [file [active sibling]]
          (java.nio.file.Files/setPosixFilePermissions
           (.toPath file)
           (java.nio.file.attribute.PosixFilePermissions/fromString "rw-rw-rw-"))))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.session :config {:path (str active)}}
                   {:ns 'qi.plugins.durable-state
                    :config {:root (str directory)}}]})]
        (try
          ((:put! (kernel/require-service ctx :agent/durable-state))
           :secret "private")
          (let [state-path (:path (kernel/require-service ctx
                                                          :agent/durable-state))]
            (when (posix-mode sessions)
              (is (= "rwx------" (posix-mode state-root)))
              (is (= "rwx------" (posix-mode sessions)))
              (is (= "rw-------" (posix-mode active)))
              (is (= "rw-------" (posix-mode sibling)))
              (is (= "rw-------" (posix-mode state-path)))
              (is (= "rwx------"
                     (posix-mode (.getParentFile (io/file state-path)))))))
          (finally (kernel/dispose-all! ctx))))
      (let [output-directory (io/file state-root "tool-output")]
        (.mkdirs output-directory)
        (dotimes [_ 4]
          (spit (io/file output-directory (str (random-uuid) ".log")) "old")))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.execution-world
                    :config {:root (str directory)
                             :sandbox :none
                             :max-output-chars 4
                             :max-output-file-chars 1000
                             :max-output-files 2}}]})]
        (try
          (let [world (kernel/require-service ctx :execution/world)
                retained (count
                          (filter #(str/ends-with? (.getName %) ".log")
                                  (file-seq (io/file state-root "tool-output"))))
                result ((:spawn! world) {:command "printf 123456789"})
                output (:full-output-path result)]
            (is (= 2 retained))
            (is (= "1234" (:stdout result)))
            (is (:truncated result))
            (is (str/includes? (slurp output) "123456789"))
            (is (= 2
                   (count
                    (filter #(str/ends-with? (.getName %) ".log")
                            (file-seq (io/file state-root "tool-output"))))))
            (when (posix-mode output)
              (is (= "rw-------" (posix-mode output)))
              (is (= "rwx------" (posix-mode (.getParentFile (io/file output)))))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest execution-world-enforces-resource-and-process-tree-limits
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-resource-limits-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        large (io/file directory "large.txt")
        small (io/file directory "small.txt")
        child-pid-file (io/file directory "child.pid")]
    (try
      (spit large "0123456789")
      (spit small "ok")
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.execution-world
                    :config {:root (str directory)
                             :sandbox :none
                             :timeout-ms 100
                             :max-timeout-ms 200
                             :max-output-chars 4
                             :max-output-file-chars 8
                             :max-file-bytes 8
                             :max-write-bytes 8
                             :max-walk-entries 20}}]})]
        (try
          (let [world (kernel/require-service ctx :execution/world)]
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"safe read limit"
                                  ((:read! world) {:path "large.txt"})))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"safe size limit"
                                  ((:write! world) {:path "new.txt"
                                                    :content "123456789"})))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"Append would exceed"
                                  ((:write! world) {:path "small.txt"
                                                    :content "1234567"
                                                    :append true})))
            (let [search ((:search! world) {:query "ok"})]
              (is (= 1 (:skipped-files search)))
              (is (= ["small.txt"] (mapv :path (:items search)))))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"disk limit"
                                  ((:spawn! world)
                                   {:command "printf 123456789"})))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"safe range"
                                  ((:spawn! world)
                                   {:command "printf never"
                                    :timeout-ms 201})))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                  #"timed out"
                                  ((:spawn! world)
                                   {:command
                                    "sleep 30 & echo $! > child.pid; wait"
                                    :timeout-ms 100})))
            (let [pid (Long/parseLong (str/trim (slurp child-pid-file)))]
              (loop [attempt 0]
                (when (and (< attempt 20) (process-alive? pid))
                  (Thread/sleep 10)
                  (recur (inc attempt))))
              (is (false? (process-alive? pid))))
            (let [temporary-files (->> (file-seq (io/file directory
                                                          ".qi-agent"
                                                          "tool-output"))
                                       (filter #(.isFile %))
                                       (filter #(str/ends-with? (.getName %) ".tmp")))]
              (is (empty? temporary-files))))
          (finally (kernel/dispose-all! ctx))))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.execution-world
                    :config {:root (str directory)
                             :sandbox :none
                             :max-walk-entries 2}}]})]
        (try
          (is (thrown-with-msg?
               clojure.lang.ExceptionInfo #"traversal"
               ((:find! (kernel/require-service ctx :execution/world))
                {:pattern "*"})))
          (is (thrown-with-msg?
               clojure.lang.ExceptionInfo #"Directory listing"
               ((:list! (kernel/require-service ctx :execution/world)) {})))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest execution-world-contract-and-coding-tools
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-world-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        outside (java.io.File/createTempFile "qi-agent-outside-" ".txt")]
    (try
      (spit (io/file directory "sample.txt") "alpha\nbeta\n")
      (spit (io/file directory "empty.txt") "")
      (spit outside "secret")
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file directory "escape.txt"))
       (.toPath outside)
       (make-array java.nio.file.attribute.FileAttribute 0))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.execution-world
                    :config {:root (str directory) :timeout-ms 1000
                             :sandbox :none}}
                   {:ns 'qi.plugins.tools}]})]
        (try
          (let [world (kernel/require-service ctx :execution/world)]
            (is (= #{:fs/read :fs/write :process} (:capabilities world)))
            (is (= "alpha\nbeta\n"
                   (:content ((:read! world) {:path "sample.txt"}))))
            (is (= "pha"
                   (:content ((:read! world) {:path "sample.txt"
                                              :offset 2 :limit 3}))))
            (let [read-tool (kernel/tool ctx "read")
                  first-result ((:execute read-tool)
                                {:path "sample.txt" :offset 1 :limit 1}
                                {})
                  read-result ((:execute read-tool)
                               {:path "sample.txt" :offset 2 :limit 1}
                               {})]
              (is (= "alpha" (:content first-result)))
              (is (= 2 (:total-lines first-result)))
              (is (:truncated first-result))
              (is (= (str "alpha\n\n[Showing lines 1-1 of 2. "
                          "Use offset=2 to continue.]")
                     ((:render read-tool)
                      {:path "sample.txt" :offset 1 :limit 1}
                      first-result)))
              (is (= "beta" (:content read-result)))
              (is (= 1 (:line-count read-result)))
              (is (= 2 (:total-lines read-result)))
              (is (false? (:truncated read-result)))
              (is (= "beta\n\n[Read lines 2-2 of 2.]"
                     ((:render read-tool)
                      {:path "sample.txt" :offset 2 :limit 1}
                      read-result)))
              (let [beyond-eof-result
                    ((:execute read-tool)
                     {:path "sample.txt" :offset 3 :limit 1} {})]
                (is (= "" (:content beyond-eof-result)))
                (is (= 0 (:line-count beyond-eof-result)))
                (is (= 2 (:total-lines beyond-eof-result)))
                (is (= (str "[Offset 3 is beyond end of file "
                            "(2 lines total); no lines returned.]")
                       ((:render read-tool)
                        {:path "sample.txt" :offset 3 :limit 1}
                        beyond-eof-result))))
              (let [empty-result
                    ((:execute read-tool)
                     {:path "empty.txt" :offset 2 :limit 1} {})]
                (is (= "" (:content empty-result)))
                (is (= 0 (:total-lines empty-result)))
                (is (= (str "[Offset 2 is beyond end of file "
                            "(0 lines total); no lines returned.]")
                       ((:render read-tool)
                        {:path "empty.txt" :offset 2 :limit 1}
                        empty-result))))
              (let [empty-result
                    ((:execute read-tool)
                     {:path "empty.txt" :offset 1 :limit 1} {})]
                (is (= "[Read empty file (0 lines).]"
                       ((:render read-tool)
                        {:path "empty.txt" :offset 1 :limit 1}
                        empty-result))))
              (let [read-file-tool (kernel/tool ctx "read_file")
                    alias-result
                    ((:execute read-file-tool)
                     {:path "sample.txt" :offset 3 :limit 1} {})]
                (is (= "" (:content alias-result)))
                (is (= (str "[Offset 3 is beyond end of file "
                            "(2 lines total); no lines returned.]")
                       ((:render read-file-tool)
                        {:path "sample.txt" :offset 3 :limit 1}
                        alias-result)))))
            ((:write! world) {:path "created.txt" :content "before"})
            ((:edit! world) {:path "created.txt" :old-text "before"
                             :new-text "after"})
            (is (= "after" (slurp (io/file directory "created.txt"))))
            (is (= #{"created.txt" "empty.txt" "escape.txt" "sample.txt"}
                   (set (:items ((:find! world) {:pattern "*.txt"})))))
            (is (= "sample.txt" (get-in ((:search! world)
                                          {:query "beta"})
                                         [:items 0 :path])))
            (is (= 0 (:exit-code ((:spawn! world)
                                   {:command "printf local-world"}))))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:read! world) {:path (str outside)})))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:read! world) {:path "escape.txt"})))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:write! world) {:path "escape.txt"
                                           :content "must-not-write"})))
            (is (= "secret" (slurp outside)))
            (is (every? #(kernel/tool ctx %)
                        ["read" "write" "edit" "bash" "grep" "find" "ls"])))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! directory)
        (.delete outside)))))

(deftest unsupported-platform-keeps-safe-agent-tools-available
  (is (= :unavailable
         (sandbox/resolve-mode
          :auto {:os-name "Linux" :seatbelt-executable? false})))
  (is (= :none
         (sandbox/resolve-mode
          :none {:os-name "Linux" :seatbelt-executable? false})))
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo #"requires macOS"
       (sandbox/resolve-mode
        :seatbelt {:os-name "Linux" :seatbelt-executable? false})))
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-safe-degrade-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.execution-world
                :config {:root (str directory) :sandbox :unavailable}}
               {:ns 'qi.plugins.tools}
               {:ns 'qi.plugins.bb-repl
                :config {:root (str directory) :sandbox :unavailable}}
               {:ns 'qi.plugins.clojure-repl}]})]
    (try
      (let [names (set (map :name (kernel/tools ctx)))
            world (kernel/require-service ctx :execution/world)
            repl (kernel/require-service ctx :execution/repl)]
        (is (every? names ["read" "write" "edit" "grep" "find" "ls"]))
        (is (not (contains? names "bash")))
        (is (not (contains? names "bb_repl")))
        (is (= #{:fs/read :fs/write} (:capabilities world)))
        (is (false? (:available? repl))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest seatbelt-execution-world-denies-outside-user-files
  (when (= "Mac OS X" (System/getProperty "os.name"))
    (let [base (doto (io/file
                      (str ".qi-agent-seatbelt-world-" (random-uuid)))
                 .mkdirs)
          directory (.toFile (java.nio.file.Files/createTempDirectory
                              (.toPath base)
                              "qi-agent-seatbelt-world-"
                              (make-array java.nio.file.attribute.FileAttribute 0)))
          outside (java.io.File/createTempFile
                   "qi-agent-world-secret-" ".txt" base)]
      (try
        (spit outside "must-not-leak")
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'qi.plugins.execution-world
                      :config {:root (str directory) :sandbox :seatbelt}}]})]
          (try
            (let [world (kernel/require-service ctx :execution/world)
                  denied ((:spawn! world)
                          {:command (str "cat " (pr-str (str outside)))})
                  allowed ((:spawn! world)
                           {:command "printf allowed > inside.txt"})]
              (is (= :seatbelt (:sandbox world)))
              (is (not= 0 (:exit-code denied)))
              (is (not (str/includes? (:stdout denied) "must-not-leak")))
              (is (= 0 (:exit-code allowed)))
              (is (= "allowed" (slurp (io/file directory "inside.txt")))))
            (finally (kernel/dispose-all! ctx))))
        (finally
          (delete-tree! directory)
          (.delete outside)
          (delete-tree! base))))))

(deftest trust-store-inherits-nearest-canonical-parent
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-trust-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        child (io/file directory "child")
        trust-file (io/file directory "trust.edn")]
    (.mkdir child)
    (try
      (spit trust-file (pr-str {:roots {(str directory) :allow
                                        (str child) :deny}}))
      (let [parent-ctx (plugin/boot!
                        {:plugins [{:ns 'qi.plugins.trust
                                    :config {:root (str directory)
                                             :trust-file (str trust-file)}}]})
            child-ctx (plugin/boot!
                       {:plugins [{:ns 'qi.plugins.trust
                                   :config {:root (str child)
                                            :trust-file (str trust-file)}}]})]
        (try
          (is ((:trusted? (kernel/require-service parent-ctx
                                                  :project/trust))))
          (is (not ((:trusted? (kernel/require-service child-ctx
                                                       :project/trust)))))
          (finally
            (kernel/dispose-all! parent-ctx)
            (kernel/dispose-all! child-ctx))))
      (finally (delete-tree! directory)))))

(deftest trust-command-persists-an-explicit-user-decision
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-trust-command-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        trust-file (io/file directory "user" "trust.edn")
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock :config {:responses []}}
               {:ns 'qi.plugins.runtime}
               {:ns 'qi.plugins.trust
                :config {:root (str directory)
                         :trust-file (str trust-file)}}]})]
    (try
      (let [trust (kernel/require-service ctx :project/trust)]
        (is (= :deny (get-in (command/dispatch! ctx "/trust")
                             [:output :decision])))
        (is (false? ((:trusted? trust))))
        (is (= :allow (get-in (command/dispatch! ctx "/trust allow")
                              [:output :decision])))
        (is ((:trusted? trust)))
        (is (= :allow
               (get-in (edn/read-string (slurp trust-file))
                       [:roots (str (.toPath (.getCanonicalFile directory)))])))
        (is (= :deny (get-in (command/dispatch! ctx "/trust deny")
                             [:output :decision])))
        (is (false? ((:trusted? trust))))
        (is (= "Usage: /trust allow | /trust deny"
               (:error (command/dispatch! ctx "/trust maybe")))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest session-catalog-indexes-metadata-without-following-links
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-catalog-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        outside (.toFile (java.nio.file.Files/createTempDirectory
                          "qi-agent-catalog-outside-"
                          (make-array java.nio.file.attribute.FileAttribute 0)))
        session-file (io/file directory "local.jsonl")]
    (try
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'qi.plugins.session
                             :config {:path (str session-file)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            ((:append! store) "message"
             {:message {:role "user" :content "catalog me"}})
            ((:name! store) "catalog-session")
            ((:label! store) "verified"))
          (finally (kernel/dispose-all! ctx))))
      (spit (io/file outside "outside.jsonl")
            (json/generate-string {:type "session/start"
                                   :data {:session_id "outside"}}))
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file directory "escape"))
       (.toPath outside)
       (make-array java.nio.file.attribute.FileAttribute 0))
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'qi.plugins.session-catalog
                             :config {:directory (str directory)}}]})]
        (try
          (let [entries ((:list (kernel/require-service ctx
                                                        :session/catalog)))]
            (is (= 1 (count entries)))
            (is (= "catalog-session" (:name (first entries))))
            (is (= "verified" (:label (first entries))))
            (is (= 1 (:message-count (first entries))))
            (is (not= "outside" (:session-id (first entries)))))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! directory)
        (delete-tree! outside)))))

(deftest context-manager-compacts-semantically-and-recovers-overflow-once
  (testing "budget compaction uses a semantic summary checkpoint"
    (let [requests (atom [])
          generate
          (fn [request]
            (swap! requests conj request)
            (if (:system-prompt request)
              {:message {:role "assistant"
                         :content "Goal: preserve the task; Pending: continue."}
               :finish-reason "stop"}
              {:message {:role "assistant" :content "done"}
               :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock :config {:generate generate}}
                 {:ns 'qi.plugins.context-manager
                  :config {:context-window 2000 :reserve-tokens 200
                           :chars-per-token 1.0 :retain-messages 1}}
                 {:ns 'qi.plugins.runtime}]})]
      (try
        (let [store (kernel/require-service ctx :session/store)
              _ ((:append! store) "message" {:message {:role "user" :content (apply str (repeat 3000 "x"))}})
              result ((kernel/require-service ctx :agent/run) "current instruction")
              events ((:events (kernel/require-service ctx :session/store)))
              runtime-request (last @requests)]
          (is (= "done" (:content result)))
          (is (some #(= "session/compaction" (:type %)) events))
          (is (= "user" (get-in runtime-request [:messages 0 :role])))
          (is (str/includes? (get-in runtime-request [:messages 0 :content])
                             "Goal: preserve")))
        (finally (kernel/dispose-all! ctx)))))

  (testing "provider overflow compacts and retries only once"
    (let [runtime-calls (atom 0)
          generate
          (fn [request]
            (if (:system-prompt request)
              {:message {:role "assistant" :content "compact summary"}
               :finish-reason "stop"}
              (if (= 1 (swap! runtime-calls inc))
                (throw (ex-info "context window exceeded"
                                {:context-overflow true}))
                {:message {:role "assistant" :content "recovered"}
                 :finish-reason "stop"})))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'qi.plugins.session}
                 {:ns 'qi.plugins.mock :config {:generate generate}}
                 {:ns 'qi.plugins.context-manager
                  :config {:context-window 10000 :reserve-tokens 100}}
                 {:ns 'qi.plugins.runtime}]})]
      (try
        (let [store (kernel/require-service ctx :session/store)]
          ((:append! store) "message" {:message {:role "user" :content "old request"}})
          ((:append! store) "message" {:message {:role "assistant" :content "old answer"}}))
        (is (= "recovered"
               (:content ((kernel/require-service ctx :agent/run) "hello"))))
        (is (= 2 @runtime-calls))
        (is (some #(= "session/compaction" (:type %))
                  ((:events (kernel/require-service ctx :session/store)))))
        (finally (kernel/dispose-all! ctx))))))

(deftest semantic-compaction-can-be-aborted
  (let [started (promise)
        generate
        (fn [{:keys [system-prompt cancel-token]}]
          (if system-prompt
            (do
              (deliver started true)
              (loop []
                (cancellation/throw-if-cancelled! cancel-token)
                (Thread/sleep 10)
                (recur)))
            {:message {:role "assistant" :content "unexpected"}
             :finish-reason "stop"}))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock :config {:generate generate}}
               {:ns 'qi.plugins.context-manager
                :config {:context-window 2000 :reserve-tokens 200
                         :chars-per-token 1.0 :retain-messages 1}}
               {:ns 'qi.plugins.runtime}]})]
    (try
      (let [session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)
            _ ((:append! store) "message" {:message {:role "user" :content (apply str (repeat 3000 "x"))}})
            {:keys [result]} ((:submit! session) "current instruction")
            before (System/nanoTime)]
        (is (= true (deref started 1000 :timeout)))
        (is (true? ((:abort! session))))
        (let [{:keys [ok error]} (deref result 1000 :timeout)
              elapsed-ms (/ (- (System/nanoTime) before) 1000000.0)
              events ((:events store))]
          (is (false? ok))
          (is (:cancelled (ex-data error)))
          (is (< elapsed-ms 1000))
          (is (some #(= "agent/aborted" (:type %)) events))
          (is (not-any? #(= "session/compaction" (:type %)) events))))
      (finally (kernel/dispose-all! ctx)))))

(deftest session-tree-checkout-name-and-label
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)]
        ((:append! store) "message" {:message {:role "user" :content "one"}})
        (let [branch-point (:active-leaf store)
              branch-id (branch-point)]
          ((:append! store) "message"
           {:message {:role "assistant" :content "two"}})
          ((:name! store) "demo")
          ((:label! store) "experiment")
          (is (= "demo" ((:name store))))
          (is (= "experiment" ((:label store))))
          (is (every? :parent-id (rest ((:tree store)))))
          (let [checkout ((:checkout! store) branch-id)]
            (is (= branch-id (:parent-id checkout)))
            (is (= [{:role "user" :content "one"}]
                   ((:messages store)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest trusted-resource-catalog-and-progressive-skill-loading
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-resources-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        resource-dir (io/file directory ".qi-agent")
        skill-dir (io/file resource-dir "skills" "demo")
        skill-file (io/file skill-dir "SKILL.md")]
    (.mkdirs skill-dir)
    (spit (io/file directory "AGENTS.md") "Project context")
    (spit skill-file
          "---\nname: demo-skill\ndescription: Demo capability\n---\nDo the demo.")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted true}}
                   {:ns 'qi.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str (io/file directory "user"))}}]})]
        (try
          (let [catalog (kernel/require-service ctx :resources/catalog)
                snapshot ((:snapshot catalog))]
            (is (= ["AGENTS.md"] (mapv :name (:contexts snapshot))))
            (is (= ["demo-skill"] (mapv :name (:skills snapshot))))
            (is (str/includes? (:content ((:load-skill catalog) "demo-skill"))
                               "Do the demo"))
            (is (kernel/tool ctx "load_skill"))
            (spit skill-file
                  "---\nname: demo-skill\ndescription: Updated\n---\nNew body.")
            (is (= "Updated" (get-in ((:reload! catalog))
                                      [:skills 0 :description])))
            (spit skill-file
                  (str "---\nname: demo-skill\ndescription: Updated\n"
                       "globs: not-an-array\n---\nBroken"))
            (is (thrown-with-msg? clojure.lang.ExceptionInfo #"globs"
                                  ((:reload! catalog))))
            (is (= "Updated" (get-in ((:snapshot catalog))
                                      [:skills 0 :description]))))
          (finally (kernel/dispose-all! ctx))))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted false}}
                   {:ns 'qi.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str (io/file directory "user"))}}]})]
        (try
          (let [snapshot ((:snapshot (kernel/require-service
                                      ctx :resources/catalog)))]
            (is (empty? (:contexts snapshot)))
            (is (empty? (:skills snapshot))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest omp-style-skill-resources-filters-and-precedence
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-skills-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        user-dir (io/file directory "user")
        project-skills (io/file directory ".qi-agent" "skills")
        user-demo (io/file user-dir "skills" "demo")
        project-demo (io/file project-skills "nested" "demo")
        hidden-dir (io/file project-skills "hidden")
        ignored-dir (io/file project-skills "ignored-one")]
    (doseq [path [user-demo project-demo hidden-dir ignored-dir]]
      (.mkdirs path))
    (spit (io/file user-demo "SKILL.md")
          "---\nname: demo\ndescription: User demo\n---\nUser body")
    (spit (io/file project-demo "SKILL.md")
          (str "---\nname: demo\ndescription: Project demo\n"
               "globs:\n  - '*.clj'\nalwaysApply: true\n"
               "extra-field: preserved\n---\nProject body"))
    (spit (io/file project-demo "reference.md") "Reference body")
    (spit (io/file hidden-dir "SKILL.md")
          "---\nname: hidden\ndescription: Hidden demo\nhide: true\n---\nHidden body")
    (spit (io/file ignored-dir "SKILL.md")
          "---\nname: ignored-one\ndescription: Ignore me\n---\nIgnored")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.execution-world
                    :config {:root (str directory) :sandbox :none}}
                   {:ns 'qi.plugins.tools}
                   {:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted true}}
                   {:ns 'qi.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str user-dir)
                             :skills {:include ["demo" "hidden" "ignored*"]
                                      :ignore ["ignored*"]}}}]})]
        (try
          (let [catalog (kernel/require-service ctx :resources/catalog)
                snapshot ((:snapshot catalog))
                demo (first (:skills snapshot))
                read-tool (kernel/tool ctx "read")
                skill-result ((:execute read-tool)
                              {:path "skill://demo" :offset 1 :limit 50} {})
                asset-result ((:execute read-tool)
                              {:path "skill://demo/reference.md"} {})]
            (is (= ["demo" "hidden"] (mapv :name (:skills snapshot))))
            (is (= ["demo"] (mapv :name (:model-skills snapshot))))
            (is (= :project (:scope demo)))
            (is (= ["*.clj"] (:globs demo)))
            (is (:always-apply demo))
            (is (= "preserved" (get-in demo [:metadata :extra-field])))
            (is (= :skill/name-collision
                   (get-in snapshot [:skill-warnings 0 :type])))
            (is (str/includes? (:content skill-result) "Project body"))
            (is (= "skill://demo" (:path skill-result)))
            (is (= "Reference body" (:content asset-result)))
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo #"escapes"
                 ((:read-skill-resource catalog)
                  {:path "skill://demo/../outside.md"})))
            (is (some #(= "skill:hidden" (:name %))
                      (command/commands ctx))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest agents-user-skills-load-without-project-trust
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-agents-user-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        agents-root (io/file directory ".agents" "skills")
        skill-dir (io/file agents-root "shared")]
    (.mkdirs skill-dir)
    (spit (io/file skill-dir "SKILL.md")
          "---\nname: shared\ndescription: Shared user skill\n---\nShared body")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted false}}
                   {:ns 'qi.plugins.resources
                    :config
                    {:root (str directory)
                     :user-dir (str (io/file directory "isolated-user"))
                     :skills
                     {:agents-user-directories [(str agents-root)]}}}]})]
        (try
          (let [snapshot ((:snapshot (kernel/require-service
                                      ctx :resources/catalog)))]
            (is (= ["shared"] (mapv :name (:skills snapshot))))
            (is (= :agents-user (get-in snapshot [:skills 0 :scope])))
            (is (false? (:project-trusted snapshot))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest skill-command-injects-body-and-arguments
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-skill-command-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        skill-dir (io/file directory ".qi-agent" "skills" "review")
        request-seen (promise)]
    (.mkdirs skill-dir)
    (spit (io/file skill-dir "SKILL.md")
          "---\nname: review\ndescription: Review code\n---\nInspect the diff carefully.")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.session}
                   {:ns 'qi.plugins.mock
                    :config {:generate
                             (fn [request]
                               (deliver request-seen request)
                               {:message {:role "assistant" :content "done"}
                                :finish-reason "stop"})}}
                   {:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted true}}
                   {:ns 'qi.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str (io/file directory "user"))}}
                   {:ns 'qi.plugins.runtime
                    :config {:system-prompt "test"}}]})]
        (try
          (let [result (command/dispatch! ctx "/skill:review src/core.clj")
                request (deref request-seen 1000 :timeout)
                prompt (get-in request [:messages 0 :content])]
            (is (= :submitted (get-in result [:output :status])))
            (is (str/includes? prompt "Inspect the diff carefully."))
            (is (str/includes? prompt "src/core.clj"))
            (is (not (str/includes? prompt "description: Review code")))
            (is (= "Skill was not found"
                   (:error (command/dispatch! ctx "/skill:missing")))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest subagent-inherits-parent-skill-catalog
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-child-skill-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        skill-dir (io/file directory ".qi-agent" "skills" "research")
        request-seen (promise)]
    (.mkdirs skill-dir)
    (spit (io/file skill-dir "SKILL.md")
          "---\nname: research\ndescription: Research evidence\n---\nFind evidence.")
    (try
      (let [ctx
            (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.trust
                :config {:root (str directory) :trusted true}}
               {:ns 'qi.plugins.resources
                :config {:root (str directory)
                         :user-dir (str (io/file directory "user"))}}
               {:ns 'qi.plugins.subagent}
               {:ns 'qi.plugins.subagent-in-process
                :config
                {:allowed-tools ["load_skill"]
                 :child-profile
                 {:plugins
                  [{:ns 'qi.plugins.session}
                   {:ns 'qi.plugins.mock
                    :config {:generate
                             (fn [request]
                               (deliver request-seen request)
                               {:message {:role "assistant" :content "done"}
                                :finish-reason "stop"})}}
                   {:ns 'qi.plugins.runtime
                    :config {:system-prompt "child"}}]}}}
               {:ns 'qi.plugins.subagent-tools}]})]
        (try
          (let [delegate (kernel/tool ctx "delegate_task")
                result ((:execute delegate)
                        {:prompt "research"
                         :tool_filter ["load_skill"]}
                        {:cancel-token (cancellation/create-token)})
                request (deref request-seen 1000 :timeout)]
            (is (= :completed (:stop-reason result)))
            (is (str/includes? (:system-prompt request) "Research evidence"))
            (is (= ["load_skill"]
                   (mapv #(get-in % [:function :name]) (:tools request)))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest omp-system-prompt-composition-order
  (let [stable-template @system-prompt/omp-template
        shared {:contexts [{:name "AGENTS.md" :scope :project
                            :content "Project rules"}]
                :skills [{:name "demo" :description "Demo skill"
                          :scope :project}]
                :tool-names ["read" "load_skill"]
                :workspace "/workspace/demo"
                :local-date "2026-08-19"
                :project-trusted true}
        normal (system-prompt/assemble
                (merge shared {:base-prompt "Stable base"
                               :append-prompt "Final addendum"}))
        custom (system-prompt/assemble
                (merge shared {:base-prompt "Stable base"
                               :custom-prompt "Custom system"
                               :append-prompt "Custom addendum"}))
        always (system-prompt/assemble
                (assoc shared
                       :base-prompt "Stable base"
                       :skills [{:name "policy" :description "Policy"
                                 :scope :project :always-apply true
                                 :body "Always follow this policy."}]))]
    (testing "the stable template prefers the persistent REPL without bypassing purpose-built tools"
      (is (str/includes? stable-template
                         "prefer it over `bash` for exact calculations"))
      (is (str/includes? stable-template
                         "Continue to use `read`, `grep`, `find`, and `ls`"))
      (is (str/includes? stable-template
                         "Never use `bb_repl` to bypass trust")))
    (testing "normal append content follows generated context"
      (is (< (str/index-of normal "Stable base")
             (str/index-of normal "Project rules")
             (str/index-of normal "Final addendum")))
      (is (str/includes? normal "load_skill, read")))
    (testing "SYSTEM replaces only the stable base and keeps generated blocks"
      (is (not (str/includes? custom "Stable base")))
      (is (< (str/index-of custom "Custom system")
             (str/index-of custom "Custom addendum")
             (str/index-of custom "Project rules")))
      (is (str/includes? custom "Demo skill"))
      (is (str/includes? custom "/workspace/demo")))
    (testing "alwaysApply skill bodies are injected without an extra read"
      (is (str/includes? always "Always-Applied Skill Instructions"))
      (is (str/includes? always "Always follow this policy.")))))

(deftest runtime-assembles-trusted-omp-prompt-resources
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-system-prompt-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        project-dir (io/file directory ".qi-agent")
        user-dir (io/file directory "user")
        request-seen (promise)]
    (.mkdirs project-dir)
    (.mkdirs user-dir)
    (spit (io/file directory "AGENTS.md") "Repository instructions")
    (spit (io/file directory "SYSTEM.md") "Repository system")
    (spit (io/file project-dir "SYSTEM.md") "Project custom system")
    (spit (io/file user-dir "SYSTEM.md") "User system")
    (spit (io/file user-dir "APPEND_SYSTEM.md") "User append")
    (spit (io/file project-dir "APPEND_SYSTEM.md") "Project append")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.session}
                   {:ns 'qi.plugins.mock
                    :config
                    {:generate
                     (fn [request]
                       (deliver request-seen request)
                       {:message {:role "assistant" :content "done"}
                        :finish-reason "stop"})}}
                   {:ns 'qi.plugins.trust
                    :config {:root (str directory) :trusted true}}
                   {:ns 'qi.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str user-dir)}}
                   {:ns 'qi.plugins.runtime
                    :config {:system-prompt "Configured base"}}]})]
        (try
          ((kernel/require-service ctx :agent/run) "work")
          (let [catalog (kernel/require-service ctx :resources/catalog)
                store (kernel/require-service ctx :session/store)
                snapshot ((:snapshot catalog))
                request (deref request-seen 1000 :timeout)
                prompt (:system-prompt request)
                context-event (first (filter #(= "context/snapshot" (:type %))
                                             ((:events store))))]
            (is (= ["AGENTS.md"] (mapv :name (:contexts snapshot))))
            (is (= 3 (count (:system-prompts snapshot))))
            (is (= "Project custom system"
                   (get-in snapshot [:system-prompt :content])))
            (is (= "Project append"
                   (get-in snapshot [:append-system-prompt :content])))
            (is (not (str/includes? prompt "Configured base")))
            (is (not (str/includes? prompt "User system")))
            (is (not (str/includes? prompt "User append")))
            (is (< (str/index-of prompt "Project custom system")
                   (str/index-of prompt "Project append")
                   (str/index-of prompt "Repository instructions")))
            (is (str/includes? prompt "load_skill"))
            (is (str/includes? prompt (str (fs/real-path directory))))
            (is (= prompt (get-in context-event [:data :content])))
            (is (= 1 (get-in context-event [:data :step]))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest external-project-plugin-cannot-self-assert-trust
  (let [error (try
                (plugin/boot! {:plugins [{:ns 'example.math}
                                         {:ns 'qi.plugins.trust
                                          :config {:trusted true}}]}
                              {:allow-external-plugins false})
                nil
                (catch Throwable error error))]
    (is (instance? clojure.lang.ExceptionInfo error))
    (is (str/includes? (ex-message error) "requires trust"))))

(deftest model-registry-selects-providers-at-runtime
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.model-registry}]})]
    (try
      (let [registry (kernel/require-service ctx :llm/registry)
            dispose-a ((:register! registry)
                       {:id :a :model "a-model"
                        :generate (fn [_] {:message {:content "a"}})})
            dispose-b ((:register! registry)
                       {:id :b :model "b-model"
                        :generate (fn [_] {:message {:content "b"}})})]
        (is (= "a" (get-in ((kernel/require-service ctx :llm/generate) {})
                            [:message :content])))
        ((:select! registry) :b)
        (is (= "b-model" (:model ((:current registry)))))
        (is (= "b" (get-in ((kernel/require-service ctx :llm/generate) {})
                            [:message :content])))
        (is (= #{:a :b} (set (map :id ((:providers registry))))))
        (dispose-b)
        (dispose-a))
      (finally (kernel/dispose-all! ctx)))))

(deftest model-registry-applies-selectable-thinking-levels
  (let [requests (atom [])
        ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.model-registry}]})]
    (try
      (let [registry (kernel/require-service ctx :llm/registry)]
        ((:register! registry)
         {:id :deepseek
          :provider :openai-compatible
          :model "deepseek-v4-flash"
          :thinking-levels [:off :low :high :max]
          :default-thinking-level :off
          :generate (fn [request]
                      (swap! requests conj request)
                      {:message {:content "ok"}})})
        (is (= :off (:thinking-level ((:current registry)))))
        (is (nil? (:generate (first ((:providers registry))))))
        ((:generate registry) {:options {}})
        (is (= {:thinking {:type "disabled"}}
               (:options (last @requests))))
        ((:select-thinking! registry) "high")
        ((:generate registry) {:options {:temperature 0}})
        (is (= {:thinking {:type "enabled"}
                :reasoning_effort "high"
                :temperature 0}
               (:options (last @requests))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo
                              #"not supported"
                              ((:select-thinking! registry) :ultra))))
      (finally (kernel/dispose-all! ctx)))))

(deftest remote-context-status-estimates-model-visible-budget
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.model-registry}
               {:ns 'qi.plugins.context-manager
                :config {:context-window 10000 :reserve-tokens 100
                         :chars-per-token 4.0}}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            registry (kernel/require-service ctx :llm/registry)
            status! (deref (ns-resolve 'qi.plugins.remote-api
                                       'context-status))]
        ((:register! registry)
         {:id :large-context
          :context-window 1000000
          :generate (fn [_] {:message {:content "ok"}})})
        ((:append! store) "context/snapshot"
         {:content "You are a careful coding agent."})
        ((:append! store) "message"
         {:message {:role "user" :content "Inspect the project."}})
        (let [status (status! ctx)]
          (is (= 1000000 (:context_window status)))
          (is (pos? (:system_tokens status)))
          (is (pos? (:message_tokens status)))
          (is (= (+ (:system_tokens status)
                    (:tool_tokens status)
                    (:message_tokens status))
                 (:used_tokens status)))
          (is (<= 0 (:percent status) 100))))
      (finally (kernel/dispose-all! ctx)))))

(deftest web-provider-settings-reload-models-and-credentials-at-runtime
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-provider-settings-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        settings (io/file directory "providers.json")
        write-settings!
        (fn [providers]
          (spit settings (json/generate-string {:version 1 :providers providers}))
          (fs/set-posix-file-permissions settings "rw-------"))]
    (try
      (write-settings!
       [{:id "acme"
         :name "Acme"
         :protocol "openai-completions"
         :baseUrl "https://gateway.example/v1"
         :apiKey "acme-secret"
         :models [{:id "acme-chat" :name "Acme Chat" :contextWindow 32000
                   :thinkingLevels ["off" "low" "high"]
                   :defaultThinkingLevel "off"}
                  {:id "acme-reason" :name "Acme Reason"}]}])
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.model-registry}
                   {:ns 'qi.plugins.auth-store}
                   {:ns 'qi.plugins.provider-settings
                    :config {:path (str settings)}}]})]
        (try
          (let [registry (kernel/require-service ctx :llm/registry)
                auth (kernel/require-service ctx :auth/store)
                settings-service (kernel/require-service ctx :provider/settings)]
            (is (= #{"acme-chat" "acme-reason"} (set (map :model ((:providers registry))))))
            (is (= "acme-chat" (:model ((:select! registry) :acme)))
                "legacy provider aliases resolve to a stable model identity")
            (is (= "Acme Chat" (:display-name ((:current registry)))))
            (is (= :off (:thinking-level ((:current registry)))))
            (is (= {:api-key "acme-secret"} ((:resolve! auth) :acme)))
            ((:select! registry) (:id (first (filter #(= "acme-reason" (:model %)) ((:providers registry))))))
            (write-settings!
             [{:id "acme"
               :name "Acme Updated"
               :protocol "openai-completions"
               :baseUrl "https://gateway.example/v1"
               :apiKey "acme-secret"
               :models [{:id "acme-chat" :name "Acme Chat"}
                        {:id "acme-reason" :name "Acme Reason Updated"}]}])
            ((:reload! settings-service))
            (is (= "acme-reason" (:model ((:current registry))))
                "editing a provider preserves the selected model")
            (write-settings!
             [{:id "bravo"
               :name "Bravo"
               :protocol "openai-responses"
               :baseUrl "https://responses.example/v1"
               :apiKey "bravo-secret"
               :models [{:id "bravo-1" :name "Bravo One"}]}])
            (is (= {:providers 1 :models 1 :path (str settings)}
                   (dissoc ((:reload! settings-service)) :warnings)))
            (is (= #{"bravo-1"} (set (map :model ((:providers registry))))))
            (is (= {:api-key "bravo-secret"} ((:resolve! auth) :bravo)))
            (is (thrown? clojure.lang.ExceptionInfo ((:resolve! auth) :acme))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest web-provider-reload-preserves-semantic-selection-and-thinking
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-provider-identity-" (make-array java.nio.file.attribute.FileAttribute 0)))
        file (io/file directory "settings.json")
        model (fn [id] {:id id :thinkingLevels ["low" "high"] :defaultThinkingLevel "low"})
        write! (fn [models] (spit file (json/generate-string
                                       {:version 1 :providers [{:id "other" :protocol "openai-completions"
                                                                :baseUrl "https://example.invalid/v1" :models [(model "Z")]}
                                                               {:id "review" :protocol "openai-completions"
                                                                :baseUrl "https://example.invalid/v1"
                                                                :models models}]})))]
    (try
      (write! (mapv model ["A" "B" "C"]))
      (fs/set-posix-file-permissions file "rw-------")
      (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.model-registry :config {:default-provider :review}}
                                       {:ns 'qi.plugins.auth-store}
                                       {:ns 'qi.plugins.provider-settings :config {:path (str file)}}]})]
        (try
          (let [registry (kernel/require-service ctx :llm/registry)
                reload! (:reload! (kernel/require-service ctx :provider/settings))
                entries (into {} (map (juxt :model :id) ((:providers registry))))
                current (:current registry)]
            (is (= "A" (:model (current))) "configured provider alias survives stable identity registration")
            ((:select! registry) (get entries "A"))
            ((:select-thinking! registry) :high)
            ((:select! registry) (get entries "B"))
            ((:select-thinking! registry) :high)
            (doseq [ids [["A" "B" "C"] ["C" "B" "A"] ["X" "B" "C"] ["B" "C"]]]
              (write! (mapv model ids))
              (is (empty? (:warnings (reload!))))
              (is (= (get entries "B") (:id (current))))
              (is (= "B" (:model (current))))
              (is (= :high (:thinking-level (current))))
              (when (some #{"A"} ids)
                (is (= :high (:thinking-level (first (filter #(= "A" (:model %)) ((:providers registry))))))
                    "also retain effort for models not currently selected")))
            (write! [(assoc (model "B") :thinkingLevels ["low"]) (model "C")])
            (is (= 1 (count (:warnings (reload!)))))
            (is (= :low (:thinking-level (current))))
            (write! [(model "C")])
            (is (= 1 (count (:warnings (reload!)))))
            (is (= "C" (:model (current))))
            (spit file "invalid-json")
            (is (thrown? Exception (reload!)))
            (is (= "C" (:model (current))) "invalid replacement leaves the working registry intact"))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest web-provider-settings-preserves-chatgpt-subscription-auth
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-chatgpt-provider-settings-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        auth-file (io/file directory "auth.json")
        settings (io/file directory "providers.json")]
    (try
      (spit auth-file
            (json/generate-string
             {:auth_mode "chatgpt"
              :tokens {:access_token "subscription-token"
                       :account_id "subscription-account"}}))
      (spit settings
            (json/generate-string
             {:version 1
              :providers
              [{:id "chatgpt"
                :name "ChatGPT 订阅"
                :protocol "chatgpt-subscription"
                :baseUrl "https://chatgpt.com/backend-api/codex"
                :models [{:id "gpt-5.6-sol" :name "gpt-5.6-sol"}
                         {:id "gpt-5.6-terra" :name "gpt-5.6-terra"}]}]}))
      (fs/set-posix-file-permissions settings "rw-------")
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.model-registry}
                   {:ns 'qi.plugins.auth-store}
                   {:ns 'qi.plugins.chatgpt
                    :config {:model "gpt-5.6-sol"
                             :auth-file (str auth-file)
                             :check-permissions false}}
                   {:ns 'qi.plugins.provider-settings
                    :config {:path (str settings)}}]})]
        (try
          (let [registry (kernel/require-service ctx :llm/registry)
                auth (kernel/require-service ctx :auth/store)]
            (is (= #{"gpt-5.6-sol" "gpt-5.6-terra"} (set (map :model ((:providers registry))))))
            (is (= {:access-token "subscription-token"
                    :account-id "subscription-account"}
                   ((:resolve! auth) :chatgpt))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest omp-anchored-edits-reject-stale-and-overlapping-work
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-omp-edit-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        target (io/file directory "sample.txt")]
    (spit target "one\ntwo\nthree\n")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.model-registry}
                   {:ns 'qi.plugins.execution-world
                    :config {:root (str directory) :sandbox :none}}
                   {:ns 'qi.plugins.omp
                    :config {:max-file-chars 10000 :max-edits 8}}]})]
        (try
          (let [read-tool (kernel/tool ctx "hash_read")
                edit-tool (kernel/tool ctx "hash_edit")
                first-read ((:execute read-tool) {:path "sample.txt"} {})
                anchors (mapv :anchor (:lines first-read))
                edited ((:execute edit-tool)
                        {:path "sample.txt"
                         :file_hash (:file_hash first-read)
                         :edits [{:op "replace"
                                  :start (anchors 1)
                                  :content "TWO"}
                                 {:op "insert_after"
                                  :start (anchors 2)
                                  :content "four"}]}
                        {})]
            (is (= "one\nTWO\nthree\nfour\n" (slurp target)))
            (is (= 2 (:edits edited)))
            (is (not= (:file_hash first-read) (:file_hash edited)))
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo
                 #"hash_read"
                 ((:execute edit-tool)
                  {:path "sample.txt"
                   :file_hash (:file_hash first-read)
                   :edits [{:op "delete" :start (anchors 0)}]}
                  {})))
            (let [latest ((:execute read-tool) {:path "sample.txt"} {})
                  first-anchor (get-in latest [:lines 0 :anchor])]
              (is (thrown-with-msg?
                   clojure.lang.ExceptionInfo
                   #"overlap"
                   ((:execute edit-tool)
                    {:path "sample.txt"
                     :file_hash (:file_hash latest)
                     :edits [{:op "replace" :start first-anchor
                              :content "ONE"}
                             {:op "delete" :start first-anchor}]}
                    {})))
              (spit target "externally changed\n")
              (is (thrown-with-msg?
                   clojure.lang.ExceptionInfo
                   #"changed after hash_read"
                   ((:execute edit-tool)
                    {:path "sample.txt"
                     :file_hash (:file_hash latest)
                     :edits [{:op "replace" :start first-anchor
                              :content "ONE"}]}
                    {})))
              (is (= "externally changed\n" (slurp target)))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest omp-role-router-selects-a-provider-without-changing-global-selection
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-omp-route-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.model-registry}
               {:ns 'qi.plugins.execution-world
                :config {:root (str directory) :sandbox :none}}
               {:ns 'qi.plugins.omp
                :config {:roles {:default :a :plan [:missing :b]}}}]})]
    (try
      (let [registry (kernel/require-service ctx :llm/registry)
            dispose-a ((:register! registry)
                       {:id :a :model "a-model"
                        :generate (fn [_] {:message {:content "a"}})})
            dispose-b ((:register! registry)
                       {:id :b :model "b-model"
                        :generate (fn [_] {:message {:content "b"}})})
            roles (kernel/require-service ctx :omp/roles)]
        (try
          (is (= :a (:id ((:current registry)))))
          (is (= :plan (:role ((:set! roles) :plan))))
          (is (= "b"
                 (get-in (kernel/waterfall
                          ctx :llm/request
                          {:messages [] :tools [] :options {}}
                          (:generate registry))
                         [:message :content])))
          (is (= :a (:id ((:current registry)))))
          (kernel/dispose-plugin! ctx :omp/coding-foundation)
          (is (nil? (kernel/tool ctx "hash_read")))
          (is (nil? (kernel/tool ctx "hash_edit")))
          (is (nil? (kernel/service ctx :omp/roles)))
          (is (nil? (kernel/command ctx "role")))
          (finally
            (dispose-b)
            (dispose-a))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest auth-store-resolves-credentials-dynamically
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.auth-store}]})]
    (try
      (let [store (kernel/require-service ctx :auth/store)
            calls (atom 0)
            dispose ((:register! store) :demo
                     (fn [] {:api-key (str "key-" (swap! calls inc))})
                     {:source :test})]
        (is (= {:api-key "key-1"} ((:resolve! store) :demo)))
        (is (= {:api-key "key-2"} ((:resolve! store) :demo)))
        (is (= [{:source :test :id :demo}] ((:providers store))))
        (dispose)
        (is (thrown? clojure.lang.ExceptionInfo
                     ((:resolve! store) :demo))))
      (finally (kernel/dispose-all! ctx)))))

(deftest expanded-schema-composition-and-constraints
  (is (empty? (schema/errors {:oneOf [{:type "string" :minLength 2}
                                      {:type "integer" :minimum 10}]}
                             "ok")))
  (is (seq (schema/errors {:anyOf [{:type "string" :pattern "^x"}
                                   {:type "integer" :minimum 10}]}
                          "no")))
  (is (empty? (schema/errors {:type ["string" "null"]} nil)))
  (is (seq (schema/errors {:type "array" :uniqueItems true}
                          [1 1]))))

(deftest public-api-and-versioned-json-projection
  (let [ctx (api/boot
             {:plugins
              [{:ns 'qi.plugins.session}
               {:ns 'qi.plugins.mock
                :config {:responses
                         [{:message {:role "assistant" :content "ok"}
                           :finish-reason "stop"}]}}
               {:ns 'qi.plugins.runtime}]})
        output (java.io.StringWriter.)]
    (try
      (binding [*out* output]
        (protocol/json-once! ctx "hello"))
      (let [lines (map #(json/parse-string % true)
                       (str/split-lines (str output)))]
        (is (every? #(= 1 (:version %)) lines))
        (is (= "result" (:type (last lines))))
        (is (some #(= "agent.turn/start" (:event %)) lines)))
      (finally (api/dispose! ctx)))))

(deftest versioned-json-projection-includes-tool-lifecycle-events
  (let [ctx (api/boot {:plugins [{:ns 'qi.plugins.session}
                                 {:ns 'qi.plugins.mock
                                  :config {:responses []}}
                                 {:ns 'qi.plugins.runtime}]})
        output (java.io.StringWriter.)]
    (try
      (binding [*out* output]
        (let [dispose (protocol/subscribe-json! ctx)]
          (try
            (kernel/emit! ctx :tool.execution/confirming
                          {:call-id "call-1"
                           :name "read"
                           :execution-id "execution-1"})
            (kernel/emit! ctx :tool.execution/start
                          {:call-id "call-1"
                           :name "read"
                           :execution-id "execution-1"
                           :started-at 1777000000123})
            (finally (dispose)))))
      (let [events (map #(json/parse-string % true)
                        (str/split-lines (str output)))
            confirming (first
                        (filter #(= "tool.execution/confirming" (:event %))
                                events))
            start (first (filter #(= "tool.execution/start" (:event %))
                                 events))]
        (is (= false (:durable confirming)))
        (is (= "execution-1" (get-in confirming [:data :execution-id])))
        (is (= false (:durable start)))
        (is (= "execution-1" (get-in start [:data :execution-id])))
        (is (= 1777000000123 (get-in start [:data :started-at]))))
      (finally (api/dispose! ctx)))))

(deftest versioned-json-projection-supports-durable-run-id-spellings
  (let [ctx (api/boot {:plugins [{:ns 'qi.plugins.session}
                                 {:ns 'qi.plugins.mock
                                  :config {:responses []}}
                                 {:ns 'qi.plugins.runtime}]})
        output (java.io.StringWriter.)
        durable-events
        [{:id "event-kebab" :seq 1 :type "agent/error"
          :run-id "outer-kebab" :data {}}
         {:id "event-snake" :seq 2 :type "agent/error"
          :run_id "outer-snake" :data {}}
         {:id "data-kebab" :seq 3 :type "agent/error"
          :data {:run-id "inner-kebab"}}
         {:id "data-snake" :seq 4 :type "agent/error"
          :data {:run_id "inner-snake"}}
         {:id "priority" :seq 5 :type "agent/error"
          :run-id "outer-kebab-first"
          :run_id "outer-snake-second"
          :data {:run-id "inner-kebab-third"
                 :run_id "inner-snake-fourth"}}]]
    (try
      (binding [*out* output]
        (let [dispose (protocol/subscribe-json! ctx)]
          (try
            (doseq [event durable-events]
              (kernel/emit! ctx :session/event event))
            (finally (dispose)))))
      (let [events (map #(json/parse-string % true)
                        (str/split-lines (str output)))]
        (is (every? :durable events))
        (is (= ["outer-kebab" "outer-snake" "inner-kebab" "inner-snake"
                "outer-kebab-first"]
               (mapv :run_id events))))
      (finally (api/dispose! ctx)))))

(deftest lsp-plugin-contract-and-document-synchronization
  (let [directory (.toFile
                   (java.nio.file.Files/createTempDirectory
                    "qi-agent-lsp-"
                    (make-array java.nio.file.attribute.FileAttribute 0)))
        source-directory (io/file directory "src")
        source-file (io/file source-directory "sample.clj")
        initial "(defn greet [name]\n  (str \"hello \" name))\n"
        updated "(defn greet [name]\n  (str \"hi \" name))\n"
        classpath (str (.getCanonicalPath (io/file "src"))
                       java.io.File/pathSeparator
                       (.getCanonicalPath (io/file "test")))
        bb (str (fs/which "bb"))]
    (.mkdirs source-directory)
    (spit (io/file directory "bb.edn") "{}\n")
    (spit source-file initial)
    (let [ctx
          (plugin/boot!
           {:plugins
            [{:ns 'qi.plugins.execution-world
              :config {:root (str directory) :sandbox :none}}
             {:ns 'qi.plugins.trust
              :config {:root (str directory) :trusted true}}
             {:ns 'qi.plugins.stdio-session}
             {:ns 'qi.plugins.lsp
              :config
              {:request-timeout-ms 2000
               :startup-timeout-ms 5000
               :failure-cooldown-ms 1000
               :diagnostic-wait-ms 100
               :servers
               [{:id :fake
                 :command [bb "-cp" classpath "-m" "qi.fake-lsp"]
                 :file-types [".clj"]
                 :language-id "clojure"
                 :root-markers ["bb.edn"]
                 :settings {:fake {:enabled true}}}]}}
             {:ns 'qi.plugins.lsp-tools}]})]
      (try
        (let [tool (kernel/require-service ctx :lsp/runtime)
              query! (:query! tool)]
          (testing "status is lazy and reports executable availability"
            (let [status (query! {:action "status"} {})]
              (is (= true (get-in status [:servers 0 :available])))
              (is (empty? (:clients status)))))

          (testing "initialize handles a colliding server request id"
            (let [result (query! {:action "definition"
                                  :file "src/sample.clj"
                                  :line 1 :symbol "greet"} {})]
              (is (= "src/sample.clj" (get-in result [:locations 0 :path])))
              (is (= {:line 1 :column 7}
                     (get-in result [:locations 0 :range :start])))))

          (testing "pull diagnostics are normalized to one-based positions"
            (let [result (query! {:action "diagnostics"
                                  :file "src/sample.clj"} {})]
              (is (= :pull (:source result)))
              (is (= {:line 1 :column 1}
                     (get-in result [:items 0 :range :start])))
              (is (= (str "chars=" (count initial))
                     (get-in result [:items 0 :message])))))

          (testing "current disk text is sent before the next query"
            (spit source-file updated)
            (let [result (query! {:action "hover"
                                  :file "src/sample.clj"
                                  :line 1 :symbol "greet"} {})]
              (is (str/includes? (get-in result [:hover :contents :value])
                                 "hi"))))

          (testing "request cancellation returns promptly and sends protocol cancellation"
            (let [token (cancellation/create-token)
                  result (future
                           (try
                             (query! {:action "references"
                                      :file "src/sample.clj"
                                      :line 1 :symbol "greet"}
                                     {:cancel-token token})
                             {:unexpected true}
                             (catch clojure.lang.ExceptionInfo error
                               (ex-data error))))]
              (Thread/sleep 30)
              (cancellation/cancel! token)
              (is (= true (:cancelled @result)))))

          (testing "reload gracefully removes active clients"
            ((:reload! tool))
            (is (empty? (:clients ((:status tool)))))
            (is (empty? ((:sessions
                          (kernel/require-service ctx
                                                  :execution/stdio-session)))))))
        (finally
          (kernel/dispose-all! ctx)
          (delete-tree! directory))))))


(deftest provider-settings-binds-environment-credentials-to-endpoints
  (let [directory (fs/create-temp-dir)
        file (io/file (str directory) "providers.json")
        boot (fn [] (plugin/boot!
                     {:plugins [{:ns 'qi.plugins.model-registry}
                                {:ns 'qi.plugins.auth-store}
                                {:ns 'qi.plugins.provider-settings :config {:path (str file)}}]}))]
    (try
      (doseq [provider [{:id "openai" :protocol "openai-responses"
                        :baseUrl "https://example.com/v1" :apiKeyEnv "OPENAI_API_KEY"}
                       {:id "openai" :protocol "openai-completions"
                        :baseUrl "https://example.com/v1" :apiKeyEnv "OPENAI_API_KEY"}
                       {:id "deepseek" :protocol "openai-completions"
                        :baseUrl "https://api.deepseek.com:8443" :apiKeyEnv "DEEPSEEK_API_KEY"}
                       {:id "other" :protocol "anthropic-messages"
                        :baseUrl "https://api.anthropic.com" :apiKeyEnv "HOME"}]]
        (spit file (json/generate-string {:version 1 :providers [(assoc provider :models [{:id "test"}])]}))
        (fs/set-posix-file-permissions file "rw-------")
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"[Cc]redential" (boot))
            (str "reject unsafe environment binding: " (dissoc provider :apiKeyEnv))))
      (spit file (json/generate-string {:version 1 :providers
                                      [{:id "openai" :protocol "openai-responses"
                                        :baseUrl "https://api.openai.com/v1"
                                        :apiKey "explicit-test-key" :models [{:id "test"}]}]}))
      (fs/set-posix-file-permissions file "rw-------")
      (let [ctx (boot)]
        (try (is (= {:api-key "explicit-test-key"}
                    ((:resolve! (kernel/require-service ctx :auth/store)) :openai)))
             (finally (kernel/dispose-all! ctx))))
      (fs/set-posix-file-permissions file "rw-r--r--")
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"[Oo]wner|[Pp]rivate" (boot)))
      (let [link (io/file (str directory) "linked.json")]
        (fs/set-posix-file-permissions file "rw-------")
        (fs/create-sym-link link file)
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"[Ss]ymbolic"
              (plugin/boot! {:plugins [{:ns 'qi.plugins.model-registry}
                                      {:ns 'qi.plugins.auth-store}
                                      {:ns 'qi.plugins.provider-settings :config {:path (str link)}}]}))))
      (finally (fs/delete-tree directory)))))

(deftest responses-direct-entry-and-generate-enforce-credential-scope
  (let [ctx (kernel/create-context)
        config {:model "test" :base-url "https://example.com/v1" :api-key "must-not-leak"}]
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"Refusing"
          (qi.plugins.openai-responses/provider-entry ctx config)))
    (with-redefs [http/post (fn [& _] (throw (ex-info "Unexpected HTTP dispatch" {})))]
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"Refusing"
            (qi.plugins.openai-responses/generate ctx config {:messages []}))))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"[Cc]redential"
          (qi.plugins.openai-responses/provider-entry ctx
            (assoc config :allow-custom-endpoint true :api-key-env "OPENAI_API_KEY"))))
    (is (map? (qi.plugins.openai-responses/provider-entry ctx
                (assoc config :allow-custom-endpoint true :credential-source :settings))))))

(defn -main []
  (let [{:keys [fail error]}
        (run-tests 'qi.test-runner 'qi.run-outcome-test 'qi.openai-integrity-test 'qi.tool-recovery-test 'qi.context-integrity-test 'qi.midturn-compaction-test 'qi.generation-test 'qi.provenance-test
                   'qi.web-test 'qi.presets-test 'qi.responses-schema-test 'qi.credential-boundary-test
                          'qi.chatgpt-catalog-test 'qi.owner-uid-test
                   'qi.runtime-inspect-test 'qi.runtime-lab-test
                   'qi.session-title-test 'qi.runtime-recovery-test
                   'qi.remote-snapshot-test 'qi.remote-interaction-cancel-test
                   'qi.computer-use-test 'qi.lcu-test 'qi.terminal-test
                   'qi.mcp-stdio-test 'qi.mcp-deadline-test 'qi.tool-images-test
                   'qi.attachments-test 'qi.jobs-test
                   'qi.mcp-http-test 'qi.mcp-client-test 'qi.web-tools-test
                   'qi.orchestration-test 'qi.orchestration-recovery-test
                   'qi.planning-protocol-test 'qi.automation-test
                   'qi.plugin-manager-test)]
    (when (pos? (+ fail error))
      (throw (ex-info "Tests failed" {:fail fail :error error})))))
