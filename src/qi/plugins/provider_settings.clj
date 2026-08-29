(ns qi.plugins.provider-settings
  "Load Web-managed provider/model settings and reconcile the live registries."
  (:require [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.plugins.anthropic :as anthropic]
            [qi.plugins.openai :as openai]
            [qi.plugins.openai-responses :as openai-responses]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(defn- configured-path [config]
  (or (:path config)
      (qenv/get "QI_AGENT_PROVIDER_SETTINGS_FILE"
                "DAO_PROVIDER_SETTINGS_FILE")))

(defn- read-providers [path]
  (if (str/blank? path)
    []
    (let [file (io/file path)]
      (if-not (.isFile file)
        []
        (let [state (json/parse-string (slurp file) true)]
          (when-not (= 1 (:version state))
            (throw (ex-info "Unsupported provider settings version"
                            {:path path :version (:version state)})))
          (vec (:providers state)))))))

(defn- provider-keyword [value]
  (let [value (str value)]
    (when-not (re-matches #"[a-z][a-z0-9._-]{1,63}" value)
      (throw (ex-info "Provider settings contain an invalid provider id"
                      {:provider value})))
    (keyword value)))

(defn- runtime-id [provider-id index]
  (if (zero? index)
    provider-id
    (keyword (str (name provider-id) "--" (inc index)))))

(defn- model-entry [ctx provider model index]
  (let [provider-id (provider-keyword (:id provider))
        config {:provider-id (runtime-id provider-id index)
                :settings-provider-id provider-id
                :auth-id provider-id
                :base-url (:baseUrl provider)
                :api-key (:apiKey provider)
                :api-key-env (:apiKeyEnv provider)
                :model (:id model)
                :display-name (or (:name model) (:id model))
                :context-window (:contextWindow model)
                :thinking-levels (some->> (:thinkingLevels model)
                                          (mapv keyword))
                :default-thinking-level
                (some-> (:defaultThinkingLevel model) keyword)
                :timeout-ms 180000}]
    (case (:protocol provider)
      "openai-completions" (openai/provider-entry ctx config)
      "openai-responses" (openai-responses/provider-entry ctx config)
      "anthropic-messages" (anthropic/provider-entry ctx config)
      (throw (ex-info "Provider settings contain an unsupported protocol"
                      {:provider (:id provider)
                       :protocol (:protocol provider)})))))

(defn- dispose-all! [effects]
  (doseq [dispose (reverse @effects)]
    (try (dispose) (catch Throwable _)))
  (reset! effects []))

(def plugin
  {:id :llm/provider-settings
   :description "Persistent Web-managed provider and model catalog."
   :requires #{:llm/registry :auth/store}
   :provides #{:provider/settings}
   :start
   (fn [ctx config]
     (let [path (configured-path config)
           effects (atom [])
           reload!
           (fn []
             (let [registry (kernel/require-service ctx :llm/registry)
                   auth (kernel/require-service ctx :auth/store)
                   selected-id (some-> ((:current registry)) :id)
                   providers (read-providers path)]
               (dispose-all! effects)
               (doseq [provider providers]
                 ;; ChatGPT subscription authentication and transport settings
                 ;; are owned by qi.plugins.chatgpt. The Web catalog only
                 ;; reports its local Codex login state; it must not replace
                 ;; that dynamic auth resolver with an API-key resolver.
                 (when-not (= "chatgpt-subscription" (:protocol provider))
                   (let [provider-id (provider-keyword (:id provider))
                         key (:apiKey provider)
                         key-env (:apiKeyEnv provider)]
                     (swap! effects conj
                            ((:upsert! auth)
                             provider-id
                             (fn [] {:api-key (or key
                                                  (when key-env
                                                    (System/getenv key-env)))})
                             {:provider (keyword (:protocol provider))
                              :source (if key :settings :environment)}))
                     (doseq [[index model] (map-indexed vector (:models provider))]
                       (swap! effects conj
                              ((:upsert! registry)
                               (model-entry ctx provider model index)))))))
               (when (and selected-id
                          (some #(= selected-id (:id %)) ((:providers registry))))
                 ((:select! registry) selected-id))
               {:path path
                :providers (count providers)
                :models (reduce + 0 (map #(count (:models %)) providers))}))]
       (reload!)
       (kernel/register-service!
        ctx :provider/settings
        {:path path
         :reload! reload!})
       #(dispose-all! effects)))})
