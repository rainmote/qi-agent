(ns qi.plugins.lsp
  "A small LSP 3.x runtime with lazy per-project clients.

  Servers are external executables declared in configuration. Documents are
  synchronized from the execution world immediately before every query, so
  edits made by any tool or by the user cannot leave the server with stale
  text."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.io BufferedInputStream ByteArrayOutputStream EOFException]
           [java.net URI]
           [java.nio.charset StandardCharsets]
           [java.nio.file Files LinkOption Path Paths]
           [java.security MessageDigest]
           [java.util.concurrent TimeUnit]))

(declare request! notify! stop-client!)

(def ^:private position-actions
  #{:definition :references :hover :implementation :type-definition})

(def ^:private max-header-line-bytes 8192)
(def ^:private max-message-bytes (* 32 1024 1024))

(def ^:private method-for
  {:definition "textDocument/definition"
   :references "textDocument/references"
   :hover "textDocument/hover"
   :implementation "textDocument/implementation"
   :type-definition "textDocument/typeDefinition"
   :document-symbols "textDocument/documentSymbol"
   :workspace-symbols "workspace/symbol"})

(defn- now [] (System/currentTimeMillis))

(defn- sha256 [text]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes ^String text StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and 0xff %)) digest))))

(defn- read-line-bytes [^BufferedInputStream input]
  (let [output (ByteArrayOutputStream.)]
    (loop [previous -1]
      (let [value (.read input)]
        (cond
          (= value -1)
          (if (zero? (.size output))
            nil
            (throw (EOFException. "EOF in LSP header")))

          (and (= previous 13) (= value 10))
          (let [bytes (.toByteArray output)]
            (String. bytes 0 (dec (alength bytes))
                     StandardCharsets/US_ASCII))

          :else
          (do (when (>= (.size output) max-header-line-bytes)
                (throw (ex-info "LSP header line is too large"
                                {:max-bytes max-header-line-bytes})))
              (.write output value)
              (recur value)))))))

(defn- read-fully! [input length]
  (let [body (byte-array length)]
    (loop [offset 0]
      (if (= offset length)
        body
        (let [read (.read input body offset (- length offset))]
          (when (neg? read)
            (throw (EOFException. "EOF in LSP body")))
          (recur (+ offset read)))))))

