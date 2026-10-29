(ns qi.kernel
  "Small plugin host. It owns registries and reversible effects, but no agent policy."
  (:require [clojure.string :as str]
            [qi.lifecycle :as lifecycle]))

(declare reconcile! dispose-plugin!)

(defn create-context []
  (let [ctx {:state (atom {:services {}
                 :tools {}
                 :commands {}
                 :hooks {}
                 :instances {}
                 :loaded []
                 :sequence 0})
             :reconcile (atom nil)
             :reconciling? (atom false)
             :reconcile-thread (atom nil)
             :reconcile-dirty? (atom false)}]
    (reset! (:reconcile ctx) #(reconcile! ctx))
    ctx))

(defn plugin-context [ctx plugin-id]
  (lifecycle/context ctx plugin-id))

(defn begin-plugin! [ctx plugin-id options]
  (lifecycle/begin! ctx plugin-id options))

(defn with-plugin-call [ctx f] (lifecycle/with-call ctx f))
(defn wrap-plugin-value [ctx value] (lifecycle/wrap-value ctx value))
(defn inspection [f] (lifecycle/inspection f))
(defn track-stop! [ctx stop] (lifecycle/track-stop! ctx stop))

(defn- owner! [ctx]
  (or (:plugin/id ctx)
      (throw (ex-info "Registration requires a plugin context" {}))))

(defn- next-sequence! [ctx]
  (:sequence (swap! (:state ctx) update :sequence inc)))

(defn track-effect!
  "Track a disposer under the active plugin. Effects unwind in reverse order."
  [ctx dispose]
  (owner! ctx)
  (lifecycle/track! ctx dispose))

(defn- register-entry! [ctx registry key payload]
  (let [owner (owner! ctx)
        entry-id (str (random-uuid))
        registration {:owner owner :generation (:plugin/generation ctx) :entry-id entry-id}
        entry (merge registration payload)
        dispose #(do
                   (swap! (:state ctx)
                          (fn [state]
                            (if (= entry-id (get-in state [registry key :entry-id]))
                              (cond-> (update state registry dissoc key)
                                (= registry :services) (assoc-in [:retired-services entry-id] entry)) state)))
                   (when (= :services registry) (lifecycle/notify! ctx)))
        disposer (lifecycle/commit!
                  ctx
                  (fn [state]
                    (when-let [existing (get-in state [registry key])]
                      (throw (ex-info (str "Registration already registered: " key)
                                      {:registry registry :key key :owner (:owner existing)})))
                    (assoc-in state [registry key] entry))
                  dispose)]
    (when (= :services registry) (lifecycle/notify! ctx))
    disposer))

(defn register-service!
  "Register a single-owner service and return an idempotent disposer."
  [ctx service-key value]
  (register-entry! ctx :services service-key {:value (lifecycle/wrap-value ctx value)}))

(defn service [ctx service-key]
  (let [state @(:state ctx)
        binding (lifecycle/bound-service ctx service-key)
        current (get-in state [:services service-key])
        entry (if (and binding (not= (:entry-id binding) (:entry-id current)))
                (get-in state [:retired-services (:entry-id binding)]) current)]
    (when (and entry
               (or (not= :starting (get-in state [:instances (:owner entry) :phase]))
                   (lifecycle/active-call? (assoc ctx :plugin/id (:owner entry) :plugin/generation (:generation entry))))
               (lifecycle/callable? state (assoc ctx :plugin/id (:owner entry)
                                                    :plugin/generation (:generation entry))))
      (:value entry))))

(defn require-service [ctx service-key]
  (or (service ctx service-key)
      (throw (ex-info (str "Required service is unavailable: " service-key)
                      {:service service-key}))))

(defn service-keys [ctx]
  (let [state @(:state ctx)]
    (set (for [key (keys (:services state)) :when (service ctx key)] key))))

