(ns qi.mcp-http-test
  (:require [cheshire.core :as json]
            [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [org.httpkit.server :as server]
            [qi.cancellation :as cancellation]
            [qi.mcp-http :as mcp]))

(defn fixture [handler]
  (let [stop (server/run-server handler {:ip "127.0.0.1" :port 0})]
    {:url (str "http://127.0.0.1:" (:local-port (meta stop)) "/mcp") :stop stop}))
(defn reply [id result & [headers]]
  {:status 200 :headers (merge {"content-type" "application/json"} headers)
   :body (json/generate-string {:jsonrpc "2.0" :id id :result result})})
(defn error-data [f] (try (f) nil (catch Throwable e (ex-data e))))
(def discovery {:resultType "complete" :supportedVersions ["2026-07-28"]
                :capabilities {:tools {} :resources {}}
                :_meta {"io.modelcontextprotocol/serverInfo" {:name "mock" :version "1"}}})

(deftest modern-json-sse-metadata-and-no-replay
  (let [requests (atom [])
        {:keys [url stop]} (fixture
                           (fn [request]
                             (let [{:keys [id method] :as message} (json/parse-string (slurp (:body request)) true)]
                               (swap! requests conj [request message])
                               (case method
                                 "server/discover" (reply id discovery)
                                 "tools/list" (reply id {:resultType "complete" :tools []})
                                 "tools/call" {:status 200 :headers {"content-type" "text/event-stream"}
                                               :body (str ": keepalive\n\ndata: "
                                                          (json/generate-string {:jsonrpc "2.0" :method "notifications/progress" :params {}})
                                                          "\n\ndata: " (json/generate-string {:jsonrpc "2.0" :id id :result {:content [{:type "text" :text "done"}]}}) "\n\n")}
                                 "resources/read" (reply id {:contents [{:uri "memory://a" :text "value"}]})))))]
    (try
      (let [client (mcp/connect! {:url url})]
        (try
          (is (= "2026-07-28" (:protocol-version client)))
          (is (= "done" (get-in ((:request! client) "tools/call" {:name "echo" :arguments {}} {}) [:content 0 :text])))
          (is (= "value" (get-in ((:request! client) "resources/read" {:uri "memory://a"} {}) [:contents 0 :text])))
          (doseq [[request message] @requests]
            (is (= "2026-07-28" (get-in request [:headers "mcp-protocol-version"])))
            (is (= (:method message) (get-in request [:headers "mcp-method"])))
            (is (= "2026-07-28" (get-in message [:params :_meta :io.modelcontextprotocol/protocolVersion]))))
          (is (= 1 (count (filter #(= "tools/call" (:method (second %))) @requests))))
          (finally ((:close! client)))))
      (finally (stop)))))

(deftest legacy-fallback-keeps-session-and-negotiated-version
  (doseq [fallback [:status :method-not-found]]
  (let [requests (atom [])
        {:keys [url stop]} (fixture
                           (fn [request]
                             (let [{:keys [id method] :as message} (json/parse-string (slurp (:body request)) true)]
                               (swap! requests conj [request message])
                               (case method
                                 "server/discover" (if (= :status fallback) {:status 400 :body "legacy requires initialize"}
                                                       {:status 200 :headers {"content-type" "application/json"}
                                                        :body (json/generate-string {:jsonrpc "2.0" :id id :error {:code -32601 :message "Method not found"}})})
                                 "initialize" (reply id {:protocolVersion "2025-06-18" :serverInfo {:name "legacy" :version "1"} :capabilities {:tools {}}} {"Mcp-Session-Id" "fixture-session"})
                                 "notifications/initialized" {:status 202 :body ""}
                                 "tools/list" (reply id {:tools []})))))]
    (try
      (let [client (mcp/connect! {:url url})]
        (try
          (is (= "2025-06-18" (:protocol-version client)))
          ((:request! client) "tools/list" {} {})
          (is (= "fixture-session" (get-in (first (last @requests)) [:headers "mcp-session-id"])))
          (is (= "2025-06-18" (get-in (first (last @requests)) [:headers "mcp-protocol-version"])))
          (is (= ["server/discover" "initialize" "notifications/initialized" "tools/list"] (mapv #(get-in % [1 :method]) @requests)))
          (finally ((:close! client)))))
      (finally (stop))))))

(deftest modern-protocol-error-never-falls-back
  (let [seen (atom []) {:keys [url stop]} (fixture
                                         (fn [r]
                                           (let [m (json/parse-string (slurp (:body r)) true)]
                                             (swap! seen conj (:method m))
                                             {:status 400 :headers {"content-type" "application/json"}
                                              :body (json/generate-string {:jsonrpc "2.0" :id (:id m) :error {:code -32022 :message "unsupported"}})})))]
    (try
      (is (= -32022 (get-in (error-data #(mcp/connect! {:url url})) [:mcp-error :code])))
      (is (= ["server/discover"] @seen))
      (finally (stop)))))

(deftest uncertain-timeout-and-response-limit-fail-closed
  (doseq [mode [:timeout :oversize]]
    (let [calls (atom 0) {:keys [url stop]} (fixture
                                          (fn [r]
                                            (let [m (json/parse-string (slurp (:body r)) true)]
                                              (if (= "server/discover" (:method m)) (reply (:id m) discovery)
                                                  (do (swap! calls inc)
                                                      (when (= mode :timeout) (try (Thread/sleep 250) (catch InterruptedException _)))
                                                      (reply (:id m) {:content [{:type "text" :text (apply str (repeat 3000 "x"))}]}))))))]
      (try
        (let [client (mcp/connect! {:url url :max-response-bytes 1024})]
          (try
            (let [e (error-data #((:request! client) "tools/call" {:name "effect"} {:timeout-ms (if (= mode :timeout) 80 3000)}))]
              (is (:uncertain e)) (is (not ((:alive? client)))))
            (is (= :closed (:mcp/transport-error (error-data #((:request! client) "tools/call" {:name "effect"} {})))))
            (is (= 1 @calls))
            (finally ((:close! client)))))
        (finally (stop))))))

(deftest cancellation-aborts-body-and-preserves-uncertainty
  (let [started (promise) token (cancellation/create-token)
        {:keys [url stop]} (fixture
                           (fn [r]
                             (let [m (json/parse-string (slurp (:body r)) true)]
                               (if (= "server/discover" (:method m)) (reply (:id m) discovery)
                                   (do (deliver started true) (try (Thread/sleep 500) (catch InterruptedException _)) (reply (:id m) {:content []}))))))]
    (try
      (let [client (mcp/connect! {:url url})]
        (try
          (let [task (future (error-data #((:request! client) "tools/call" {:name "effect"} {:cancel-token token}))) ]
            (is (deref started 1000 false))
            (cancellation/cancel! token)
            (let [e (deref task 2000 nil)] (is (:cancelled e)) (is (:uncertain e)))
            (is (not ((:alive? client)))))
          (finally ((:close! client)))))
      (finally (stop)))))

(deftest header-encoding-and-configuration
  (is (= "ascii" (mcp/header-value "ascii")))
  (is (str/starts-with? (mcp/header-value "中文") "=?base64?"))
  (is (str/starts-with? (mcp/header-value " padded ") "=?base64?"))
  (doseq [options [{:url "file:///tmp/a"} {:url "http://user:secret@localhost/mcp"}
                   {:url "http://localhost/mcp" :headers {"Mcp-Method" "secret"}}]]
    (is (some? (:mcp/config-error (error-data #(mcp/connect! options)))))))
