;; Trusted container entrypoint. The candidate cannot alter this file or its profile.
(require '[qi.plugin :as plugin] '[qi.kernel :as kernel] '[qi.protocol :as protocol]
         '[qi.plugins.openai-responses :as responses])
(let [[profile-path prompt] *command-line-args*
      profile (plugin/read-config profile-path)
      allowed '#{qi.plugins.session qi.plugins.model-registry qi.plugins.openai-responses
                 qi.plugins.execution-world qi.plugins.trust qi.plugins.tools qi.plugins.omp
                 qi.plugins.approval qi.plugins.policy qi.plugins.context-manager qi.plugins.runtime}
      namespaces (map :ns (:plugins profile))]
  (when (or (some #(not (allowed %)) namespaces)
            (not= (count namespaces) (count (set namespaces)))
            (not (some #{'qi.plugins.runtime} namespaces)))
    (throw (ex-info "Maintenance profile must use the audited single-agent plugin set" {})))
  (let [broker-url (System/getenv "QI_MAINTENANCE_BROKER_URL")
        broker-port (some->> broker-url (re-matches #"http://127\.0\.0\.1:([0-9]{1,5})/v1") second parse-long)
        _ (when (and broker-url (not (and broker-port (<= 1 broker-port 65535))))
            (throw (ex-info "Maintenance broker must be an exact loopback relay URL" {})))
        config (update profile :plugins
                       #(mapv (fn [spec]
                                (case (:ns spec)
                                  qi.plugins.runtime (update spec :config merge {:max-steps 32 :max-retries 0
                                                                                :max-model-requests 64 :max-wall-ms 2100000})
                                  qi.plugins.openai-responses (update spec :config merge {:max-retries 0})
                                  spec)) %))
        ctx (plugin/boot! config)]
    (try
      ;; The official plugin keeps its credential-origin guard. Only this
      ;; trusted, disconnected worker replaces its provider with a validated
      ;; loopback adapter that never reads a real API credential.
      (when broker-url
        (let [provider-config (some #(when (= 'qi.plugins.openai-responses (:ns %)) (:config %)) (:plugins config))
              registry (kernel/require-service ctx :llm/registry)]
          (kernel/track-effect! (kernel/plugin-context ctx :llm/openai-responses)
            ((:upsert! registry)
             (responses/provider-entry ctx
               (assoc provider-config :base-url broker-url :api-key "maintenance-broker"
                      :api-key-env nil :credential-source :settings :allow-custom-endpoint true
                      :stream false :max-retries 0))))))
      (protocol/json-once! ctx prompt)
         (finally (kernel/dispose-all! ctx)))))
