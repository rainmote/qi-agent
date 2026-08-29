(ns agent.plugins.chatgpt
  "Experimental ChatGPT-subscription adapter using the Codex auth cache."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.streaming :as streaming]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.net URI]
           [java.nio.file Files LinkOption]))

(def ^:private default-base-url
  "https://chatgpt.com/backend-api/codex")

(def ^:private default-http-version :http1.1)
(def ^:private default-connect-timeout-ms 15000)
(def ^:private default-transport-retries 4)
(def ^:private default-retry-delay-ms 400)
(def ^:private max-retry-delay-ms 5000)

(def ^:private allowed-auth-hosts
  #{"chatgpt.com" "chat.openai.com" "chatgpt-staging.com"})

(def ^:private public-permissions
  #{"GROUP_READ" "GROUP_WRITE" "GROUP_EXECUTE"
    "OTHERS_READ" "OTHERS_WRITE" "OTHERS_EXECUTE"})

(defn- expand-home [path]
  (if (and (string? path) (str/starts-with? path "~/"))
    (str (System/getProperty "user.home") (subs path 1))
    path))

(defn- auth-file [{:keys [auth-file]}]
  (io/file
   (expand-home
    (or auth-file
        (when-not (str/blank? (System/getenv "CODEX_HOME"))
          (str (io/file (System/getenv "CODEX_HOME") "auth.json")))
        (str (io/file (System/getProperty "user.home")
                      ".codex" "auth.json"))))))

