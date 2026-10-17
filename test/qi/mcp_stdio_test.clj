(ns qi.mcp-stdio-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing]]
            [qi.cancellation :as cancellation]
            [qi.mcp-stdio :as mcp]))

(defn- fixture-config []
  {:command [(str (fs/which "bb")) "-cp" (str (fs/absolutize "test"))
             "-m" "qi.fake-computer-mcp"]
   :cwd (str (fs/absolutize "."))
   :startup-timeout-ms 3000 :request-timeout-ms 3000})

(defn- thrown-data [f]
  (try (f) nil (catch clojure.lang.ExceptionInfo error (ex-data error))))

(defn- call! [client tool arguments & [options]]
  ((:request! client) "tools/call" {:name tool :arguments (or arguments {})} options))

(defn- eventually [predicate]
  (loop [remaining 150]
    (cond (predicate) true
          (zero? remaining) false
          :else (do (Thread/sleep 10) (recur (dec remaining))))))

(defn- process-alive? [pid]
  (let [handle (java.lang.ProcessHandle/of pid)]
    (and (.isPresent handle) (.isAlive (.get handle)))))

(defn- event-messages [path]
  (if (fs/exists? path)
    (with-open [reader (io/reader (str path))]
      (mapv #(json/parse-string % true) (line-seq reader)))
    []))

(deftest initializes-and-preserves-results
  (let [client (mcp/connect! (fixture-config))
        pid (:pid client)]
    (try
      (is (= {:name "fake-computer" :version "1"} (:server-info client)))
      (is (= "2025-06-18" (:protocol-version client)))
      (is ((:alive? client)))
      (is (= ["screenshot" "click" "type_text"]
             (mapv :name (:tools ((:request! client) "tools/list" {} nil)))))
      (is (= "image/png" (get-in (call! client "screenshot" {}) [:content 0 :mimeType])))
      (is (= "中文\nsecond line" (get-in (call! client "type_text" {:text "中文\nsecond line"})
                                         [:content 0 :text])))
      (is (= "2024-11-05"
             (let [old (mcp/connect! (assoc (fixture-config) :env
                                             {"QI_FAKE_MCP_VERSION" "2024-11-05"}))]
               (try (:protocol-version old) (finally ((:close! old)))))))
      (finally ((:close! client))))
    (is (not (process-alive? pid)))
    (is (not ((:alive? client))))
    ((:close! client))))

(deftest argv-cwd-env-and-handshake-contract
  (let [directory (fs/create-temp-dir {:prefix "qi-mcp-contract-"})
        events (str (fs/path directory "events.jsonl"))
        literal "$(touch not-executed); literal argument"
        client (mcp/connect!
                (-> (fixture-config)
                    (update :command into ["normal" literal])
                    (assoc :cwd (str directory)
                           :env {"QI_FAKE_MCP_EVENTS" events
                                 "QI_FAKE_MCP_VALUE" "fixture-value"})))]
    (try
      (let [result (call! client "inspect" {})
            initialize (first (event-messages events))]
        (is (:initialized result))
        (is (= (str (fs/real-path directory)) (:cwd result)))
        (is (= ["normal" literal] (:argv result)))
        (is (= "fixture-value" (:env result)))
        (is (= {} (get-in initialize [:params :capabilities])))
        (is (= "2025-06-18" (get-in initialize [:params :protocolVersion])))
        (is (not (fs/exists? (fs/path directory "not-executed")))))
      (finally ((:close! client)) (fs/delete-tree directory)))))

(deftest server-requests-use-independent-id-namespace
  (let [client (mcp/connect! (assoc (fixture-config) :env
                                   {"QI_FAKE_MCP_MODE" "server-requests"}))]
    (try
      (let [responses (:server-responses (call! client "inspect" {}))]
        (is (= -32601 (get-in responses [:1 :error :code])))
        (is (= {} (get-in responses [:ping :result]))))
      (finally ((:close! client))))))

(deftest concurrent-requests-match-their-replies
  (let [client (mcp/connect! (fixture-config))]
    (try
      (let [requests (mapv (fn [n]
                             (future (get-in (call! client "delayed"
                                                    {:delay_ms (- 200 (* n 15))
                                                     :value (str n)})
                                             [:content 0 :text])))
                           (range 10))]
        (is (= (mapv str (range 10)) (mapv deref requests))))
      (finally ((:close! client))))))

(deftest tool-timeout-is-uncertain-and-closes-the-server
  (let [directory (fs/create-temp-dir {:prefix "qi-mcp-timeout-"})
        events (str (fs/path directory "events.jsonl"))
        client (mcp/connect! (assoc (fixture-config) :env {"QI_FAKE_MCP_EVENTS" events}))]
    (try
      (let [error (thrown-data #(call! client "delayed" {} {:timeout-ms 80}))]
        (is (:timeout error))
        (is (:uncertain error))
        (is (= "tools/call" (:method error)))
        (is (not ((:alive? client))))
        (is (not (process-alive? (:pid client))))
        (is (not (:uncertain (thrown-data #(call! client "click" {:x 1 :y 2})))))
        (is (= 1 (count (filter #(= "tools/call" (:method %)) (event-messages events))))))
      (finally ((:close! client)) (fs/delete-tree directory)))))

(deftest cancellation-is-immediate-and-does-not-retry
  (let [directory (fs/create-temp-dir {:prefix "qi-mcp-cancel-"})
        events (str (fs/path directory "events.jsonl"))
        client (mcp/connect! (assoc (fixture-config) :env {"QI_FAKE_MCP_EVENTS" events}))
        token (cancellation/create-token)]
    (try
      (let [request (future
                      (let [error (thrown-data #(call! client "delayed" {} {:cancel-token token}))]
                        {:error error :alive-at-return ((:alive? client))
                         :followup (thrown-data #(call! client "click" {:x 1 :y 2}))}))]
        (is (eventually #(some (fn [message] (= "tools/call" (:method message)))
                              (event-messages events))))
        (cancellation/cancel! token)
        (let [{:keys [error alive-at-return followup]} (deref request 1500 {})]
          (is (:cancelled error))
          (is (:uncertain error))
          (is (false? alive-at-return))
          (is (= :closed (:mcp/transport-error followup)))
          (is (not (:uncertain followup))))
        (is (not ((:alive? client))))
        (is (not (process-alive? (:pid client)))))
      (finally ((:close! client)) (fs/delete-tree directory))))
  (let [client (mcp/connect! (fixture-config))
        token (cancellation/create-token)]
    (try
      (cancellation/cancel! token)
      (let [error (thrown-data #(call! client "click" {:x 1 :y 2} {:cancel-token token}))]
        (is (:cancelled error))
        (is (not (:uncertain error)))
        (is ((:alive? client))))
      (finally ((:close! client))))))

(deftest connection-faults-fail-pending-with-uncertain-outcome
  (doseq [tool ["exit" "malformed" "invalid" "incomplete" "oversized"]]
    (testing tool
      (let [client (mcp/connect! (assoc (fixture-config) :max-message-chars 4096))]
        (try
          (let [delayed (future (thrown-data #(call! client "delayed" {})))
                _ (Thread/sleep 50)
                error (thrown-data #(call! client tool {}))]
            (is (:uncertain error))
            (is (:uncertain (deref delayed 1500 {})))
            (is (not ((:alive? client)))))
          (finally ((:close! client))))))))

(deftest rpc-error-and-tool-error-remain-distinct
  (let [client (mcp/connect! (fixture-config))]
    (try
      (let [error (thrown-data #(call! client "rpc_error" {}))]
        (is (= -32602 (get-in error [:mcp-error :code])))
        (is (not (:uncertain error))))
      (is (:isError (call! client "tool_error" {})))
      (is ((:alive? client)))
      (finally ((:close! client))))))

(deftest initialization-failures-reap-the-process
  (doseq [mode ["startup-timeout" "startup-exit" "unsupported-version"]]
    (let [directory (fs/create-temp-dir {:prefix "qi-mcp-startup-"})
          pid-file (str (fs/path directory "pid"))
          env (cond-> {"QI_FAKE_MCP_MODE" mode "QI_FAKE_MCP_PID_FILE" pid-file}
                (= mode "unsupported-version") (assoc "QI_FAKE_MCP_VERSION" "1900-01-01"))]
      (try
        (is (some? (thrown-data #(mcp/connect! (assoc (fixture-config)
                                                    :env env :startup-timeout-ms 250)))))
        (is (fs/exists? pid-file))
        (is (not (process-alive? (parse-long (slurp pid-file)))))
        (finally (fs/delete-tree directory))))))

(deftest image-messages-and-stderr-are-bounded
  (let [client (mcp/connect! (assoc (fixture-config) :stderr-tail-chars 1024))]
    (try
      (is (= (* 12 1024 1024)
             (count (get-in (call! client "large_image" {} {:timeout-ms 10000})
                            [:content 0 :data]))))
      (call! client "stderr" {})
      (is (eventually #(= 1024 (count ((:stderr-tail client))))))
      (finally ((:close! client))))))

(deftest invalid-configuration-does-not-expose-environment-values
  (doseq [options [{:command "sh -c something"}
                   {:command [42]}
                   {:env {"BAD=KEY" "secret-do-not-print"}}
                   {:request-timeout-ms 0}
                   {:max-message-chars -1}]]
    (let [error (try (mcp/connect! (merge (fixture-config) options))
                     nil (catch Exception error error))]
      (is (some? error))
      (is (not (.contains (str error) "secret-do-not-print"))))))

(deftest read-only-timeout-discards-late-reply-and-keeps-transport
  (let [client (mcp/connect! (assoc (fixture-config) :env
                                   {"QI_FAKE_MCP_MODE" "delayed-list"
                                    "QI_FAKE_MCP_DELAY_MS" "150"}))]
    (try
      (let [error (thrown-data #((:request! client) "tools/list" {} {:timeout-ms 30}))]
        (is (:timeout error))
        (is (not (:uncertain error)))
        (is ((:alive? client))))
      (is (= "clicked" (get-in (call! client "click" {:x 1 :y 2}) [:content 0 :text])))
      (finally ((:close! client))))))

(deftest blocked-stdin-cannot-defeat-timeout
  (let [client (mcp/connect! (assoc (fixture-config) :env
                                   {"QI_FAKE_MCP_MODE" "stdin-stall"}))]
    (try
      (let [result (future (thrown-data #(call! client "echo"
                                              {:text (apply str (repeat 1000000 "a"))}
                                              {:timeout-ms 150})))
            error (deref result 2500 ::timeout)]
        (is (:timeout error))
        (is (:uncertain error))
        (is (not ((:alive? client)))))
      (finally ((:close! client))))))

(deftest validation-before-dispatch-does-not-poison-the-connection
  (let [client (mcp/connect! (assoc (fixture-config) :max-message-chars 4096))
        token (cancellation/create-token)]
    (try
      (let [error (thrown-data #(call! client "echo"
                                      {:text (apply str (repeat 5000 "a"))}))]
        (is (= :message-too-large (:mcp/transport-error error)))
        (is (not (:uncertain error)))
        (is ((:alive? client))))
      (is (= "clicked" (get-in (call! client "click" {:x 1 :y 2} {:cancel-token token})
                                [:content 0 :text])))
      (cancellation/cancel! token)
      (is ((:alive? client)))
      (finally ((:close! client))))))

(deftest startup-cancellation-reaps-the-process
  (let [directory (fs/create-temp-dir {:prefix "qi-mcp-startup-cancel-"})
        pid-file (str (fs/path directory "pid"))
        token (cancellation/create-token)
        started (future (thrown-data #(mcp/connect!
                                       (assoc (fixture-config)
                                              :cancel-token token
                                              :env {"QI_FAKE_MCP_MODE" "startup-timeout"
                                                    "QI_FAKE_MCP_PID_FILE" pid-file}))))]
    (try
      (is (eventually #(fs/exists? pid-file)))
      (cancellation/cancel! token)
      (is (:cancelled (deref started 1500 {})))
      (is (not (process-alive? (parse-long (slurp pid-file)))))
      (finally (fs/delete-tree directory)))))