(defn register-tool!
  "Register a model-facing tool. A tool owns canonical output and rendering."
  [ctx {:keys [name description parameters execute] :as tool}]
  (let [owner (owner! ctx)]
    (when-not (and (string? name)
                   (not (str/blank? name))
                   (string? description)
                   (map? parameters)
                   (fn? execute))
      (throw (ex-info "Invalid tool definition"
                      {:required [:name :description :parameters :execute]
                       :tool (dissoc tool :execute :render)})))
    (register-entry! ctx :tools name {:definition (lifecycle/wrap-value ctx tool)})))

(defn tool [ctx tool-name]
  (let [state @(:state ctx) entry (get-in state [:tools tool-name])]
    (when (and entry (lifecycle/visible? state entry))
      (assoc (:definition entry) ::registration (select-keys entry [:owner :generation :entry-id])))))

(defn tool-current? [ctx definition]
  (let [registered (tool ctx (:name definition))]
    (and registered (= (::registration registered) (::registration definition)))))

(defn tools [ctx]
  (->> (keys (:tools @(:state ctx)))
       (keep #(tool ctx %))
       (sort-by :name)
       vec))

(defn tool-schemas [ctx]
  (mapv (fn [{:keys [name description parameters strict]}]
          {:type "function"
           :function (cond-> {:name name
                              :description description
                              :parameters parameters}
                       (some? strict) (assoc :strict strict))})
        (tools ctx)))

(defn register-command!
  "Register a slash command `(fn [argument context])` as a reversible effect."
  [ctx {:keys [name description execute] :as command}]
  (let [owner (owner! ctx)]
    (when-not (and (string? name) (not (str/blank? name))
                   (string? description) (fn? execute))
      (throw (ex-info "Invalid command definition"
                      {:command (dissoc command :execute)})))
    (register-entry! ctx :commands name {:definition (lifecycle/wrap-value ctx command)})))

(defn command [ctx name]
  (let [state @(:state ctx) entry (get-in state [:commands name])]
    (when (and entry (lifecycle/visible? state entry)) (:definition entry))))

(defn commands [ctx]
  (->> (keys (:commands @(:state ctx))) (keep #(command ctx %))
       (sort-by :name) vec))

(defn- register-listener! [ctx event kind priority handler]
  (let [owner (owner! ctx)
        id (str (random-uuid))
        entry {:id id
               :owner owner
               :generation (:plugin/generation ctx)
               :kind kind
               :priority priority
               :sequence (next-sequence! ctx)
               :handler (lifecycle/wrap-value ctx handler)}]
    (when-not (fn? handler)
      (throw (ex-info "Listener must be a function" {:event event})))
    (lifecycle/commit!
     ctx #(update-in % [:hooks event] (fnil conj []) entry)
     #(swap! (:state ctx) update-in [:hooks event]
             (fn [entries]
               (->> entries (remove (comp #{id} :id)) vec))))))

(defn on!
  "Register a contained observer `(fn [ctx event])`."
  ([ctx event handler] (on! ctx event 0 handler))
  ([ctx event priority handler]
   (register-listener! ctx event :observer priority handler)))

(defn intercept!
  "Register ordered waterfall middleware `(fn [ctx value next])`."
  ([ctx event handler] (intercept! ctx event 0 handler))
  ([ctx event priority handler]
   (register-listener! ctx event :interceptor priority handler)))

(defn- listeners [ctx event kind]
  (let [state @(:state ctx)]
  (->> (get-in state [:hooks event] [])
       (filter #(lifecycle/visible? state %))
       (filter (comp #{kind} :kind))
       (sort-by (juxt :priority :sequence))
       vec)))

(defn register-tool-guard!
  "A final guard may abstain (nil) or deny ({:reason ...}); it cannot allow."
  [ctx guard]
  (register-listener! ctx :tool/guard :guard 0 guard))

(defn tool-guard-identities [ctx]
  (mapv #(select-keys % [:owner :generation :id]) (listeners ctx :tool/guard :guard)))

(defn check-tool-guards! [ctx request]
  (some (fn [{:keys [owner handler]}]
          (try
            (let [denial (handler ctx request)]
              (when-not (nil? denial)
               (if (and (map? denial) (string? (:reason denial))) denial
                  {:reason "Invalid tool guard result" :guard owner})))
            (catch Throwable error {:reason (str "Tool guard failed: " (ex-message error)) :guard owner})))
        (listeners ctx :tool/guard :guard)))

(defn emit!
  "Notify observers. Observer failures are contained so telemetry cannot break work."
  [ctx event data]
  (doseq [{:keys [owner handler]} (listeners ctx event :observer)]
    (try
      (handler ctx data)
      (catch Throwable error
        (binding [*out* *err*]
          (println (str "observer " owner " failed for " event ": "
                        (ex-message error)))))))
  data)

(defn waterfall
  "Run interceptors in priority/load order. Each interceptor must delegate with
  `(next value)` or return a final value."
  [ctx event initial terminal]
  (let [chain (listeners ctx event :interceptor)]
    (letfn [(step [index value]
              (if-let [{:keys [handler]} (get chain index)]
                (handler ctx value
                         (fn
                           ([] (step (inc index) value))
                           ([next-value] (step (inc index) next-value))))
                (terminal value)))]
      (step 0 initial))))

(defn dispose-plugin!
  "Close admission, stop dependent consumers, drain calls, and report cleanup."
  ([ctx plugin-id] (dispose-plugin! ctx plugin-id {}))
  ([ctx plugin-id options]
     (let [receipt (lifecycle/stop-many! ctx plugin-id options)]
       (lifecycle/notify! ctx)
       receipt)))

(defn mark-loaded! [ctx metadata]
  (let [owner (if (= (:plugin/id ctx) (:id metadata)) ctx (plugin-context ctx (:id metadata)))]
    (swap! (:state ctx)
           (fn [state]
             (lifecycle/check! state owner)
             (let [entry (get-in state [:instances (:id metadata)])]
               (when-not (and (= (set (:requires entry)) (set (keys (:bindings entry))))
                              (= (:bindings entry {}) (lifecycle/bindings state (:requires entry))))
                 (throw (ex-info "Required services changed during plugin startup" {:plugin (:id metadata)}))))
             (-> state
                 (assoc-in [:instances (:id metadata) :phase] :active)
                 (update :loaded (fn [loaded]
                                   (conj (vec (remove #(= (:id metadata) (:id %)) loaded)) metadata))))))
    (lifecycle/notify! ctx))
  metadata)

(defn reconcile! [ctx]
  (reset! (:reconcile-dirty? ctx) true)
  (when (compare-and-set! (:reconciling? ctx) false true)
    (reset! (:reconcile-thread ctx) (.getId (Thread/currentThread)))
    (try
      (loop []
        (reset! (:reconcile-dirty? ctx) false)
        (when-not (:closing? @(:state ctx))
          (doseq [[id entry] (:instances @(:state ctx))
                  :when (and (= :active (:phase entry)) (seq (:requires entry))
                             (not= (:bindings entry) (lifecycle/bindings @(:state ctx) (:requires entry))))]
            (dispose-plugin! ctx id {:preserve-desired? true :reason :dependency-unavailable}))
          (doseq [[id entry] (:instances @(:state ctx))
                  :when (and (= :stopped (:phase entry)) (:desired? entry) (:restart! entry)
                             (= :dependency-unavailable (:stop-reason entry))
                             (= :complete (get-in entry [:receipt :status]))
                             (= (set (:requires entry)) (set (keys (lifecycle/bindings @(:state ctx) (:requires entry))))))]
            (try ((:restart! entry) (:generation entry))
                 (catch Throwable error
                   (swap! (:state ctx)
                          (fn [state]
                            (if (and (= (:generation entry) (get-in state [:instances id :generation]))
                                     (get-in state [:instances id :desired?]))
                              (update-in state [:instances id] assoc :desired? false :diagnostic (ex-message error))
                              state)))))))
        (when @(:reconcile-dirty? ctx) (recur)))
      (finally (reset! (:reconcile-thread ctx) nil) (reset! (:reconciling? ctx) false)))
    (when @(:reconcile-dirty? ctx) (reconcile! ctx))))

(defn await-reconciliation! [ctx]
  (when-not (= (.getId (Thread/currentThread)) @(:reconcile-thread ctx))
    (let [deadline (+ (System/nanoTime) (* lifecycle/default-timeout-ms 1000000))]
      (loop []
        (when @(:reconciling? ctx)
          (when (> (System/nanoTime) deadline)
            (throw (ex-info "Plugin dependency reconciliation is still pending" {:type :plugin/reconcile-timeout})))
          (Thread/sleep 1)
          (recur))))))

(defn loaded-plugins [ctx]
  (let [state @(:state ctx)]
    (filterv #(= :active (get-in state [:instances (:id %) :phase])) (:loaded state))))

(defn runtime-snapshot
  "Return deterministic, read-only runtime metadata for inspection.

  Service values, handlers, disposers, and executable functions are excluded."
  [ctx]
  (let [state @(:state ctx)
        {:keys [commands hooks loaded services tools]} state
        public-definition
        (fn [[name {:keys [owner definition]}]]
          (cond-> {:name (str name)
                   :owner (str owner)}
            (:description definition)
            (assoc :description (:description definition))))]
    {:lifecycles (->> (:instances state)
                      (map (fn [[id entry]]
                             (assoc (select-keys entry [:generation :phase :calls :desired? :stop-reason :receipt :diagnostic])
                                    :id (str id))))
                      (sort-by :id) vec)
     :plugins (->> (loaded-plugins ctx)
                   (map #(select-keys % [:id :namespace :description]))
                   (map #(cond-> (update % :id str) (:namespace %) (update :namespace str)))
                   (sort-by :id)
                   vec)
     :services (->> services
                    (map (fn [[key {:keys [owner]}]]
                           {:key (str key)
                            :owner (str owner)}))
                    (sort-by :key)
                    vec)
     :tools (->> tools
                 (map public-definition)
                 (sort-by :name)
                 vec)
     :commands (->> commands
                    (map public-definition)
                    (sort-by :name)
                    vec)
     :hooks (->> hooks
                 (map (fn [[event entries]]
                        {:event (str event)
                         :observers (count (filter (comp #{:observer} :kind) entries))
                         :interceptors (count (filter (comp #{:interceptor} :kind) entries))}))
                 (sort-by :event)
                 vec)}))

(defn dispose-all! [ctx]
  (swap! (:state ctx) assoc :closing? true)
  (let [ids (vec (keys (:instances @(:state ctx))))
        self? (some #(lifecycle/current-call? (assoc ctx :plugin/id % :plugin/generation
                                                     (get-in @(:state ctx) [:instances % :generation]))) ids)
        deadline (+ (System/nanoTime) (* lifecycle/default-timeout-ms 1000000))]
    ;; Close every admission and launch every stop signal before waiting for
    ;; any root. An unrelated provider may be what releases a blocked RPC.
    (when-let [id (first ids)]
      (lifecycle/stop-many! ctx id {:all? true :reason :shutdown :timeout-ms 1}))
    (let [receipts (mapv (fn [id]
                           (let [entry (get-in @(:state ctx) [:instances id])]
                             (or (:receipt entry)
                                 (deref (:completion entry)
                                        (if self? 0 (max 0 (long (/ (- deadline (System/nanoTime)) 1000000))))
                                        {:plugin id :generation (:generation entry)
                                         :status (if self? :pending :timeout)})))) ids)]
      {:status (if (every? #(= :complete (:status %)) receipts) :complete :incomplete)
       :plugins receipts})))