(defn- read-message! [^BufferedInputStream input]
  (loop [headers {}]
    (let [line (read-line-bytes input)]
      (cond
        (nil? line) nil
        (empty? line)
        (let [length-text (get headers "content-length")]
          (when-not length-text
            (throw (ex-info "LSP message has no Content-Length" {})))
          (let [length (parse-long length-text)]
            (when-not (and length (not (neg? length)))
              (throw (ex-info "Invalid LSP Content-Length"
                              {:value length-text})))
            (when (> length max-message-bytes)
              (throw (ex-info "LSP message exceeds the transport limit"
                              {:content-length length
                               :max-bytes max-message-bytes})))
            (json/parse-string
             (String. (read-fully! input length) StandardCharsets/UTF_8)
             true)))
        :else
        (let [[name value] (str/split line #":" 2)]
          (when-not value
            (throw (ex-info "Malformed LSP header" {:header line})))
          (recur (assoc headers (str/lower-case (str/trim name))
                        (str/trim value))))))))

(defn- send-json! [client message]
  (let [body (.getBytes (json/generate-string message)
                        StandardCharsets/UTF_8)
        header (.getBytes (str "Content-Length: " (alength body) "\r\n\r\n")
                          StandardCharsets/US_ASCII)]
    (locking (:write-lock client)
      (let [output (:stdin (:session client))]
        (.write output header)
        (.write output body)
        (.flush output)))))

(defn notify! [client method params]
  (send-json! client {:jsonrpc "2.0" :method method :params params}))

(defn- reject-pending! [client error]
  (let [pending (vals (swap! (:pending client) (constantly {})))]
    (doseq [response pending]
      (deliver response {:transport-error error}))))

(defn- setting-for [settings section]
  (if (str/blank? section)
    settings
    (get-in settings (mapv keyword (str/split section #"\.")))))

(defn- handle-server-request! [client {:keys [id method params]}]
  (let [settings (or (get-in client [:server :settings]) {})
        response
        (case method
          "workspace/configuration"
          {:result (mapv #(setting-for settings (:section %))
                         (or (:items params) []))}

          "workspace/workspaceFolders"
          {:result [{:uri (:root-uri client)
                     :name (.getName (io/file (:project-root client)))}]}

          "client/registerCapability"
          (do (doseq [registration (:registrations params)]
                (swap! (:dynamic-registrations client)
                       assoc (:id registration) registration))
              {:result nil})

          "client/unregisterCapability"
          (do (doseq [registration (or (:unregisterations params)
                                       (:unregistrations params))]
                (swap! (:dynamic-registrations client)
                       dissoc (:id registration)))
              {:result nil})

          "workspace/applyEdit"
          {:result {:applied false
                    :failureReason "This LSP integration is read-only"}}

          "window/showDocument" {:result {:success false}}
          "window/showMessageRequest" {:result nil}
          "window/workDoneProgress/create" {:result nil}
          "workspace/codeLens/refresh" {:result nil}
          "workspace/diagnostic/refresh" {:result nil}
          "workspace/inlayHint/refresh" {:result nil}
          "workspace/inlineValue/refresh" {:result nil}
          "workspace/semanticTokens/refresh" {:result nil}
          {:error {:code -32601 :message (str "Unsupported server request: " method)}})]
    (send-json! client (merge {:jsonrpc "2.0" :id id} response))))

(defn- handle-notification! [client {:keys [method params]}]
  (case method
    "textDocument/publishDiagnostics"
    (swap! (:diagnostics client)
           assoc (:uri params)
           {:version (:version params)
            :items (vec (or (:diagnostics params) []))
            :received-at (now)})
    nil))

(defn- route-message! [client message]
  ;; Method wins over id: server and client request-id spaces are independent,
  ;; so a server request may legitimately reuse one of our numeric ids.
  (if (:method message)
    (if (contains? message :id)
      (handle-server-request! client message)
      (handle-notification! client message))
    (when-let [response (get @(:pending client) (:id message))]
      (swap! (:pending client) dissoc (:id message))
      (deliver response {:response message}))))

(defn- reader-loop! [client]
  (try
    (let [input (BufferedInputStream. (:stdout (:session client)))]
      (loop []
        (if-let [message (read-message! input)]
          (do (route-message! client message) (recur))
          (throw (EOFException. "Language server closed stdout")))))
    (catch Throwable error
      (when-not (= :stopped @(:state client))
        (reset! (:state client) :failed)
        (reset! (:failure client) error)
        (reject-pending! client error)))))

(defn request!
  ([client method params] (request! client method params nil nil))
  ([client method params cancel-token timeout-ms]
   (cancellation/throw-if-cancelled! cancel-token)
   (let [id (swap! (:next-id client) inc)
         response (promise)
         timeout (or timeout-ms (:request-timeout-ms client))
         cancelled? (atom false)]
     (swap! (:pending client) assoc id response)
     (let [dispose-cancel
           (cancellation/on-cancel!
            cancel-token
            (fn []
              (reset! cancelled? true)
              (when (get @(:pending client) id)
                (swap! (:pending client) dissoc id)
                (try (notify! client "$/cancelRequest" {:id id})
                     (catch Throwable _))
                (deliver response {:cancelled true}))))]
       (try
         (send-json! client {:jsonrpc "2.0" :id id
                             :method method :params params})
         (let [envelope (deref response timeout ::timeout)]
           (cond
             (= envelope ::timeout)
             (do (swap! (:pending client) dissoc id)
                 (try (notify! client "$/cancelRequest" {:id id})
                      (catch Throwable _))
                 (throw (ex-info "LSP request timed out"
                                 {:method method :timeout-ms timeout})))

             (:cancelled envelope)
             (throw (ex-info "LSP request was cancelled"
                             {:method method :cancelled true}))

             (:transport-error envelope)
             (throw (ex-info "Language server connection failed"
                             {:method method
                              :stderr ((:stderr-tail (:session client)))}
                             (:transport-error envelope)))

             (get-in envelope [:response :error])
             (throw (ex-info "Language server returned an error"
                             {:method method
                              :error (get-in envelope [:response :error])}))

             :else (get-in envelope [:response :result])))
         (catch Throwable error
           (swap! (:pending client) dissoc id)
           (throw error))
         (finally
           (dispose-cancel)
           (when @cancelled?
             (swap! (:pending client) dissoc id))))))))

(defn- file-uri [path]
  (.toASCIIString (.toURI (io/file (str path)))))

(defn- executable [command]
  (let [program (first command)]
    (cond
      (str/includes? program "/")
      (when (and (.isFile (io/file program)) (.canExecute (io/file program)))
        (.getCanonicalPath (io/file program)))
      :else (some-> (fs/which program) str))))

(defn- server-command [server]
  (let [base (:command server)
        command (if (vector? base) base (into [(str base)] (:args server)))]
    (when-not (and (seq command) (every? string? command))
      (throw (ex-info "LSP server command must be a string plus args or argv vector"
                      {:server (:id server) :command base})))
    (when-let [program (executable command)]
      (assoc command 0 program))))

(defn- file-matches? [server path]
  (let [name (.getName (io/file path))
        types (or (:file-types server) (:extensions server) [])]
    (and (not (:disabled server))
         (some (fn [type]
                 (or (= name type)
                     (str/ends-with? name type)))
               types))))

(defn- marker-present? [^Path directory marker]
  (if (or (str/includes? marker "*") (str/includes? marker "?"))
    (let [matcher (.getPathMatcher (java.nio.file.FileSystems/getDefault)
                                  (str "glob:" marker))]
      (with-open [entries (Files/newDirectoryStream directory)]
        (boolean (some #(.matches matcher (.getFileName ^Path %))
                       (iterator-seq (.iterator entries))))))
    (Files/exists (.resolve directory marker) (make-array LinkOption 0))))

(defn- nearest-root [workspace-root file markers]
  (let [workspace (.toRealPath (Paths/get workspace-root (make-array String 0))
                               (make-array LinkOption 0))
        target (.toRealPath (Paths/get file (make-array String 0))
                            (make-array LinkOption 0))]
    (if (empty? markers)
      (str workspace)
      (loop [directory (.getParent target)]
        (cond
          (nil? directory) (str workspace)
          (not (.startsWith directory workspace)) (str workspace)
          (some #(marker-present? directory %) markers) (str directory)
          (= directory workspace) (str workspace)
          :else (recur (.getParent directory)))))))

(defn- select-server [world servers file]
  (let [path ((:resolve! world) file)]
    (when-let [server (first (filter #(file-matches? % path) servers))]
      {:server server
       :file path
       :project-root (nearest-root (:root world) path
                                   (or (:root-markers server) []))})))

(defn- initialize-client! [client]
  (let [server (:server client)
        capabilities
        {:workspace {:configuration true :workspaceFolders true
                     :symbol {:dynamicRegistration true}}
         :textDocument
         {:synchronization {:dynamicRegistration true :didSave true}
          :definition {:dynamicRegistration true :linkSupport true}
          :references {:dynamicRegistration true}
          :hover {:dynamicRegistration true
                  :contentFormat ["markdown" "plaintext"]}
          :documentSymbol {:dynamicRegistration true :hierarchicalDocumentSymbolSupport true}
          :implementation {:dynamicRegistration true :linkSupport true}
          :typeDefinition {:dynamicRegistration true :linkSupport true}
          :diagnostic {:dynamicRegistration true}}
         :general {:positionEncodings ["utf-16" "utf-8" "utf-32"]}}
        result (request!
                client "initialize"
                {:processId nil
                 :clientInfo {:name "qi-agent" :version "0.1"}
                 :rootUri (:root-uri client)
                 :workspaceFolders [{:uri (:root-uri client)
                                     :name (.getName (io/file (:project-root client)))}]
                 :capabilities capabilities
                 :initializationOptions (:initialization-options server)}
                nil (:startup-timeout-ms client))]
    (reset! (:server-capabilities client) (or (:capabilities result) {}))
    (notify! client "initialized" {})
    (when (contains? server :settings)
      (notify! client "workspace/didChangeConfiguration"
               {:settings (:settings server)}))
    (reset! (:state client) :ready)
    client))

(defn- create-client! [stdio server project-root config]
  (let [command (or (server-command server)
                    (throw (ex-info "Language server executable was not found"
                                    {:server (:id server)
                                     :command (:command server)})))
        session ((:open! stdio) {:command command :cwd project-root
                                 :env (or (:env server) {})})
        client {:server server
                :project-root project-root
                :root-uri (file-uri project-root)
                :session session
                :write-lock (Object.)
                :next-id (atom 0)
                :pending (atom {})
                :state (atom :starting)
                :failure (atom nil)
                :server-capabilities (atom {})
                :dynamic-registrations (atom {})
                :diagnostics (atom {})
                :open-documents (atom {})
                :reader-task (atom nil)
                :request-timeout-ms (:request-timeout-ms config)
                :startup-timeout-ms (:startup-timeout-ms config)}]
    (reset! (:reader-task client) (future (reader-loop! client)))
    (try
      (initialize-client! client)
      (catch Throwable error
        ((:close! session))
        (throw error)))))

(defn stop-client! [client]
  (when-not (= :stopped @(:state client))
    (when (= :ready @(:state client))
      (try (request! client "shutdown" nil nil 1500)
           (catch Throwable _))
      (try (notify! client "exit" nil) (catch Throwable _)))
    (reset! (:state client) :stopped)
    (reject-pending! client (ex-info "Language server stopped" {}))
    ((:close! (:session client))))
  nil)

(defn- get-client! [runtime selection]
  (let [{:keys [server project-root]} selection
        key [(:id server) project-root]
        clients (:clients runtime)
        failures (:failures runtime)
        cooldown (:failure-cooldown-ms runtime)]
    (locking clients
      (loop []
        (when @(:closed? runtime) (throw (ex-info "LSP provider is stopping" {})))
        (if-let [client (get @clients key)]
          (if (= :ready @(:state client))
            client
            (do (swap! clients dissoc key)
                (stop-client! client)
                (recur)))
          (do
            (when-let [{:keys [at message]} (get @failures key)]
              (when (< (- (now) at) cooldown)
                (throw (ex-info "Language server is in startup cooldown"
                                {:server (:id server)
                                 :retry-after-ms (- cooldown (- (now) at))
                                 :cause message}))))
            (try
              (let [client (create-client! (:stdio runtime) server project-root
                                           runtime)]
                (swap! clients assoc key client)
                (when @(:closed? runtime)
                  (stop-client! client)
                  (throw (ex-info "LSP stopped during startup" {})))
                (swap! failures dissoc key)
                client)
              (catch Throwable error
                (swap! failures assoc key {:at (now) :message (ex-message error)})
                (throw error)))))))))

(defn- document-text! [runtime path]
  (let [result ((:read! (:world runtime))
                {:path path :offset 0
                 :limit (inc (:max-document-chars runtime))})]
    (when (or (:truncated result)
              (> (:size result) (:max-document-chars runtime)))
      (throw (ex-info "Document exceeds the LSP synchronization limit"
                      {:path (:path result)
                       :max-document-chars (:max-document-chars runtime)
                       :size (:size result)})))
    (:content result)))

(defn- ensure-document! [runtime client server path]
  (let [text (document-text! runtime path)
        uri (file-uri path)
        hash (sha256 text)
        existing (get @(:open-documents client) uri)
        version (if existing (inc (:version existing)) 1)
        configured-language (:language-id server)
        language-id (or (when (map? configured-language)
                          (some (fn [[suffix language]]
                                  (when (and (string? suffix)
                                             (str/ends-with? path suffix))
                                    language))
                                configured-language))
                        (when (string? configured-language)
                          configured-language)
                        (name (:id server)))]
    (cond
      (nil? existing)
      (notify! client "textDocument/didOpen"
               {:textDocument {:uri uri :languageId language-id
                               :version version :text text}})

      (not= hash (:hash existing))
      (do
        (notify! client "textDocument/didChange"
                 {:textDocument {:uri uri :version version}
                  :contentChanges [{:text text}]})
        (notify! client "textDocument/didSave"
                 {:textDocument {:uri uri :text text}})))
    (when (or (nil? existing) (not= hash (:hash existing)))
      (swap! (:diagnostics client) dissoc uri)
      (swap! (:open-documents client) assoc uri
             {:version version :hash hash :path path}))
    {:uri uri :text text
     :version (or (:version (get @(:open-documents client) uri)) version)}))

(defn- position-character [line prefix-index encoding]
  (let [prefix (subs line 0 prefix-index)]
    (case encoding
      "utf-8" (alength (.getBytes prefix StandardCharsets/UTF_8))
      "utf-32" (.codePointCount prefix 0 (.length prefix))
      ;; Java string offsets already count UTF-16 code units.
      prefix-index)))

(defn- find-occurrence [line symbol occurrence]
  (loop [from 0 seen 0]
    (let [index (.indexOf ^String line ^String symbol from)]
      (cond
        (neg? index) nil
        (= (inc seen) occurrence) index
        :else (recur (+ index (max 1 (count symbol))) (inc seen))))))

(defn- lsp-position [client text line-number symbol occurrence]
  (let [lines (str/split text #"\r?\n" -1)
        index (dec line-number)]
    (when-not (< -1 index (count lines))
      (throw (ex-info "LSP line is outside the document"
                      {:line line-number :line-count (count lines)})))
    (when (str/blank? symbol)
      (throw (ex-info "A non-blank symbol is required for this LSP action"
                      {:line line-number})))
    (let [line (nth lines index)
          offset (find-occurrence line symbol (or occurrence 1))]
      (when-not offset
        (throw (ex-info "Symbol was not found on the requested line"
                        {:line line-number :symbol symbol
                         :occurrence (or occurrence 1)})))
      {:line index
       :character (position-character
                   line offset
                   (or (:positionEncoding @(:server-capabilities client))
                       "utf-16"))})))

(defn- relative-uri [runtime uri]
  (try
    (let [root (.toRealPath (Paths/get (get-in runtime [:world :root])
                                       (make-array String 0))
                                (make-array LinkOption 0))
          parsed (URI. uri)]
      (if (= "file" (.getScheme parsed))
        (let [path (.normalize (.toAbsolutePath (Paths/get parsed)))]
          (if (.startsWith path root)
            {:path (str (.relativize root path))}
            {:uri uri :external true}))
        {:uri uri :external true}))
    (catch Throwable _ {:uri uri :external true})))

(defn- one-based-position [position]
  (when position
    {:line (inc (or (:line position) 0))
     :column (inc (or (:character position) 0))}))

(defn- normalize-range [range]
  (when range
    {:start (one-based-position (:start range))
     :end (one-based-position (:end range))}))

(defn- normalize-location [runtime location]
  (let [uri (or (:uri location) (:targetUri location))
        range (or (:range location) (:targetSelectionRange location)
                  (:targetRange location))]
    (merge (relative-uri runtime uri)
           {:range (normalize-range range)})))

(defn- normalize-locations [runtime value]
  (cond
    (nil? value) []
    (vector? value) (mapv #(normalize-location runtime %) value)
    (map? value) [(normalize-location runtime value)]
    :else []))

(defn- normalize-symbol [runtime symbol]
  (cond-> (-> symbol
              (update :range normalize-range)
              (update :selectionRange normalize-range))
    (:location symbol)
    (assoc :location (normalize-location runtime (:location symbol)))

    (:children symbol)
    (assoc :children (mapv #(normalize-symbol runtime %) (:children symbol)))))

(defn- normalize-diagnostic [diagnostic]
  (-> diagnostic
      (update :range normalize-range)
      (select-keys [:range :severity :code :source :message :tags
                    :relatedInformation])))

(defn- pull-diagnostics? [client]
  (or (:diagnosticProvider @(:server-capabilities client))
      (some #(= "textDocument/diagnostic" (:method %))
            (vals @(:dynamic-registrations client)))))

(defn- diagnostics! [runtime client document cancel-token timeout-ms]
  (let [uri (:uri document)]
    (if (pull-diagnostics? client)
      (let [result (request! client "textDocument/diagnostic"
                             {:textDocument {:uri uri}}
                             cancel-token timeout-ms)]
        {:source :pull
         :items (mapv normalize-diagnostic (or (:items result) []))})
      (let [deadline (+ (now) (:diagnostic-wait-ms runtime))]
        (loop []
          (cancellation/throw-if-cancelled! cancel-token)
          (if-let [cached (get @(:diagnostics client) uri)]
            {:source :push :settled true
             :items (mapv normalize-diagnostic (:items cached))}
            (if (< (now) deadline)
              (do (Thread/sleep 25) (recur))
              {:source :push :settled false :items []})))))))

(defn- client-status [client]
  {:server (get-in client [:server :id])
   :root (:project-root client)
   :state @(:state client)
   :open-documents (count @(:open-documents client))
   :stderr ((:stderr-tail (:session client)))})

(defn- runtime-status [runtime]
  {:transport-available (boolean (get-in runtime [:stdio :available?]))
   :servers
   (mapv (fn [server]
           {:id (:id server)
            :available (boolean (and (get-in runtime [:stdio :available?])
                                     (server-command server)))
            :disabled (boolean (:disabled server))
            :command (:command server)
            :file-types (vec (or (:file-types server)
                                 (:extensions server)))})
         (:servers runtime))
   :clients (mapv client-status (vals @(:clients runtime)))})

(defn- query! [runtime {:keys [action file line symbol occurrence query
                               timeout-ms]}
                execution]
  (let [action (keyword (str/replace (name action) "_" "-"))
        cancel-token (:cancel-token execution)]
    (cancellation/throw-if-cancelled! cancel-token)
    (if (= action :status)
      (runtime-status runtime)
      (do
        (when-not ((:trusted? (:trust runtime)))
          (throw (ex-info "LSP servers require a trusted project"
                          {:root (get-in runtime [:world :root])})))
        (when (str/blank? file)
          (throw (ex-info "This LSP action requires a file" {:action action})))
        (let [selection (or (select-server (:world runtime) (:servers runtime)
                                           file)
                            (throw (ex-info "No LSP server matches this file"
                                            {:file file})))
              client (get-client! runtime selection)
              document (ensure-document! runtime client (:server selection)
                                         (:file selection))]
          (cond
            (= action :capabilities)
            {:server (get-in selection [:server :id])
             :root (:project-root selection)
             :capabilities @(:server-capabilities client)
             :dynamic-registrations (vec (vals @(:dynamic-registrations client)))}

            (= action :diagnostics)
            (merge {:file file :server (get-in selection [:server :id])}
                   (diagnostics! runtime client document cancel-token timeout-ms))

            (= action :workspace-symbols)
            {:items (mapv #(normalize-symbol runtime %)
                          (or (request! client (method-for action)
                                        {:query (or query "")}
                                        cancel-token timeout-ms) []))}

            (= action :document-symbols)
            {:items (mapv #(normalize-symbol runtime %)
                          (or (request! client (method-for action)
                                        {:textDocument {:uri (:uri document)}}
                                        cancel-token timeout-ms) []))}

            (position-actions action)
            (let [position (lsp-position client (:text document) (or line 1)
                                         symbol occurrence)
                  params (cond-> {:textDocument {:uri (:uri document)}
                                  :position position}
                           (= action :references)
                           (assoc :context {:includeDeclaration true}))
                  result (request! client (method-for action) params
                                   cancel-token timeout-ms)]
              (if (= action :hover)
                {:hover result}
                {:locations (normalize-locations runtime result)}))

            :else
            (throw (ex-info "Unsupported LSP action" {:action action}))))))))

(def plugin
  {:id :lsp/runtime
   :description "Lazy read-only LSP client registry and document synchronizer."
   :requires #{:execution/world :execution/stdio-session :project/trust}
   :provides #{:lsp/runtime}
   :start
   (fn [ctx {:keys [servers request-timeout-ms startup-timeout-ms
                    failure-cooldown-ms diagnostic-wait-ms max-document-chars]
             :or {servers [] request-timeout-ms 10000 startup-timeout-ms 30000
                  failure-cooldown-ms 180000 diagnostic-wait-ms 1500
                  max-document-chars 2000000}}]
     (when-not (and (vector? servers)
                    (= (count servers) (count (distinct (map :id servers))))
                    (every? #(let [types (or (:file-types %) (:extensions %))]
                               (and (map? %)
                                    (keyword? (:id %))
                                    (:command %)
                                    (sequential? types)
                                    (seq types)
                                    (every? (fn [type]
                                              (and (string? type)
                                                   (not (str/blank? type))))
                                            types)
                                    (every? string? (or (:root-markers %) []))))
                            servers))
       (throw (ex-info "LSP :servers must be a vector with keyword ids"
                       {:servers servers})))
     (when-not (every? pos-int? [request-timeout-ms startup-timeout-ms
                                 failure-cooldown-ms diagnostic-wait-ms
                                 max-document-chars])
       (throw (ex-info "LSP limits must be positive integers" {})))
     (let [clients (atom {})
           runtime {:world (kernel/require-service ctx :execution/world)
                    :stdio (kernel/require-service ctx :execution/stdio-session)
                    :trust (kernel/require-service ctx :project/trust)
                    :servers servers
                    :clients clients :closed? (atom false)
                    :failures (atom {})
                    :request-timeout-ms request-timeout-ms
                    :startup-timeout-ms startup-timeout-ms
                    :failure-cooldown-ms failure-cooldown-ms
                    :diagnostic-wait-ms diagnostic-wait-ms
                    :max-document-chars max-document-chars}]
       (kernel/track-stop! ctx #(do (reset! (:closed? runtime) true)
                                   (doseq [client (vals @clients)] (stop-client! client))))
       (kernel/register-service!
        ctx :lsp/runtime
        {:query! (fn [arguments execution]
                   (query! runtime arguments execution))
         :status #(runtime-status runtime)
         :reload! (fn []
                    (doseq [client (vals @clients)] (stop-client! client))
                    (reset! clients {})
                    (reset! (:failures runtime) {})
                    (runtime-status runtime))})
       (fn []
         (doseq [client (vals @clients)] (stop-client! client))
         (reset! clients {}))))})
