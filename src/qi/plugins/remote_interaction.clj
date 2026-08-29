(ns qi.plugins.remote-interaction
  "Remote approval prompts resolved over RPC instead of reading worker stdin."
  (:require [qi.kernel :as kernel]))

(def ^:private decisions #{:allow :allow-session :deny})

(def plugin
  {:id :remote/interaction
   :description "Asynchronous WebUI interaction and approval bridge."
   :requires #{:remote/registry}
   :provides #{:ui/prompt :interaction/remote}
   :start
   (fn [ctx {:keys [timeout-ms] :or {timeout-ms 300000}}]
     (when-not (or (nil? timeout-ms)
                   (and (int? timeout-ms) (pos? timeout-ms)))
       (throw (ex-info "Remote interaction timeout must be nil or positive"
                       {:timeout-ms timeout-ms})))
     (let [pending (atom {})
           store (kernel/service ctx :session/store)
           durable! (fn [type data]
                      (when store ((:append! store) type data)))
           select!
           (fn [{:keys [default] :as prompt}]
             (let [id (str (random-uuid))
                   completion (promise)
                   request (assoc (dissoc prompt :cancel-token)
                                  :id id :created-at
                                  (str (java.time.Instant/now)))]
               (swap! pending assoc id {:request request
                                        :completion completion})
               (durable! "interaction/request" request)
               (kernel/emit! ctx :interaction/request request)
               (let [decision (if timeout-ms
                                (deref completion timeout-ms ::timeout)
                                @completion)
                     result (if (= ::timeout decision)
                              (or default :deny)
                              decision)]
                 (swap! pending dissoc id)
                 (durable! "interaction/resolved"
                           {:id id :decision result
                            :timed-out (= ::timeout decision)})
                 (kernel/emit! ctx :interaction/resolved
                               {:id id :decision result
                                :timed-out (= ::timeout decision)})
                 result)))
           resolve!
           (fn [id decision]
             (let [decision (keyword decision)
                   entry (get @pending id)]
               (when-not (contains? decisions decision)
                 (throw (ex-info "Invalid interaction decision"
                                 {:decision decision})))
               (when-not entry
                 (throw (ex-info "Interaction is not pending" {:id id})))
               (deliver (:completion entry) decision)
               {:id id :decision decision :resolved true}))
           service {:pending #(->> @pending vals (mapv :request))
                    :resolve! resolve!}
           registry (kernel/require-service ctx :remote/registry)
           dispose-list
           ((:register! registry)
            {:method "interaction.list"
             :description "List unresolved user interactions."
             :params-schema {:type "object" :additionalProperties false}
             :result-schema {:type "array"}
             :handler (fn [_] ((:pending service)))})
           dispose-resolve
           ((:register! registry)
            {:method "interaction.resolve"
             :description "Resolve a pending approval interaction."
             :params-schema
             {:type "object" :required ["id" "decision"]
              :properties
              {"id" {:type "string"}
               "decision" {:type "string"
                           :enum ["allow" "allow-session" "deny"]}}
              :additionalProperties false}
             :result-schema {:type "object"}
             :handler (fn [{:keys [id decision]}]
                        (resolve! id decision))})]
       (kernel/register-service! ctx :ui/prompt
                                 {:active? (constantly true)
                                  :select! select!})
       (kernel/register-service! ctx :interaction/remote service)
       (kernel/track-effect! ctx dispose-list)
       (kernel/track-effect! ctx dispose-resolve)
       (fn []
         (doseq [{:keys [completion]} (vals @pending)]
           (deliver completion :deny)))))})