(defn- insecure-permissions [file]
  (try
    (->> (Files/getPosixFilePermissions
          (.toPath file) (make-array LinkOption 0))
         (map str)
         (filter public-permissions)
         set)
    (catch UnsupportedOperationException _ #{})
    (catch java.io.IOException _ #{})))

(defn- read-auth! [config]
  (let [file (auth-file config)]
    (when-not (.isFile file)
      (throw (ex-info
              (str "Codex auth cache not found at " file
                   "; run `codex login`")
              {:provider :chatgpt-subscription
               :auth-file (str file)})))
    (when (not= false (:check-permissions config))
      (when-let [permissions (seq (insecure-permissions file))]
        (throw (ex-info
                (str "Codex auth cache is accessible by group/others: "
                     (str/join ", " (sort permissions))
                     "; restrict it to the current user")
                {:provider :chatgpt-subscription
                 :auth-file (str file)}))))
    (let [auth (try
                 (json/parse-string (slurp file) true)
                 (catch Throwable _
                   (throw (ex-info
                           (str "Cannot parse Codex auth cache at " file)
                           {:provider :chatgpt-subscription
                            :auth-file (str file)}))))
          mode (:auth_mode auth)
          access-token (get-in auth [:tokens :access_token])
          account-id (get-in auth [:tokens :account_id])]
      (when-not (= "chatgpt" mode)
        (throw (ex-info
                "Codex is not signed in with ChatGPT; run `codex login`"
                {:provider :chatgpt-subscription
                 :auth-mode mode})))
      (when (or (str/blank? access-token) (str/blank? account-id))
        (throw (ex-info
                "Codex ChatGPT login is incomplete; run `codex login` again"
                {:provider :chatgpt-subscription})))
      ;; Retain neither the parsed auth cache nor its refresh token in plugin state.
      {:access-token access-token
       :account-id account-id})))

(defn- endpoint [base-url]
  (let [trimmed (str/replace base-url #"/+$" "")]
    (if (str/ends-with? trimmed "/responses")
      trimmed
      (str trimmed "/responses"))))

(defn- valid-base-url? [base-url]
  (try
    (let [uri (URI. base-url)
          path (str/replace (or (.getPath uri) "") #"/+$" "")]
      (and (= "https" (.getScheme uri))
           (contains? allowed-auth-hosts (.getHost uri))
           (contains? #{"/backend-api/codex" "/codex"} path)
           (nil? (.getUserInfo uri))))
    (catch Throwable _ false)))

(defn- tool-schema [{:keys [type function]}]
  (when-not (= "function" type)
    (throw (ex-info "ChatGPT adapter only supports function tools"
                    {:tool-type type})))
  (assoc function :type "function"))

(defn- fallback-assistant-items [message]
  (vec
   (concat
    (when-not (str/blank? (:content message))
      [{:role "assistant" :content (:content message)}])
    (map (fn [call]
           {:type "function_call"
            :call_id (:id call)
            :name (get-in call [:function :name])
            :arguments (let [arguments (get-in call [:function :arguments])]
                         (if (string? arguments)
                           arguments
                           (json/generate-string (or arguments {}))))})
         (:tool_calls message)))))

(defn- responses-content [content]
  (if-not (sequential? content)
    content
    (mapv (fn [block]
            (cond
              (contains? #{:text "text"} (:type block))
              {:type "input_text" :text (:text block)}

              (contains? #{:image "image"} (:type block))
              (cond-> {:type "input_image"
                       :image_url (or (:url block) (:image_url block))}
                (:detail block) (assoc :detail (:detail block)))

              :else
              (throw (ex-info "Unsupported Responses content block"
                              {:block block}))))
          content)))

(defn- message-items [message]
  (case (:role message)
    "user" [{:role "user" :content (responses-content (:content message))}]
    "assistant" (if (seq (:response_items message))
                  (:response_items message)
                  (fallback-assistant-items message))
    "tool" [{:type "function_call_output"
              :call_id (:tool_call_id message)
              :output (:content message)}]
    "system" [{:role "system" :content (:content message)}]
    (throw (ex-info "Unsupported message role for Responses API"
                    {:role (:role message)}))))

(defn- input-items [messages]
  (vec (mapcat message-items messages)))

(defn- emit-stream! [ctx event]
  (let [event-type (:type event)
        normalized
        (if (contains? #{"response.failed" "error"} event-type)
          {:type :response/error :error event}
          (case event-type
          "response.created"
          {:type :response/start
           :response-id (get-in event [:response :id])}

          "response.output_text.delta"
          {:type :text/delta :delta (:delta event)}

          "response.reasoning_summary_text.delta"
          {:type :reasoning/delta :delta (:delta event)}

          "response.output_item.done"
          {:type :output/item-done
           :index (:output_index event)
           :item (:item event)}

          "response.completed"
          {:type :response/completed
           :response-id (get-in event [:response :id])}

          {:type :provider/event}))]
    (kernel/emit! ctx :llm/stream
                  (assoc normalized
                         :provider :chatgpt-subscription
                         :provider-event event-type))))

(defn- response-from-events [events]
  (let [completed (some #(when (= "response.completed" (:type %))
                           (:response %))
                        (reverse events))
        done-items (->> events
                        (filter #(= "response.output_item.done" (:type %)))
                        (sort-by #(or (:output_index %) 0))
                        (mapv :item))
        failed-event (some #(when (contains? #{"response.failed" "error"}
                                              (:type %))
                              %)
                           (reverse events))]
    (cond
      completed (if (seq (:output completed))
                  completed
                  (assoc completed :output done-items))
      failed-event
      (throw (ex-info
              (or (get-in failed-event [:response :error :message])
                  (get-in failed-event [:error :message])
                  (:message failed-event)
                  "ChatGPT response stream failed")
              {:provider :chatgpt-subscription
               :event-type (:type failed-event)}))
      :else
      (throw (ex-info "ChatGPT stream ended without response.completed"
                      {:provider :chatgpt-subscription
                       :event-types (mapv :type events)})))))

(defn- terminal-response [ctx body cancel-token]
  (if (and (string? body) (str/starts-with? (str/trim body) "{"))
    (let [response (json/parse-string (str/trim body) true)]
      (kernel/emit! ctx :llm/stream
                    {:type :response/completed
                     :provider :chatgpt-subscription
                     :response-id (:id response)})
      response)
    (let [events (atom [])]
      (streaming/consume-sse!
       body cancel-token
       (fn [event]
         (when (contains? #{"response.output_item.done"
                            "response.completed"
                            "response.failed"
                            "error"}
                          (:type event))
           (swap! events conj event))
         (emit-stream! ctx event)))
      (response-from-events @events))))

(defn- output-text [output]
  (->> output
       (filter #(= "message" (:type %)))
       (mapcat :content)
       (keep (fn [item]
               (case (:type item)
                 "output_text" (:text item)
                 "refusal" (:refusal item)
                 nil)))
       (str/join "\n")))

(defn- tool-calls [output]
  (->> output
       (filter #(= "function_call" (:type %)))
       (mapv (fn [item]
               {:id (:call_id item)
                :type "function"
                :function {:name (:name item)
                           :arguments (:arguments item)}}))))

(defn- finish-reason [response calls]
  (cond
    (seq calls) "tool_calls"
    (= "completed" (:status response)) "stop"
    (= "max_output_tokens" (get-in response [:incomplete_details :reason]))
    "length"
    :else (or (:status response) "incomplete")))

(defn- error-body [body]
  (let [text (if (string? body)
               body
               (try (slurp body) (catch Throwable _ (pr-str body))))]
    (subs text 0 (min 1200 (count text)))))

(defn- retry-wait! [cancel-token milliseconds]
  (loop [remaining milliseconds]
    (cancellation/throw-if-cancelled! cancel-token)
    (when (pos? remaining)
      (let [slice (min remaining 50)]
        (Thread/sleep slice)
        (recur (- remaining slice))))))

(defn- error-chain [error]
  (take-while some? (iterate ex-cause error)))

(defn- cancelled-error? [error]
  (or (some #(true? (:cancelled (ex-data %))) (error-chain error))
      (some #(instance? InterruptedException %) (error-chain error))))

(defn- transport-error? [error]
  (let [chain (error-chain error)
        message (->> chain
                     (keep ex-message)
                     (str/join " ")
                     str/lower-case)]
    (and (not (cancelled-error? error))
         (or (some #(instance? java.io.IOException %) chain)
             (some #(str/includes? message %)
                   ["remote host terminated the handshake"
                    "connection reset"
                    "connection refused"
                    "connection closed"
                    "broken pipe"
                    "timed out"
                    "timeout"
                    "unexpected end of stream"
                    "premature eof"
                    "temporary failure in name resolution"])))))

(defn- http-version [config]
  (or (:http-version config) default-http-version))

(defn- valid-proxy-config? [proxy]
  (or (nil? proxy)
      (and (map? proxy)
           (let [proxy-type (or (:type proxy) :http)]
             (and (contains? #{:http :direct} proxy-type)
                  (or (= :direct proxy-type)
                      (and (not (str/blank? (:host proxy)))
                           (integer? (:port proxy))
                           (<= 1 (:port proxy) 65535))))))))

(defn- new-http-client [config]
  ;; The ChatGPT route is commonly reached through VPN/TUN proxies. HTTP/1.1
  ;; avoids flaky HTTP/2 ALPN paths, and rebuilding this client after a failed
  ;; handshake also drops the JDK client's cached connection/TLS state.
  (http/client
   (cond->
    (assoc http/default-client-opts
           :connect-timeout (or (:connect-timeout-ms config)
                                default-connect-timeout-ms)
           :version (http-version config))
     (:proxy config) (assoc :proxy (:proxy config)))))

(defn- transport-state [config]
  {:config config
   :client (atom (new-http-client config))})

(defn- replace-client! [{:keys [config client]}]
  (reset! client (new-http-client config)))

(defn- backoff-ms [base-delay attempt]
  (min max-retry-delay-ms
       (* base-delay (bit-shift-left 1 attempt))))

(defn- post-with-retry [transport url options cancel-token]
  (let [config (:config transport)
        retries (or (:transport-retries config)
                    default-transport-retries)
        base-delay (or (:retry-delay-ms config)
                       default-retry-delay-ms)
        version (http-version config)]
    (loop [attempt 0]
      (cancellation/throw-if-cancelled! cancel-token)
      (let [result (try
                     {:response (http/post url
                                           (assoc options
                                                  :client @(:client transport)
                                                  :version version))}
                     (catch Throwable error {:error error}))]
        (if-let [error (:error result)]
          (if (and (transport-error? error) (< attempt retries))
            (do
              (replace-client! transport)
              (retry-wait! cancel-token (backoff-ms base-delay attempt))
              (recur (inc attempt)))
            (if (transport-error? error)
              (throw
               (ex-info
                (str "ChatGPT request transport failed after " (inc attempt)
                     " attempts: " (ex-message error))
                {:provider :chatgpt-subscription
                 :endpoint url
                 :transport true
                 :attempts (inc attempt)
                 :http-version version
                 ;; This adapter already exhausted its connection-level retries.
                 ;; Prevent the runtime layer from multiplying the same POSTs.
                 :retryable false}
                error))
              (throw error)))
          (:response result))))))

(defn- generate [ctx config transport request]
  ;; Re-read the cache for every request so a token refreshed by Codex is picked
  ;; up without restarting this agent.
  (let [auth-id (or (:auth-id config) (:provider-id config) :chatgpt)
        {:keys [access-token account-id]}
        (if-let [store (kernel/service ctx :auth/store)]
          ((:resolve! store) auth-id)
          (read-auth! config))
        tools (mapv tool-schema (:tools request))
        body (cond->
              (merge {:model (:model config)
                      :instructions (:system-prompt request)
                      :input (input-items (:messages request))
                      :store false
                      :stream true}
                     (:extra-body config)
                     (:options request))
               (seq tools)
               (assoc :tools tools
                      :tool_choice "auto"
                      :parallel_tool_calls true))
        url (endpoint (or (:base-url config) default-base-url))
        response (post-with-retry
                  transport
                  url
                  {:headers {"authorization" (str "Bearer " access-token)
                             "chatgpt-account-id" account-id
                             "content-type" "application/json"
                             "accept" "text/event-stream"
                             "originator" "codex_cli_rs"
                             "user-agent" "bb-agent/0.1"}
                   :body (json/generate-string body)
                   :as :stream
                   :throw false
                   :timeout (or (:timeout-ms config) 180000)}
                  (:cancel-token request))]
    (when (= 401 (:status response))
      (throw (ex-info
              "ChatGPT login expired; run `codex login` and retry"
              {:provider :chatgpt-subscription :status 401})))
    (when-not (<= 200 (:status response) 299)
      (throw (ex-info (str "ChatGPT request failed with HTTP "
                           (:status response))
                      {:provider :chatgpt-subscription
                       :status (:status response)
                       :body (error-body (:body response))})))
    (let [parsed (terminal-response ctx (:body response)
                                    (:cancel-token request))
          output (vec (:output parsed))
          calls (tool-calls output)
          content (output-text output)]
      (when-not (seq output)
        (throw (ex-info "ChatGPT response has no output items"
                        {:provider :chatgpt-subscription
                         :response-id (:id parsed)
                         :status (:status parsed)})))
      {:message (cond-> {:role "assistant"
                        :content (when-not (str/blank? content) content)
                        ;; Responses output items must be replayed verbatim when
                        ;; application-managed history uses store=false.
                        :response_items output}
                  (seq calls) (assoc :tool_calls calls))
       :finish-reason (finish-reason parsed calls)
       :usage (:usage parsed)
       :model (:model parsed)})))

(def plugin
  {:id :llm/chatgpt-subscription
   :description "ChatGPT subscription adapter backed by the Codex login cache."
   :provides #{:llm/generate}
   :start
   (fn [ctx config]
     (let [base-url (or (:base-url config) default-base-url)]
       (when (str/blank? (:model config))
         (throw (ex-info "ChatGPT plugin requires :model"
                         {:provider :chatgpt-subscription})))
       (when-not (valid-base-url? base-url)
         (throw (ex-info
                 "Refusing to send Codex credentials to a non-ChatGPT endpoint"
                 {:provider :chatgpt-subscription
                 :base-url base-url})))
       (when-not (and (nat-int? (or (:transport-retries config)
                                    default-transport-retries))
                      (pos-int? (or (:retry-delay-ms config)
                                    default-retry-delay-ms))
                      (pos-int? (or (:connect-timeout-ms config)
                                    default-connect-timeout-ms))
                      (contains? #{:http1.1 :http2}
                                 (http-version config))
                      (valid-proxy-config? (:proxy config)))
         (throw (ex-info "ChatGPT retry settings are invalid"
                         {:transport-retries (:transport-retries config)
                          :retry-delay-ms (:retry-delay-ms config)
                          :connect-timeout-ms (:connect-timeout-ms config)
                          :http-version (:http-version config)
                          :proxy (:proxy config)})))
       (when-let [store (kernel/service ctx :auth/store)]
         (kernel/track-effect!
          ctx
          ((:register! store)
           (or (:auth-id config) (:provider-id config) :chatgpt)
           #(read-auth! config)
           {:provider :chatgpt-subscription
            :source :codex-auth-cache})))
       (let [transport (transport-state config)
             generator (partial generate ctx config transport)]
         (if-let [registry (kernel/service ctx :llm/registry)]
           (kernel/track-effect!
            ctx
            ((:register! registry)
             {:id (or (:provider-id config) :chatgpt)
              :provider :chatgpt-subscription
              :model (:model config)
              :context-window (:context-window config)
              :thinking-levels [:low :medium :high]
              :default-thinking-level
              (or (:default-thinking-level config)
                  (some-> (get-in config [:extra-body :reasoning :effort])
                          keyword))
              :input-modalities (or (:input-modalities config)
                                    #{:text :image})
              :experimental true
              :generate generator}))
           (kernel/register-service! ctx :llm/generate generator)))
       nil))})
