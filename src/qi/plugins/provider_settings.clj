(ns qi.plugins.provider-settings
  "Load Web-managed provider/model settings and reconcile the live registries."
  (:require [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.secure-files :as secure]
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
      (if-not (java.nio.file.Files/exists (.toPath file)
                  (into-array java.nio.file.LinkOption [java.nio.file.LinkOption/NOFOLLOW_LINKS]))
        []
        (let [_ (secure/assert-owner-file! file)
              state (json/parse-string (slurp file) true)]
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

(defn- runtime-id [provider-id model-id]
  (keyword (str (name provider-id) "--"
                (java.util.UUID/nameUUIDFromBytes
                 (.getBytes (pr-str [provider-id model-id]) "UTF-8")))))

(defn- identity-of [entry]
  [(or (:settings-provider-id entry) (:id entry)) (:model entry)])

(def ^:private environment-bindings
  {"OPENAI_API_KEY" {:protocols #{"openai-responses" "openai-completions"}
                     :base-url "https://api.openai.com/v1"}
   "DEEPSEEK_API_KEY" {:protocols #{"openai-completions"}
                       :base-url "https://api.deepseek.com"}
   "ANTHROPIC_API_KEY" {:protocols #{"anthropic-messages"}
                        :base-url "https://api.anthropic.com"}})

(defn- validate-provider-credentials! [provider]
  (when-let [env (:apiKeyEnv provider)]
    (let [{:keys [protocols base-url]} (get environment-bindings env)]
      (when-not (and (contains? protocols (:protocol provider))
                     (= base-url (str/replace (or (:baseUrl provider) "") #"/+$" "")))
        (throw (ex-info "Credential environment binding does not match its canonical endpoint/protocol"
                        {:code :credential-scope})))))
  provider)

(defn- model-entry [ctx provider model]
  (let [provider-id (provider-keyword (:id provider))
        config {:provider-id (runtime-id provider-id (:id model))
                :settings-provider-id provider-id
                :auth-id provider-id
                :base-url (:baseUrl provider)
                :api-key (:apiKey provider)
                :api-key-env (:apiKeyEnv provider)
                :credential-source (if (:apiKeyEnv provider) :environment :settings)
                :allow-custom-endpoint (and (nil? (:apiKeyEnv provider))
                                            (not (str/blank? (:apiKey provider))))
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
                   selected ((:current registry))
                   previous ((:providers registry))
                   providers (mapv validate-provider-credentials! (read-providers path))
                   managed (remove #(= "chatgpt-subscription" (:protocol %)) providers)
                   ;; Validate and construct the complete replacement before
                   ;; removing working registrations.
                   entries (vec (mapcat (fn [provider]
                                          (map #(model-entry ctx provider %) (:models provider)))
                                        managed))]
               (when-not (= (count entries) (count (set (map :id entries))))
                 (throw (ex-info "Provider settings contain duplicate model identities" {})))
               (dispose-all! effects)
               (doseq [provider managed]
                 (let [provider-id (provider-keyword (:id provider))
                       key (:apiKey provider)
                       key-env (:apiKeyEnv provider)]
                   ;; Replace the built-in provider alias while this provider
                   ;; is managed by Web; restore it when the override is removed.
                   (swap! effects conj ((:mask! registry) provider-id))
                   (swap! effects conj
                          ((:upsert! auth) provider-id
                           (fn [] {:api-key (or key (when key-env (System/getenv key-env)))})
                           {:provider (keyword (:protocol provider))
                            :source (if key :settings :environment)}))))
               (doseq [entry entries]
                 (swap! effects conj ((:upsert! registry) entry)))
               (doseq [provider managed
                       :let [id (provider-keyword (:id provider))]
                       :when (seq (:models provider))]
                 (swap! effects conj ((:alias! registry) id
                                      (runtime-id id (:id (first (:models provider)))))))
               (let [available ((:providers registry))
                     by-identity (into {} (map (juxt identity-of identity) available))
                     retained (get by-identity (identity-of selected))
                     fallback (or retained (some #(when (= (:id selected) (:id %)) %) available)
                                  (when-not selected ((:current registry)))
                                  (some #(when (= (first (identity-of selected))
                                                   (:settings-provider-id %)) %) entries)
                                  (first entries))
                     levels (into {} (keep (fn [entry]
                                            (when-let [next (get by-identity (identity-of entry))]
                                              [(:id next) (:thinking-level entry)])) previous))
                     warnings (cond-> []
                                (and selected (nil? retained))
                                (conj "原选模型已移除或替换，请确认当前模型。")
                                (and retained (:thinking-level selected)
                                     (not (some #{(:thinking-level selected)} (:thinking-levels retained))))
                                (conj "原推理强度已不受支持，已使用模型默认值。"))]
                 ((:restore-selection! registry) (:id fallback) levels)
                 {:path path
                  :providers (count providers)
                  :models (reduce + 0 (map #(count (:models %)) providers))
                  :warnings warnings})))]
       (reload!)
       (kernel/register-service!
        ctx :provider/settings
        {:path path
         :reload! (fn [] (locking effects (reload!)))})
       #(dispose-all! effects)))})
