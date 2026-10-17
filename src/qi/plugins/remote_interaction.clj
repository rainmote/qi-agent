(ns qi.plugins.remote-interaction
  "Remote approval prompts resolved over RPC instead of reading worker stdin."
  (:require [qi.kernel :as kernel]
            [qi.cancellation :as cancellation]))

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
     (let [pending (atom {:revision 0 :entries {}})
           store (kernel/service ctx :session/store)
           durable! (fn [type data]
                      (when store ((:append! store) type data)))
           select!
           (fn [{:keys [default cancel-token] :as prompt}]
             (cancellation/throw-if-cancelled! cancel-token)
             (let [id (str (random-uuid))
                   completion (promise)
                   outcome (atom {:decision :deny :timed-out false})
                   initial-request (assoc (dissoc prompt :cancel-token)
                                          :id id :created-at
                                          (str (java.time.Instant/now)))
                   state (swap! pending
                                (fn [{:keys [revision entries]}]
                                  (let [revision (inc revision)]
                                    {:revision revision
                                     :entries (assoc entries id
                                                     {:request (assoc initial-request
                                                                      :revision revision)
                                                      :completion completion})})))
                   request (get-in state [:entries id :request])
                   detach (cancellation/on-cancel! cancel-token #(deliver completion ::cancelled))]
               (try
                 (durable! "interaction/request" request)
                 (kernel/emit! ctx :interaction/request request)
                 (let [decision (if timeout-ms
                                  (deref completion timeout-ms ::timeout)
                                  @completion)]
                   (when (or (= ::cancelled decision) (cancellation/cancelled? cancel-token))
                     (swap! outcome assoc :cancelled true)
                     (throw (ex-info "Approval interaction was cancelled" {:cancelled true})))
                   (let [result (if (= ::timeout decision) (or default :deny) decision)]
                     (reset! outcome {:decision result :timed-out (= ::timeout decision)})
                     result))
                 (catch InterruptedException error
                   (swap! outcome assoc :cancelled true :decision :deny)
                   (throw (ex-info "Approval interaction was cancelled" {:cancelled true} error)))
                 (finally
                   ;; Cancellation and future interruption must remove the same
                   ;; pending entry as ordinary resolution, even with no timeout.
                   (detach)
                   (let [state (swap! pending
                                      (fn [state]
                                        (-> state
                                            (update :revision inc)
                                            (update :entries dissoc id))))
                         resolved (assoc @outcome :id id :revision (:revision state))]
                     (durable! "interaction/resolved" resolved)
                     (kernel/emit! ctx :interaction/resolved resolved))))))
           resolve!
           (fn [id decision]
             (let [decision (keyword decision)
                   entry (get-in @pending [:entries id])]
               (when-not (contains? decisions decision)
                 (throw (ex-info "Invalid interaction decision"
                                 {:decision decision})))
               (when-not entry
                 (throw (ex-info "Interaction is not pending" {:id id})))
               (deliver (:completion entry) decision)
               {:id id :decision decision :resolved true}))
           snapshot (fn []
                      (let [state @pending]
                        {:revision (:revision state)
                         :pending (->> state :entries vals (mapv :request))}))
           service {:pending #(:pending (snapshot))
                    :snapshot snapshot
                    :cancel-all! (fn []
                                   (let [entries (vals (:entries @pending))]
                                     (doseq [{:keys [completion]} entries]
                                       (deliver completion ::cancelled))
                                     (count entries)))
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
         (doseq [{:keys [completion]} (vals (:entries @pending))]
           (deliver completion :deny)))))})
