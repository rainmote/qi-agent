(ns qi.mcp-client-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [qi.kernel :as kernel]
            [qi.mcp-stdio :as stdio]
            [qi.plugin :as plugin]
            [qi.plugins.mcp-client :as client]
            [qi.mcp-http-test :as transport-test]))

(defn fixture [config & [world]]
  (let [ctx (kernel/create-context) owner (kernel/plugin-context ctx :test/services)
        trusted (atom true) approved (atom :allow) approvals (atom [])]
    (kernel/register-service! owner :execution/world (merge {:provider :local :sandbox :none :root (str (fs/absolutize "."))} world))
    (kernel/register-service! owner :project/trust {:trusted? #(deref trusted)})
    (kernel/register-service! owner :approval/request (fn [r] (swap! approvals conj r) @approved))
    (plugin/load-all! ctx [{:ns 'qi.plugins.policy} {:ns 'qi.plugins.remote-registry}
                          {:ns 'qi.plugins.mcp-client :config config}])
    {:ctx ctx :runtime (kernel/service ctx :mcp/runtime) :trusted trusted :approved approved :approvals approvals}))

(deftest no-default-connections-and-authorization-before-spawn
  (let [{:keys [ctx runtime trusted approved]} (fixture {:servers [{:id "local" :transport :stdio :command ["does-not-exist"]}]})]
    (try
      (is (= false (get-in ((:status runtime)) [:servers 0 :connected])))
      (reset! trusted false)
      (is (thrown-with-msg? Exception #"trusted" ((:connect! runtime) "local")))
      (reset! trusted true) (reset! approved :deny)
      (is (thrown-with-msg? Exception #"approved" ((:connect! runtime) "local")))
      (is (empty? (filter #(str/starts-with? (:name %) "mcp__") (kernel/tools ctx))))
      (is (:blocking ((:method (kernel/service ctx :remote/registry)) "mcp.configure")))
      (finally (kernel/dispose-all! ctx)))))

(deftest tool-projection-shares-one-output-budget-and-rejects-input-requests
  (let [result (client/projection "fixture" {:content [{:type "text" :text (apply str (repeat 80 "t"))}]
                                             :structuredContent {:value (apply str (repeat 80 "s"))}} 100)]
    (is (< (count (:text result)) 180))
    (is (str/includes? (:text result) "Truncated MCP output")))
  (is (thrown-with-msg? Exception #"unsupported" (client/projection "fixture" {:content [] :inputRequests [{}]} 100))))

(deftest stdio-cannot-escape-a-sandbox-or-override-transport-controls
  (doseq [world [{:sandbox :seatbelt} {:sandbox :unavailable} {:provider :remote}]]
    (let [{:keys [ctx runtime]} (fixture {:servers [{:id "locked" :transport :stdio :command ["irrelevant"]}]} world)
          spawns (atom 0)]
      (try
        (with-redefs [stdio/connect! (fn [_] (swap! spawns inc))]
          (is (thrown-with-msg? Exception #"unsandboxed" ((:connect! runtime) "locked"))))
        (is (zero? @spawns))
        (finally (kernel/dispose-all! ctx)))))
  (doseq [option [:scrub-env :on-notification :cancel-token]]
    (is (thrown-with-msg? Exception #"configuration option"
                         (fixture {:servers [(assoc {:id "locked" :transport :stdio :command ["irrelevant"]} option false)]})))))

(deftest real-stdio-servers-are-namespaced-and-unload-cleanly
  (let [command [(str (fs/which "bb")) "-cp" (str (fs/absolutize "test")) "-m" "qi.fake-computer-mcp"]
        {:keys [ctx runtime]} (fixture {:servers [{:id "one" :transport :stdio :command command :protocol-mode :legacy}
                                                 {:id "two" :transport :stdio :command command :protocol-mode :legacy}]})]
    (try
      ((:connect! runtime) "one") ((:connect! runtime) "two")
      (is (kernel/tool ctx "mcp__one__type_text"))
      (is (kernel/tool ctx "mcp__two__type_text"))
      (is (:requires-approval (kernel/tool ctx "mcp__one__type_text")))
      (let [result ((:execute (kernel/tool ctx "mcp__one__type_text")) {:text "fixture-text"} {})]
        (is (= "one" (get-in result [:source :server])))
        (is (str/includes? (:text result) "External untrusted"))
        (is (str/includes? (:text result) "fixture-text")))
      ((:disconnect! runtime) "one")
      (is (nil? (kernel/tool ctx "mcp__one__type_text")))
      (is (kernel/tool ctx "mcp__two__type_text"))
      (finally (kernel/dispose-all! ctx)))
    (is (empty? (kernel/tools ctx)))))

(deftest refresh-resources-modern-header-and-configure
  (let [revision (atom 1) calls (atom []) duplicate (atom false)
        tool (fn [name] {:name name :description "external" :inputSchema {:type "object" :properties {:enabled {:type "boolean" :x-mcp-header "Enabled"}}}})
        {:keys [url stop]} (transport-test/fixture
                           (fn [request]
                             (let [{:keys [id method params]} (json/parse-string (slurp (:body request)) true)]
                               (swap! calls conj [method request params])
                               (transport-test/reply id
                                (case method
                                  "server/discover" transport-test/discovery
                                  "tools/list" {:tools (if @duplicate [(tool "a") (tool "a")] [(tool (str "echo" @revision))])}
                                  "tools/call" {:content [{:type "text" :text "ok"}]}
                                  "resources/list" {:resources [{:uri "memory://known" :name "known"}]}
                                  "resources/read" {:contents [{:uri (:uri params) :text "source text"}]})))))
        {:keys [ctx runtime]} (fixture {:servers [{:id "http" :transport :streamable-http :url url}]})]
    (try
      ((:connect! runtime) "http")
      (let [tool (kernel/tool ctx "mcp__http__echo1")]
        ((:execute tool) {:enabled false} {})
        (is (= "false" (get-in (last @calls) [1 :headers "mcp-param-enabled"])))
        (reset! revision 2) ((:refresh! runtime) "http" {})
        (is (nil? (kernel/tool ctx "mcp__http__echo1"))))
      (is (kernel/tool ctx "mcp__http__echo2"))
      (reset! duplicate true)
      (is (thrown-with-msg? Exception #"duplicate" ((:refresh! runtime) "http" {})))
      (is (kernel/tool ctx "mcp__http__echo2"))
      (is (= "memory://known" (get-in ((:resources! runtime) "http" {}) [:resources 0 :uri])))
      (is (str/includes? (:text ((:read-resource! runtime) "http" "memory://known" {})) "source text"))
      (let [remote (kernel/service ctx :remote/registry)]
        ((:invoke! remote) "mcp.configure" {:servers [{:id "replacement" :transport "streamable-http" :url url
                                                      :headers {:x-fixture "normalized"} :enabled true}]})
        (is (= false (get-in ((:status runtime)) [:servers 0 :enabled])))
        (is (= false (get-in ((:status runtime)) [:servers 0 :connected])))
        (reset! duplicate false)
        ((:invoke! remote) "mcp.control" {:server "replacement" :action "connect"})
        (is (= "normalized" (get-in (last @calls) [1 :headers "x-fixture"]))))
      (is (nil? (kernel/tool ctx "mcp__http__echo2")))
      (finally (kernel/dispose-all! ctx) (stop)))))

(deftest modern-stdio-discovery-and-metadata
  (let [command [(str (fs/which "bb")) "-cp" (str (fs/absolutize "test")) "-m" "qi.fake-generic-mcp"]
        {:keys [ctx runtime]} (fixture {:servers [{:id "modern" :transport :stdio :command command}]})]
    (try
      ((:connect! runtime) "modern")
      (is (= "2026-07-28" (get-in ((:status runtime)) [:servers 0 :protocol-version])))
      (is (str/includes? (:text ((:execute (kernel/tool ctx "mcp__modern__echo")) {:text "modern works"} {})) "modern works"))
      (is (= "fixture://one" (get-in ((:resources! runtime) "modern" {}) [:resources 0 :uri])))
      (finally (kernel/dispose-all! ctx)))))

(deftest resource-approval-cannot-cross-connection-generations
  (let [command [(str (fs/which "bb")) "-cp" (str (fs/absolutize "test")) "-m" "qi.fake-generic-mcp"]
        {:keys [ctx runtime approvals]} (fixture {:servers [{:id "modern" :transport :stdio :command command}]})]
    (try
      ((:connect! runtime) "modern")
      (let [tool (kernel/tool ctx "mcp_resource_read") args {:server "modern" :uri "fixture://one"}
            approval ((:approval-target tool) args)
            before (last @approvals)]
        (is (= command (get-in before [:target :command])))
        (is (string? (get-in before [:target :cwd])))
        ((:invoke! (kernel/service ctx :remote/registry)) "mcp.configure"
         {:servers [{:id "modern" :transport "stdio" :protocol-mode "modern" :command command :env {:TEST_MCP "secret-test-value"}}]})
        ((:connect! runtime) "modern")
        (is (not= (get-in before [:target :path]) (get-in (last @approvals) [:target :path])))
        (is (not (str/includes? (pr-str @approvals) "secret-test-value")))
        (is (thrown-with-msg? Exception #"changed since resource approval" ((:execute tool) args {:approval approval})))
        (is (str/includes? (:text ((:execute tool) args {:approval ((:approval-target tool) args)})) "resource")))
      (finally (kernel/dispose-all! ctx)))))
