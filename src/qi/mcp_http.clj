(ns qi.mcp-http
  "Bounded MCP Streamable HTTP, modern metadata and legacy initialization.
  No redirects, request replay, credential discovery, OAuth, or persistent GET stream."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [qi.cancellation :as cancellation]
            [qi.mcp-stdio :as stdio])
  (:import [java.net URI]
           [java.net.http HttpClient HttpClient$Redirect HttpRequest HttpRequest$BodyPublishers HttpResponse$BodyHandlers]
           [java.time Duration]
           [java.io ByteArrayOutputStream InputStream]
           [java.nio.charset StandardCharsets]
           [java.util Base64]
           [java.util.concurrent TimeUnit]))

(defn header-value [value]
  (let [s (str value)]
    (if (and (= s (str/trim s)) (re-matches #"[\x20-\x7e\t]*" s)
             (not (and (str/starts-with? s "=?base64?") (str/ends-with? s "?="))))
      s (str "=?base64?" (.encodeToString (Base64/getEncoder) (.getBytes s StandardCharsets/UTF_8)) "?="))))

(defn- response-message! [message id on-notification]
  (when-not (and (map? message) (= "2.0" (:jsonrpc message)))
    (throw (ex-info "Invalid MCP JSON-RPC response" {:mcp/transport-error :invalid-message})))
  (if (:method message)
    (do (when (contains? message :id)
          (throw (ex-info "MCP server requests are unsupported" {:mcp/transport-error :unsupported-request})))
        (when on-notification (on-notification message)) nil)
    (do
      (when-not (and (= id (:id message))
                     (not= (contains? message :result) (contains? message :error)))
        (throw (ex-info "MCP response id or envelope is invalid" {:mcp/transport-error :invalid-message})))
      message)))

(defn- read-message! [^InputStream stream content-type limit id on-notification]
  (if (str/starts-with? content-type "text/event-stream")
    ;; Limit the entire response and each line before allocating text. Return at
    ;; the matching response; a server need not close its stream promptly.
    (loop [total 0 line (ByteArrayOutputStream.) data []]
      (let [b (.read stream)]
        (when (neg? b) (throw (ex-info "MCP SSE ended before its response" {:mcp/transport-error :eof})))
        (when (>= total limit) (throw (ex-info "MCP response exceeds byte limit" {:mcp/transport-error :response-too-large})))
        (if (= b 10)
          (let [s (str/replace (.toString line "UTF-8") #"\r$" "")]
            (if (empty? s)
              (if (seq data)
                (or (response-message! (json/parse-string (str/join "\n" data) true) id on-notification)
                    (recur (inc total) (ByteArrayOutputStream.) []))
                (recur (inc total) (ByteArrayOutputStream.) []))
              (recur (inc total) (ByteArrayOutputStream.)
                     (if (str/starts-with? s "data:")
                       (conj data (str/replace (subs s 5) #"^ " "")) data))))
          (do (.write line b) (recur (inc total) line data)))))
    (do
      (when-not (str/starts-with? content-type "application/json")
        (throw (ex-info "MCP response has unsupported content type" {:mcp/transport-error :content-type})))
      (let [buffer (byte-array 8192) out (ByteArrayOutputStream.)]
        (loop [total 0]
          (let [n (.read stream buffer)]
            (if (neg? n)
              (response-message! (json/parse-string (.toString out "UTF-8") true) id on-notification)
              (do (when (> (+ total n) limit)
                    (throw (ex-info "MCP response exceeds byte limit" {:mcp/transport-error :response-too-large})))
                  (.write out buffer 0 n) (recur (+ total n))))))))))

(defn connect!
  [{:keys [url headers protocol-mode request-timeout-ms startup-timeout-ms max-response-bytes
           on-notification cancel-token]
    :or {headers {} protocol-mode :auto request-timeout-ms 30000 startup-timeout-ms 10000
         max-response-bytes 2097152}}]
  (let [uri (try (URI. (str url)) (catch Throwable _ nil))]
    (when-not (and uri (contains? #{"http" "https"} (.getScheme uri)) (.getHost uri)
                   (nil? (.getUserInfo uri)) (nil? (.getFragment uri)))
      (throw (ex-info "MCP endpoint must be an absolute HTTP(S) URL without userinfo or fragment" {:mcp/config-error :url})))
    (when-not (and (contains? #{:auto :modern :legacy} protocol-mode)
                   (every? pos-int? [request-timeout-ms startup-timeout-ms max-response-bytes])
                   (map? headers)
                   (every? (fn [[k v]]
                             (and (string? k) (re-matches #"[A-Za-z0-9-]+" k)
                                  (not (contains? #{"host" "content-length" "accept" "content-type"
                                                    "mcp-protocol-version" "mcp-session-id" "mcp-method" "mcp-name"}
                                                  (str/lower-case k)))
                                  (not (str/starts-with? (str/lower-case k) "mcp-param-"))
                                  (string? v) (not (re-find #"[\r\n]" v)))) headers))
      (throw (ex-info "Invalid MCP HTTP configuration" {:mcp/config-error :options})))
    (let [http (-> (HttpClient/newBuilder) (.followRedirects HttpClient$Redirect/NEVER)
                   (.connectTimeout (Duration/ofMillis startup-timeout-ms)) .build)
          active? (atom true) pending (atom {}) next-id (atom 0)
          modern? (atom (not= protocol-mode :legacy)) version (atom "2025-11-25") session (atom nil)
          close! (fn [] (reset! active? false)
                   (doseq [abort (vals @pending)] (abort)) (reset! pending {})
                   (try (.shutdownNow http) (catch Throwable _)) nil)
          post!
          (fn [method params {:keys [timeout-ms cancel-token mcp-headers notification?]
                             :or {mcp-headers {}}}]
            (cancellation/throw-if-cancelled! cancel-token)
            (when-not @active? (throw (ex-info "MCP connection is closed" {:mcp/transport-error :closed})))
            (let [id (swap! next-id inc) timeout (or timeout-ms request-timeout-ms)
                  _ (when-not (pos-int? timeout) (throw (ex-info "MCP timeout must be positive" {})))
                  message (cond-> {:jsonrpc "2.0" :method method
                                   :params (if @modern? (stdio/modern-params params) (or params {}))}
                            (not notification?) (assoc :id id))
                  body (json/generate-string message)
                  _ (when (> (count (.getBytes body StandardCharsets/UTF_8)) max-response-bytes)
                      (throw (ex-info "MCP request exceeds byte limit" {})))
                  builder (-> (HttpRequest/newBuilder uri) (.timeout (Duration/ofMillis timeout))
                              (.header "Content-Type" "application/json")
                              (.header "Accept" "application/json, text/event-stream")
                              (.POST (HttpRequest$BodyPublishers/ofString body)))
                  _ (doseq [[k v] headers] (.header builder k v))
                  _ (.header builder "MCP-Protocol-Version" (if @modern? stdio/modern-protocol-version @version))
                  _ (when @modern?
                      (.header builder "Mcp-Method" method)
                      (when-let [name (or (:name params) (:uri params))]
                        (.header builder "Mcp-Name" (header-value name)))
                      (doseq [[k v] mcp-headers] (.header builder k (header-value v))))
                  _ (when (and (not @modern?) @session) (.header builder "Mcp-Session-Id" @session))
                  stream (atom nil) sending (atom nil) stopped? (atom false) dispatched? (atom false)
                  abort (fn [] (reset! stopped? true)
                          (when-let [f @sending] (.cancel f true))
                          (when-let [s @stream] (try (.close s) (catch Throwable _))))
                  _ (swap! pending assoc id abort)
                  dispose (cancellation/on-cancel! cancel-token abort)
                  task (future
                         (try
                           (when @stopped? (throw (ex-info "MCP request was cancelled" {:cancelled true})))
                           (reset! dispatched? true)
                           (let [f (.sendAsync http (.build builder) (HttpResponse$BodyHandlers/ofInputStream))
                                 _ (reset! sending f)
                                 _ (when @stopped? (.cancel f true))
                                 response (.get f timeout TimeUnit/MILLISECONDS)
                                 s (.body response) _ (reset! stream s)
                                 status (.statusCode response)
                                 content-type (or (.orElse (.firstValue (.headers response) "content-type") nil) "")]
                             (when @stopped? (abort) (throw (ex-info "MCP request was cancelled" {:cancelled true})))
                             (with-open [s s]
                               (if notification?
                                 (do (when-not (= 202 status) (throw (ex-info "MCP notification rejected" {:http-status status}))) {})
                                 (let [message (try (read-message! s content-type max-response-bytes id on-notification)
                                                    (catch Throwable e
                                                      (throw (ex-info (ex-message e) (assoc (ex-data e) :http-status status) e))))]
                                   (when-let [sid (.orElse (.firstValue (.headers response) "mcp-session-id") nil)]
                                     (when (= method "initialize")
                                       (when-not (and (<= (count sid) 1024) (re-matches #"[\x21-\x7e]+" sid))
                                         (throw (ex-info "Invalid MCP session id" {})))
                                       (reset! session sid)))
                                   (when (:error message)
                                     (throw (ex-info "MCP server returned a JSON-RPC error"
                                                     {:mcp-error (:error message) :http-status status :mcp/rpc-error true})))
                                   (when-not (<= 200 status 299)
                                     (throw (ex-info "MCP HTTP request failed" {:http-status status})))
                                   (:result message)))))
                           (catch Throwable e e)))]
              (try
                (let [outcome (deref task timeout ::timeout)]
                  (cond
                    (= ::timeout outcome) (do (abort) (future-cancel task)
                                              (throw (ex-info "MCP request timed out" {:timeout true})))
                    (instance? Throwable outcome) (throw outcome)
                    :else outcome))
                (catch Throwable e
                  (let [uncertain (and (= method "tools/call") @dispatched? (not (:mcp/rpc-error (ex-data e))))]
                    (when uncertain (close!))
                    (throw (ex-info (if (cancellation/cancelled? cancel-token) "MCP request was cancelled" (ex-message e))
                                    (cond-> (merge (ex-data e) {:method method :request-id id})
                                      uncertain (assoc :uncertain true)
                                      (cancellation/cancelled? cancel-token) (assoc :cancelled true)) e))))
                (finally (dispose) (swap! pending dissoc id)))))]
      (try
        (let [discovery (when @modern?
                          (try (post! "server/discover" {} {:timeout-ms startup-timeout-ms :cancel-token cancel-token})
                               (catch Throwable e
                                 (if (and (= protocol-mode :auto)
                                          (or (contains? #{400 404 405} (:http-status (ex-data e)))
                                              (= -32601 (get-in (ex-data e) [:mcp-error :code])))
                                          (not (contains? #{-32020 -32021 -32022} (get-in (ex-data e) [:mcp-error :code]))))
                                   (do (reset! modern? false) nil) (throw e)))))
              initialized (when-not discovery
                            (post! "initialize" {:protocolVersion @version :capabilities {}
                                                 :clientInfo {:name "qi-agent" :version "1"}}
                                   {:timeout-ms startup-timeout-ms :cancel-token cancel-token}))
              capabilities (:capabilities (or discovery initialized))]
          (when-not (and (map? capabilities)
                         (if discovery (some #{stdio/modern-protocol-version} (:supportedVersions discovery))
                             (contains? #{"2025-03-26" "2025-06-18" "2025-11-25"} (:protocolVersion initialized))))
            (throw (ex-info "MCP server returned unsupported discovery/initialization" {:mcp/transport-error :initialize})))
          (when initialized
            (reset! version (:protocolVersion initialized))
            (post! "notifications/initialized" {} {:notification? true :timeout-ms startup-timeout-ms}))
          {:request! post! :close! close! :alive? #(deref active?)
           :protocol-version (if discovery stdio/modern-protocol-version @version)
           :capabilities capabilities
           :server-info (if discovery (get-in discovery [:_meta :io.modelcontextprotocol/serverInfo]) (:serverInfo initialized))})
        (catch Throwable e (close!) (throw e))))))
