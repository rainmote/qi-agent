;; Trusted container entrypoint. The candidate cannot alter this file or its profile.
(require '[qi.plugin :as plugin] '[qi.kernel :as kernel] '[qi.protocol :as protocol])
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
        config (update profile :plugins
                       #(mapv (fn [spec]
                                (case (:ns spec)
                                  qi.plugins.runtime (update spec :config merge {:max-steps 32 :max-retries 0
                                                                                :max-model-requests 64 :max-wall-ms 2100000})
                                  qi.plugins.openai-responses (update spec :config merge
                                                                     (cond-> {:max-retries 0}
                                                                       broker-url (assoc :base-url broker-url :api-key "maintenance-broker"
                                                                                         :stream false)))
                                  spec)) %))
        ctx (plugin/boot! config)]
    (try (protocol/json-once! ctx prompt)
         (finally (kernel/dispose-all! ctx)))))
