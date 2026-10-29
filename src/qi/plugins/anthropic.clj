(ns qi.plugins.anthropic
  "Anthropic Messages adapter used by configurable Web providers."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.tool-images :as images]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- endpoint [base-url]
  (let [base (str/replace base-url #"/+$" "")]
    (str base (if (str/ends-with? base "/v1") "/messages" "/v1/messages"))))

(defn- api-key [{:keys [api-key api-key-env]}]
  (or api-key (when api-key-env (System/getenv api-key-env))))

(defn- content-blocks [content]
  (cond
    (string? content) [{:type "text" :text content}]
    (sequential? content)
    (mapv (fn [block]
            (case (keyword (:type block))
              :text {:type "text" :text (:text block)}
              :image (images/anthropic-image block)
              (throw (ex-info "Unsupported Anthropic content block"
                              {:block-type (:type block)}))))
          content)
    (nil? content) []
    :else [{:type "text" :text (str content)}]))

(defn- assistant-blocks [message]
  (vec
   (concat
    (content-blocks (:content message))
    (map (fn [call]
           {:type "tool_use"
            :id (:id call)
            :name (get-in call [:function :name])
            :input (let [arguments (get-in call [:function :arguments])]
                     (if (string? arguments)
                       (json/parse-string arguments true)
                       (or arguments {})))})
         (:tool_calls message)))))

(defn- anthropic-message [message]
  (case (:role message)
    "user" {:role "user" :content (content-blocks (:content message))}
    "assistant" {:role "assistant" :content (assistant-blocks message)}
    "tool" {:role "user"
            :content [(cond->
                        {:type "tool_result"
                         :tool_use_id (:tool_call_id message)
                         :content (if (seq (:images message))
                                    (into [{:type "text"
                                            :text (images/content-text (:content message))}]
                                          (map images/anthropic-image (:images message)))
                                    (images/content-text (:content message)))}
                        (:is-error message) (assoc :is_error true))]}
    nil))

(defn- anthropic-messages [messages]
  (vec
   (mapcat (fn [batch]
             (let [converted (keep anthropic-message batch)]
               (if (= "tool" (:role (first batch)))
                 [{:role "user" :content (vec (mapcat :content converted))}]
                 converted)))
           (partition-by #(= "tool" (:role %)) messages))))

(defn- anthropic-tool [{:keys [type function]}]
  (when-not (= "function" type)
    (throw (ex-info "Anthropic adapter only supports function tools"
                    {:tool-type type})))
  {:name (:name function)
   :description (:description function)
   :input_schema (:parameters function)})

(defn- error-body [body]
  (let [text (if (string? body) body
                 (try (slurp body) (catch Throwable _ (pr-str body))))]
    (subs text 0 (min 1200 (count text)))))

(defn generate [ctx config request]
  (images/require-tool-images! config #{:text :image} :anthropic request)
  (let [auth-id (or (:auth-id config) (:settings-provider-id config)
                    (:provider-id config) :anthropic)
        key (if-let [store (kernel/service ctx :auth/store)]
              (:api-key ((:resolve! store) auth-id))
              (api-key config))]
    (when (str/blank? key)
      (throw (ex-info (str "Missing Anthropic API key; set "
                           (or (:api-key-env config) ":api-key"))
                      {:provider :anthropic})))
    (let [messages (anthropic-messages (:messages request))
          tools (mapv anthropic-tool (:tools request))
          body (cond-> {:model (:model config)
                        :max_tokens (or (:max-output-tokens config) 8192)
                        :system (:system-prompt request)
                        :messages messages}
                 (seq tools) (assoc :tools tools)
                 (:extra-body config) (merge (:extra-body config)))
          _ (cancellation/throw-if-cancelled! (:cancel-token request))
          response (http/post
                    (endpoint (:base-url config))
                    {:headers {"x-api-key" key
                               "anthropic-version" (or (:anthropic-version config)
                                                        "2023-06-01")
                               "content-type" "application/json"}
                     :body (json/generate-string body)
                     :as :string
                     :throw false
                     :timeout (or (:timeout-ms config) 180000)})]
      (when-not (<= 200 (:status response) 299)
        (throw (ex-info (str "Anthropic request failed with HTTP " (:status response))
                        {:provider :anthropic
                         :status (:status response)
                         :body (error-body (:body response))})))
      (cancellation/throw-if-cancelled! (:cancel-token request))
      (let [parsed (json/parse-string (:body response) true)
            blocks (:content parsed)
            text (->> blocks (filter #(= "text" (:type %))) (map :text)
                      (remove str/blank?) (str/join "\n"))
            calls (->> blocks
                       (filter #(= "tool_use" (:type %)))
                       (mapv (fn [block]
                               {:id (:id block)
                                :type "function"
                                :function {:name (:name block)
                                           :arguments (json/generate-string
                                                       (or (:input block) {}))}})))]
        (when-not (str/blank? text)
          (kernel/emit! ctx :llm/stream
                        {:type :text/delta :provider :anthropic :delta text}))
        (kernel/emit! ctx :llm/stream
                      {:type :response/completed :provider :anthropic})
        {:message (cond-> {:role "assistant"
                           :content (when-not (str/blank? text) text)}
                    (seq calls) (assoc :tool_calls calls))
         :finish-reason (if (seq calls) "tool_calls" (or (:stop_reason parsed) "stop"))
         :usage (:usage parsed)
         :model (:model parsed)}))))

(defn provider-entry [ctx config]
  (when-not (and (string? (:base-url config))
                 (not (str/blank? (:base-url config)))
                 (string? (:model config))
                 (not (str/blank? (:model config))))
    (throw (ex-info "Anthropic provider requires :base-url and :model"
                    {:config (dissoc config :api-key)})))
  {:id (or (:provider-id config) :anthropic)
   :provider :anthropic-messages
   :model (:model config)
   :display-name (:display-name config)
   :settings-provider-id (:settings-provider-id config)
   :context-window (:context-window config)
   :max-output-tokens (max (or (:max-output-tokens config) 8192)
                           (or (get-in config [:extra-body :max_tokens]) 0))
   :input-modalities (images/input-modalities config #{:text :image})
   :generate (partial generate ctx config)})

(def plugin
  {:id :llm/anthropic-messages
   :description "Anthropic Messages API adapter."
   :provides #{:llm/generate}
   :start
   (fn [ctx config]
     (let [entry (provider-entry ctx config)]
       (when-let [store (kernel/service ctx :auth/store)]
         (kernel/track-effect!
          ctx
          ((:register! store)
           (or (:auth-id config) (:provider-id config) :anthropic)
           (fn [] {:api-key (api-key config)})
           {:provider :anthropic :source (if (:api-key config) :config :environment)})))
       (if-let [registry (kernel/service ctx :llm/registry)]
         (kernel/track-effect! ctx ((:register! registry) (kernel/wrap-plugin-value ctx entry)))
         (kernel/register-service! ctx :llm/generate (:generate entry))))
     nil)})
