(ns qi.mcp-stdio
  "Owned MCP stdio subprocesses with bounded newline-delimited JSON-RPC.

  This transport neither authorizes tools nor retries requests. A dispatched
  tools/call that loses its reply has an uncertain outcome, even after killing
  the server: terminating a process cannot undo an external action."
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.cancellation :as cancellation])
  (:import [java.io BufferedReader InputStreamReader OutputStreamWriter]
           [java.nio.charset StandardCharsets]
           [java.util.concurrent TimeUnit]))

(def protocol-version "2025-06-18")
(def ^:private supported-protocol-versions
  #{"2024-11-05" "2025-03-26" "2025-06-18" "2025-11-25"})

(def modern-protocol-version "2026-07-28")

(defn modern-params [params]
  (assoc (or params {}) :_meta
         {"io.modelcontextprotocol/protocolVersion" modern-protocol-version
          "io.modelcontextprotocol/clientInfo" {:name "qi-agent" :version "1"}
          "io.modelcontextprotocol/clientCapabilities" {}}))

(defn- read-lines! [^BufferedReader reader limit handle-line!]
  ;; BufferedReader.readLine would allocate an unbounded string before we could
  ;; reject an oversized (or unterminated) frame.
  (let [buffer (StringBuilder.)
        characters (char-array 8192)]
    (loop []
      (let [size (.read reader characters)]
        (if (neg? size)
          (when (pos? (.length buffer))
            (throw (ex-info "MCP server closed an incomplete message"
                            {:mcp/transport-error :incomplete-message})))
          (do
            (let [chunk (String. characters 0 size)]
              (loop [offset 0]
                (when (< offset size)
                  (let [newline (.indexOf chunk "\n" offset)
                        end (if (neg? newline) size newline)]
                    (when (> (+ (.length buffer) (- end offset)) limit)
                      (throw (ex-info "MCP message exceeds the configured limit"
                                      {:mcp/transport-error :message-too-large
                                       :max-message-chars limit})))
                    (.append buffer (.substring chunk offset end))
                    (when-not (neg? newline)
                      (handle-line! (.toString buffer))
                      (.setLength buffer 0)
                      (recur (inc newline)))))))
            (recur)))))))

(defn- append-tail [old chunk limit]
  (let [value (str old chunk)]
    (subs value (max 0 (- (count value) limit)))))

(defn- pump-stderr! [process tail limit]
  (future
    (try
      (with-open [reader (InputStreamReader. (.getErrorStream process)
                                            StandardCharsets/UTF_8)]
        (let [buffer (char-array 2048)]
          (loop []
            (let [size (.read reader buffer)]
              (when-not (neg? size)
                (swap! tail append-tail (String. buffer 0 size) limit)
                (recur))))))
      (catch Throwable _))))

(defn- finish!
  ([entry envelope] (finish! entry envelope nil))
  ([entry envelope before-deliver]
   (loop []
     (let [previous @(:state entry)]
       (when-not (= :done (:phase previous))
         (if (compare-and-set! (:state entry) previous (assoc previous :phase :done))
           (do
             (try
               (when before-deliver (before-deliver previous))
               (finally
                 (deliver (:response entry)
                          (assoc envelope :dispatched? (:dispatched? previous)))))
             true)
           (recur)))))))

(defn- dispatch! [entry]
  (let [previous @(:state entry)]
    (and (= :queued (:phase previous))
         (compare-and-set! (:state entry) previous
                           {:phase :dispatched :dispatched? true}))))

(defn- valid-id? [id]
  (or (string? id) (integer? id)))

(defn- validate-message! [message]
  (when-not
   (and (map? message) (= "2.0" (:jsonrpc message))
        (if (contains? message :method)
          (and (string? (:method message))
               (not (str/blank? (:method message)))
               (not (contains? message :result))
               (not (contains? message :error))
               (or (not (contains? message :id)) (valid-id? (:id message))))
          (and (valid-id? (:id message))
               (not= (contains? message :result) (contains? message :error))
               (or (not (contains? message :error))
                   (let [error (:error message)]
                     (and (map? error) (integer? (:code error))
                          (string? (:message error))))))))
    (throw (ex-info "MCP server sent an invalid JSON-RPC message"
                    {:mcp/transport-error :invalid-message})))
  message)

(defn- validate-options!
  [{:keys [command env startup-timeout-ms request-timeout-ms
           max-message-chars stderr-tail-chars]}]
  (when-not (and (vector? command) (seq command)
                 (every? #(and (string? %) (not (str/includes? % "\u0000"))) command)
                 (not (str/blank? (first command))))
    (throw (ex-info "MCP command must be a non-empty argv vector"
                    {:mcp/config-error :command})))
  (when-not (and (map? env)
                 (every? (fn [[key value]]
                           (and (string? key) (not (str/blank? key))
                                (not (str/includes? key "="))
                                (not (str/includes? key "\u0000"))
                                (string? value)
                                (not (str/includes? value "\u0000")))) env))
    ;; Never include environment values in an exception or log.
    (throw (ex-info "MCP environment must contain valid string keys and values"
                    {:mcp/config-error :env})))
  (when-not (every? pos-int? [startup-timeout-ms request-timeout-ms
                            max-message-chars stderr-tail-chars])
    (throw (ex-info "MCP timeouts and message limits must be positive integers"
                    {:mcp/config-error :limits}))))

(defn connect!
  "Start and initialize a trusted argv subprocess. The caller owns authorization.

  Returns :request! (method params execution-options), :close!, :alive?,
  :server-info, :capabilities and :protocol-version. :request! returns the raw
  result; execution-options accepts :cancel-token and :timeout-ms. No request is
  automatically retried. A timeout/cancellation during tools/call closes this
  transport, preventing later calls from racing an unresolved external action."
  [{:keys [command cwd env startup-timeout-ms request-timeout-ms max-message-chars
           stderr-tail-chars cancel-token protocol-mode on-notification scrub-env]
    :or {cwd "." env {} startup-timeout-ms 10000 request-timeout-ms 30000
         max-message-chars 16777216 stderr-tail-chars 8192 protocol-mode :legacy}
    :as options}]
  (validate-options! (merge {:env env :startup-timeout-ms startup-timeout-ms
                             :request-timeout-ms request-timeout-ms
                             :max-message-chars max-message-chars
                             :stderr-tail-chars stderr-tail-chars}
                            options))
  (cancellation/throw-if-cancelled! cancel-token)
  (when-not (contains? #{:legacy :modern :auto} protocol-mode)
    (throw (ex-info "Invalid MCP protocol mode" {:mcp/config-error :protocol-mode})))
  (let [directory (.getCanonicalFile (io/file cwd))]
    (when-not (.isDirectory directory)
      (throw (ex-info "MCP working directory does not exist"
                      {:mcp/config-error :cwd :cwd (str directory)})))
    (let [builder (doto (ProcessBuilder. ^java.util.List command)
                    (.directory directory))
          _ (when scrub-env
              (doseq [key (vec (.keySet (.environment builder)))]
                (when (re-find #"(?i)(KEY|PASSWORD|SECRET|TOKEN|^QI_|^DSH_)" key)
                  (.remove (.environment builder) key))))
          _ (doseq [[key value] env] (.put (.environment builder) key value))
          process (.start builder)
          active? (atom true)
          closed (promise)
          pending (atom {})
          next-id (atom 0)
          modern? (atom (not= protocol-mode :legacy))
          write-lock (Object.)
          writer (OutputStreamWriter. (.getOutputStream process) StandardCharsets/UTF_8)
          stderr-tail (atom "")
          stop!
          (fn [reason]
            (when (compare-and-set! active? true false)
              (try
                (let [[entries _] (swap-vals! pending (constantly {}))]
                  (doseq [entry (vals entries)]
                    (finish! entry {:transport-error reason})))
                ;; Destroy before closing streams: a concurrent blocked writer
                ;; owns its stream monitor and must not block cancellation.
                (when (.isAlive process)
                  (.destroy process)
                  (when-not (.waitFor process 250 TimeUnit/MILLISECONDS)
                    (.destroyForcibly process)
                    (.waitFor process 1000 TimeUnit/MILLISECONDS)))
                (doseq [stream [(.getOutputStream process) (.getInputStream process)
                                (.getErrorStream process)]]
                  (try (.close stream) (catch Throwable _)))
                (finally (deliver closed true))))
            nil)
          close! #(do (stop! (ex-info "MCP connection was closed"
                                     {:mcp/transport-error :closed}))
                      ;; A reader may already be tearing down the process.
                      ;; Public close waits for that teardown as well.
                      @closed
                      nil)
          send!
          (fn [message entry]
            (let [encoded (json/generate-string message)]
              (when (> (count encoded) max-message-chars)
                (throw (ex-info "MCP request exceeds the configured limit"
                                {:mcp/transport-error :message-too-large})))
              (locking write-lock
                (when-not @active?
                  (throw (ex-info "MCP connection is closed"
                                  {:mcp/transport-error :closed})))
                (when (or (nil? entry) (dispatch! entry))
                  (.write writer encoded)
                  (.write writer "\n")
                  (.flush writer)))))
          request!
          (fn [method params {:keys [cancel-token timeout-ms]}]
            (cancellation/throw-if-cancelled! cancel-token)
            (when-not (and (string? method) (not (str/blank? method))
                           (or (nil? params) (map? params)))
              (throw (ex-info "Invalid MCP request" {:mcp/config-error :request})))
            (let [timeout (or timeout-ms request-timeout-ms)]
              (when-not (pos-int? timeout)
                (throw (ex-info "MCP request timeout must be a positive integer"
                                {:mcp/config-error :timeout})))
              (let [id (swap! next-id inc)
                    entry {:response (promise)
                           :state (atom {:phase :queued :dispatched? false})}
                    context {:method method :request-id id}
                    abort!
                    (fn [envelope]
                      (finish!
                       entry envelope
                       (fn [state]
                         (swap! pending dissoc id)
                         (when (and (= "tools/call" method) (:dispatched? state))
                           ;; Invalidate the connection before waking the
                           ;; caller, which might immediately try another tool.
                           (stop! (ex-info "MCP tool outcome is unknown; connection closed"
                                           (assoc context :uncertain true)))))))]
                (swap! pending assoc id entry)
                (let [dispose (cancellation/on-cancel!
                               cancel-token #(abort! {:cancelled true}))]
                  (try
                    ;; Writing runs separately so a server that stops reading
                    ;; stdin cannot prevent a timeout or cancellation.
                    (future
                      (try
                        (send! {:jsonrpc "2.0" :id id :method method
                                :params (if @modern? (modern-params params) (or params {}))} entry)
                        (catch Throwable error
                          (finish! entry {:transport-error error}
                                   (fn [state]
                                     (swap! pending dissoc id)
                                     (when (:dispatched? state) (stop! error)))))))
                    (let [initial (deref (:response entry) timeout ::timeout)
                          _ (when (= initial ::timeout) (abort! {:timed-out true}))
                          envelope (if (= initial ::timeout) @(:response entry) initial)
                          context (cond-> context
                                    (and (= "tools/call" method)
                                         (:dispatched? envelope)
                                         (or (:cancelled envelope) (:timed-out envelope)
                                             (:transport-error envelope)))
                                    (assoc :uncertain true))]
                      (cond
                        (:cancelled envelope)
                        (throw (ex-info "MCP request was cancelled"
                                        (assoc context :cancelled true)))
                        (:timed-out envelope)
                        (throw (ex-info "MCP request timed out"
                                        (assoc context :timeout true :timeout-ms timeout)))
                        (:transport-error envelope)
                        (throw (ex-info "MCP connection failed"
                                        (merge (select-keys (ex-data (:transport-error envelope))
                                                            [:mcp/transport-error]) context)
                                        (:transport-error envelope)))
                        (contains? (:message envelope) :error)
                        (throw (ex-info "MCP server returned a JSON-RPC error"
                                        (assoc context :mcp-error
                                               (get-in envelope [:message :error]))))
                        :else (get-in envelope [:message :result])))
                    (finally (dispose) (swap! pending dissoc id)))))))]
      (pump-stderr! process stderr-tail stderr-tail-chars)
      (future
        (try
          (with-open [reader (BufferedReader.
                             (InputStreamReader. (.getInputStream process)
                                                 StandardCharsets/UTF_8))]
            (read-lines!
             reader max-message-chars
             (fn [line]
                  (when-not (str/blank? line)
                    (let [message (validate-message! (json/parse-string line true))]
                      ;; The server's ID namespace is independent of ours.
                      (if (:method message)
                        (if (contains? message :id)
                          (send! (merge {:jsonrpc "2.0" :id (:id message)}
                                        (if (= "ping" (:method message))
                                          {:result {}}
                                          {:error {:code -32601
                                                   :message "Client capability is not supported"}}))
                                 nil)
                          (when on-notification (on-notification message)))
                        (when-let [entry (get @pending (:id message))]
                          (finish! entry {:message message})
                          (swap! pending dissoc (:id message))))))))
            (stop! (ex-info "MCP server closed stdout"
                            {:mcp/transport-error :eof})))
          (catch Throwable error (stop! error))))
      (try
        (let [discovery (when @modern?
                          (try
                            (request! "server/discover" {} {:timeout-ms startup-timeout-ms
                                                            :cancel-token cancel-token})
                            (catch Throwable error
                              (if (and (= :auto protocol-mode)
                                       (not (:cancelled (ex-data error)))
                                       (not (contains? #{-32020 -32021 -32022}
                                                       (get-in (ex-data error) [:mcp-error :code]))))
                                (do (reset! modern? false) nil)
                                (throw error)))))
              result (if discovery
                       {:protocolVersion modern-protocol-version
                        :capabilities (:capabilities discovery)
                        :serverInfo (or (get-in discovery [:_meta :io.modelcontextprotocol/serverInfo])
                                        {:name "MCP server" :version "unknown"})}
                       (request! "initialize"
                               {:protocolVersion protocol-version
                                :capabilities {}
                                :clientInfo {:name "qi-agent" :version "1"}}
                               {:timeout-ms startup-timeout-ms :cancel-token cancel-token}))]
          (when (and discovery (not (some #{modern-protocol-version} (:supportedVersions discovery))))
            (throw (ex-info "MCP modern protocol version is unsupported" {:mcp/transport-error :initialize})))
          (when-not (and (or (= modern-protocol-version (:protocolVersion result))
                            (contains? supported-protocol-versions (:protocolVersion result)))
                         (map? (:capabilities result))
                         (map? (:serverInfo result))
                         (string? (get-in result [:serverInfo :name]))
                         (string? (get-in result [:serverInfo :version])))
            (throw (ex-info "MCP server returned an unsupported initialization result"
                            {:mcp/transport-error :initialize
                             :protocol-version (:protocolVersion result)})))
          (when-not @modern? (send! {:jsonrpc "2.0" :method "notifications/initialized"} nil))
          {:request! request! :close! close!
           :alive? #(and @active? (.isAlive process))
           :server-info (:serverInfo result)
           :capabilities (:capabilities result)
           :protocol-version (:protocolVersion result)
           :cwd (str directory)
           :pid (.pid process)
           :stderr-tail #(deref stderr-tail)})
        (catch Throwable error
          (close!)
          (throw error))))))
