(ns qi.plugins.openai-responses
  "Official OpenAI Responses API adapter with streaming function calls."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.streaming :as streaming]
            [qi.tool-images :as images]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.string :as str])
  (:import [java.net URI]))

(def ^:private default-base-url "https://api.openai.com/v1")
(def ^:private default-timeout-ms 180000)
(def ^:private default-max-retries 2)
(def ^:private default-retry-delay-ms 500)
(def ^:private max-retry-delay-ms 10000)
(def ^:private transient-statuses #{408 409 429 500 502 503 504})

(defn- api-key [{:keys [api-key api-key-env] :as config}]
  (or api-key
      (when-not (= :settings (:credential-source config))
        (System/getenv (or api-key-env "OPENAI_API_KEY")))))

(defn- valid-base-url? [base-url]
  (try
    (let [uri (URI. base-url)
          path (str/replace (or (.getPath uri) "") #"/+$" "")]
      (and (= "https" (.getScheme uri))
           (= "api.openai.com" (.getHost uri))
           (contains? #{-1 443} (.getPort uri))
           (= "/v1" path)
           (nil? (.getUserInfo uri))
           (nil? (.getQuery uri))
           (nil? (.getFragment uri))))
    (catch Throwable _ false)))

(defn- valid-provider-base-url? [base-url]
  (try
    (let [uri (URI. base-url)]
      (and (contains? #{"https" "http"} (.getScheme uri))
           (not (str/blank? (.getHost uri)))
           (nil? (.getUserInfo uri))
           (nil? (.getQuery uri))
           (nil? (.getFragment uri))))
    (catch Throwable _ false)))

(defn- validate-credential-endpoint! [config]
  (let [base-url (or (:base-url config) default-base-url)]
    (if (:allow-custom-endpoint config)
      (when-not (and (= :settings (:credential-source config))
                     (not (str/blank? (:api-key config)))
                     (nil? (:api-key-env config))
                     (valid-provider-base-url? base-url))
        (throw (ex-info "Custom endpoint credentials must be explicitly saved settings keys"
                        {:provider :openai :code :credential-scope})))
      (when-not (valid-base-url? base-url)
        (throw (ex-info "Refusing to send an OpenAI API key outside https://api.openai.com/v1"
                        {:provider :openai :code :credential-scope}))))))

(defn- endpoint [base-url]
  (str (str/replace base-url #"/+$" "") "/responses"))

(defn- tool-schema [{:keys [type function]}]
  (when-not (= "function" type)
    (throw (ex-info "OpenAI Responses adapter only supports function tools"
                    {:tool-type type})))
  (assoc function :type "function"))

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

(defn- message-items [message]
  (case (:role message)
    "user" [{:role "user" :content (responses-content (:content message))}]
    "assistant" (if (seq (:response_items message))
                  (:response_items message)
                  (fallback-assistant-items message))
    "tool" [{:type "function_call_output"
              :call_id (:tool_call_id message)
              :output (images/responses-output message)}]
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
                         :provider :openai
                         :provider-event event-type))))

(defn- response-from-events [events]
  (let [completed (some #(when (= "response.completed" (:type %))
                           (:response %))
                        (reverse events))
        done-items (->> events
                        (filter #(= "response.output_item.done" (:type %)))
                        (sort-by #(or (:output_index %) 0))
                        (mapv :item))
        failed (some #(when (contains? #{"response.failed" "error"}
                                        (:type %))
                        %)
                     (reverse events))]
    (cond
      completed (if (seq (:output completed))
                  completed
                  (assoc completed :output done-items))
      failed
      (throw (ex-info
              (or (get-in failed [:response :error :message])
                  (get-in failed [:error :message])
                  (:message failed)
                  "OpenAI response stream failed")
              {:provider :openai :event-type (:type failed)}))
      :else
      (throw (ex-info "OpenAI stream ended without response.completed"
                      {:provider :openai
                       :event-types (mapv :type events)})))))

(defn- terminal-response [ctx body cancel-token]
  (if (and (string? body) (str/starts-with? (str/trim body) "{"))
    (let [response (json/parse-string (str/trim body) true)]
      (kernel/emit! ctx :llm/stream
                    {:type :response/completed
                     :provider :openai
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

(defn- retry-wait! [cancel-token delay attempt]
  (let [milliseconds (min max-retry-delay-ms
                          (* delay (bit-shift-left 1 attempt)))]
    (loop [remaining milliseconds]
      (cancellation/throw-if-cancelled! cancel-token)
      (when (pos? remaining)
        (let [slice (min remaining 50)]
          (Thread/sleep slice)
          (recur (- remaining slice)))))))

(defn- close-body! [body]
  (when (instance? java.io.Closeable body)
    (try (.close ^java.io.Closeable body) (catch Throwable _))))

(defn- post-with-retry [config url options cancel-token]
  (let [max-retries (or (:max-retries config) default-max-retries)
        retry-delay (or (:retry-delay-ms config) default-retry-delay-ms)]
    (loop [attempt 0]
      (cancellation/throw-if-cancelled! cancel-token)
      (let [response (http/post url options)]
        (if (and (contains? transient-statuses (:status response))
                 (< attempt max-retries))
          (do
            (close-body! (:body response))
            (retry-wait! cancel-token retry-delay attempt)
            (recur (inc attempt)))
          response)))))

(defn generate [ctx config request]
  (validate-credential-endpoint! config)
  (images/require-tool-images! config #{:text :image} :openai request)
  (let [auth-id (or (:auth-id config) (:provider-id config) :openai)
        key (or (when-let [store (when-not (= :settings (:credential-source config))
                                  (kernel/service ctx :auth/store))]
                  (:api-key ((:resolve! store) auth-id)))
                (api-key config))]
    (when (str/blank? key)
      (throw (ex-info
              (str "Missing OpenAI API key; set "
                   (or (:api-key-env config) "OPENAI_API_KEY"))
              {:provider :openai :code :missing-credentials :retryable false})))
    (let [tools (mapv tool-schema (:tools request))
          use-stream? (not= false (:stream config))
          body (cond->
                (-> (merge (:extra-body config) (:options request))
                    (assoc :model (:model config)
                           :instructions (:system-prompt request)
                           :input (input-items (:messages request))
                           :store false
                           :stream use-stream?)
                    (dissoc :tools :tool_choice :parallel_tool_calls))
                 (seq tools)
                 (assoc :tools tools
                        :tool_choice "auto"
                        :parallel_tool_calls true))
          url (endpoint (or (:base-url config) default-base-url))
          response (post-with-retry
                    config url
                    {:headers (cond-> {"authorization" (str "Bearer " key)
                               "content-type" "application/json"
                               "accept" (if use-stream?
                                          "text/event-stream"
                                          "application/json")
                               "user-agent" "qi-agent/0.1"}
                                (get-in request [:accounting :request_id])
                                (assoc "x-qi-request-id" (get-in request [:accounting :request_id]))
                                (get-in request [:accounting :run-id])
                                (assoc "x-qi-run-id" (get-in request [:accounting :run-id]))
                                (get-in request [:accounting :purpose])
                                (assoc "x-qi-purpose" (name (get-in request [:accounting :purpose]))))
                     :body (json/generate-string body)
                     :as (if use-stream? :stream :string)
                     :throw false
                     :timeout (or (:timeout-ms config) default-timeout-ms)}
                    (:cancel-token request))]
      (when-not (<= 200 (:status response) 299)
        (throw (ex-info (str "OpenAI request failed with HTTP "
                             (:status response))
                        {:provider :openai
                         :status (:status response)
                         :body (error-body (:body response))
                         :retryable false})))
      (let [parsed (terminal-response ctx (:body response)
                                      (:cancel-token request))
            output (vec (:output parsed))
            calls (tool-calls output)
            content (output-text output)]
        (when-let [error (:error parsed)]
          (throw (ex-info (or (:message error) "OpenAI response failed")
                          {:provider :openai
                           :response-id (:id parsed)
                           :error error})))
        (when-not (seq output)
          (throw (ex-info "OpenAI response has no output items"
                          {:provider :openai
                           :response-id (:id parsed)
                           :status (:status parsed)})))
        {:message (cond-> {:role "assistant"
                          :content (when-not (str/blank? content) content)
                          :response_items output}
                    (seq calls) (assoc :tool_calls calls))
         :finish-reason (finish-reason parsed calls)
         :usage (:usage parsed)
         :model (:model parsed)}))))

(defn provider-entry
  "Build an OpenAI Responses registry entry for a validated provider config."
  [ctx config]
  (let [base-url (or (:base-url config) default-base-url)
        max-retries (or (:max-retries config) default-max-retries)
        retry-delay (or (:retry-delay-ms config) default-retry-delay-ms)]
    (when (str/blank? (:model config))
      (throw (ex-info "OpenAI Responses plugin requires :model"
                      {:provider :openai})))
    (validate-credential-endpoint! config)
    (when-not (and (nat-int? max-retries) (<= max-retries 10)
                   (pos-int? retry-delay)
                   (pos-int? (or (:timeout-ms config) default-timeout-ms)))
      (throw (ex-info "OpenAI Responses retry/timeout settings are invalid"
                      {:max-retries max-retries
                       :retry-delay-ms retry-delay
                       :timeout-ms (:timeout-ms config)})))
    {:id (or (:provider-id config) :openai)
     :provider :openai
     :model (:model config)
     :display-name (:display-name config)
     :settings-provider-id (:settings-provider-id config)
     :context-window (:context-window config)
     :max-output-tokens (get-in config [:extra-body :max_output_tokens])
     :thinking-levels (or (:thinking-levels config) [:low :medium :high])
     :default-thinking-level
     (or (:default-thinking-level config)
         (some-> (get-in config [:extra-body :reasoning :effort]) keyword))
     :input-modalities (images/input-modalities config #{:text :image})
     :generate (partial generate ctx (assoc config :base-url base-url))}))

(def plugin
  {:id :llm/openai-responses
   :description "Official OpenAI Responses API adapter."
   :provides #{:llm/generate}
   :start
   (fn [ctx config]
     (let [entry (provider-entry ctx config)]
       (when-let [store (kernel/service ctx :auth/store)]
         (kernel/track-effect!
          ctx
          ((:register! store)
           (or (:auth-id config) (:provider-id config) :openai)
           (fn [] {:api-key (api-key config)})
           {:provider :openai
            :source (if (:api-key config) :config :environment)})))
       (let [generator (:generate entry)]
         (if-let [registry (kernel/service ctx :llm/registry)]
           (kernel/track-effect!
            ctx
            ((:register! registry) entry))
           (kernel/register-service! ctx :llm/generate generator)))
       nil))})
