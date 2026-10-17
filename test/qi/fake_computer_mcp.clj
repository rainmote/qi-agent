(ns qi.fake-computer-mcp
  "Offline MCP fixture. Never interacts with a real desktop."
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]))

(def png
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")

(def tools
  [{:name "screenshot" :description "Capture the fake desktop"
    :inputSchema {:type "object" :properties {} :additionalProperties false}}
   {:name "click" :description "Click a fake coordinate"
    :inputSchema {:type "object"
                  :properties {:x {:type "number"} :y {:type "number"}}
                  :required ["x" "y"] :additionalProperties false}}
   {:name "type_text" :description "Type fake text"
    :inputSchema {:type "object" :properties {:text {:type "string"}}
                  :required ["text"] :additionalProperties false}}])

(defn -main [& args]
  (let [mode (or (first args) (System/getenv "QI_FAKE_MCP_MODE") "normal")
        delay-ms (parse-long (or (System/getenv "QI_FAKE_MCP_DELAY_MS") "5000"))
        events-path (System/getenv "QI_FAKE_MCP_EVENTS")
        pid-path (System/getenv "QI_FAKE_MCP_PID_FILE")
        output System/out
        output-lock (Object.)
        initialized? (atom false)
        server-responses (atom {})
        record! (fn [message]
                  (when events-path
                    (spit events-path (str (json/generate-string message) "\n")
                          :append true)))
        send! (fn [message]
                (locking output-lock
                  (.println output (json/generate-string message))
                  (.flush output)))
        reply! (fn [id result] (send! {:jsonrpc "2.0" :id id :result result}))
        text-result (fn [text] {:content [{:type "text" :text text}]})]
    (when pid-path (spit pid-path (str (.pid (java.lang.ProcessHandle/current)))))
    (with-open [reader (io/reader System/in)]
      (loop []
        (when-let [line (.readLine reader)]
          (let [{:keys [id method params] :as message} (json/parse-string line true)]
            (record! message)
            (case method
              "initialize"
              (do
                (when (= mode "startup-timeout") (Thread/sleep delay-ms))
                (when (= mode "startup-exit") (System/exit 17))
                (when (= mode "server-requests")
                  ;; Server request IDs can collide with client request IDs.
                  (send! {:jsonrpc "2.0" :id id :method "sampling/createMessage"
                          :params {}})
                  (send! {:jsonrpc "2.0" :id "ping" :method "ping"}))
                (reply! id {:protocolVersion (or (System/getenv "QI_FAKE_MCP_VERSION")
                                                (:protocolVersion params))
                            :serverInfo {:name "fake-computer" :version "1"}
                            :capabilities {:tools {}}}))

              "notifications/initialized"
              (do (reset! initialized? true)
                  (when (= mode "stdin-stall") (Thread/sleep delay-ms)))

              "tools/list"
              (do
              (when (= mode "delayed-list") (Thread/sleep delay-ms))
              (if @initialized?
                (if (= mode "paginated")
                  (reply! id (if (:cursor params)
                               {:tools (subvec tools 1)}
                               {:tools [(first tools)] :nextCursor "page-2"}))
                  (reply! id {:tools tools}))
                (send! {:jsonrpc "2.0" :id id
                        :error {:code -32000 :message "Not initialized"}})))

              "tools/call"
              (let [tool (:name params)
                    arguments (:arguments params)]
                (case tool
                  "screenshot" (reply! id {:content [{:type "image" :mimeType "image/png"
                                                      :data png}]})
                  "click" (reply! id (text-result "clicked"))
                  "type_text" (reply! id (text-result (:text arguments)))
                  "echo" (reply! id (text-result (json/generate-string arguments)))
                  "inspect" (reply! id {:initialized @initialized?
                                        :server-responses @server-responses
                                        :cwd (.getCanonicalPath (io/file "."))
                                        :argv (vec args)
                                        :env (System/getenv "QI_FAKE_MCP_VALUE")})
                  "delayed" (future
                              (Thread/sleep (long (or (:delay_ms arguments) delay-ms)))
                              (reply! id (text-result (or (:value arguments) "delayed"))))
                  "exit" (System/exit 19)
                  "malformed" (do (.println output "{broken json") (.flush output))
                  "invalid" (send! {:jsonrpc "2.0" :id id :result {} :error {}})
                  "incomplete" (do (.print output "{\"jsonrpc\":")
                                     (.flush output) (System/exit 20))
                  "oversized" (do (.print output (apply str (repeat 10000 "x")))
                                    (.flush output))
                  "large_image" (reply! id {:content [{:type "image" :mimeType "image/png"
                                                       :data (apply str (repeat (* 12 1024 1024) "a"))}]})
                  "stderr" (do (.println System/err (apply str (repeat 20000 "e")))
                                (.flush System/err)
                                (reply! id (text-result "stderr written")))
                  "rpc_error" (send! {:jsonrpc "2.0" :id id
                                      :error {:code -32602 :message "Invalid fixture arguments"}})
                  "tool_error" (reply! id {:isError true :content [{:type "text" :text "Fixture error"}]})
                  (send! {:jsonrpc "2.0" :id id
                          :error {:code -32601 :message "Unknown fixture tool"}})))

              ;; Record replies to server requests, without treating their IDs
              ;; as responses to the client's initialize call.
              nil (swap! server-responses assoc (str id) (dissoc message :jsonrpc :id))
              nil)
            (recur)))))))
