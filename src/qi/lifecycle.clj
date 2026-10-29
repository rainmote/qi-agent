(ns qi.lifecycle
  "Instance identities, call admission and bounded, observable plugin shutdown.
  No plugin callbacks run inside a registry transaction.")

(def ^:dynamic *calls* {})
(def ^:dynamic *cleanup* {})
(def ^:dynamic *call-stack* [])
(def default-timeout-ms 5000)
(declare bindings)

(defn identity-key [ctx]
  [(:state ctx) (:plugin/id ctx) (:plugin/generation ctx)])

(defn instance [ctx]
  (get-in @(:state ctx) [:instances (:plugin/id ctx)]))

(defn valid? [state ctx]
  (let [entry (get-in state [:instances (:plugin/id ctx)])]
    (and (= (:plugin/generation ctx) (:generation entry))
         (contains? #{:starting :active} (:phase entry)))))

(defn check! [state ctx]
  (when-not (valid? state ctx)
    (throw (ex-info "Plugin instance is stopping, stopped or superseded"
                    {:type :plugin/inactive :plugin (:plugin/id ctx)
                     :generation (:plugin/generation ctx)}))))

(defn visible? [state {:keys [owner generation]}]
  (let [entry (get-in state [:instances owner])]
    (and (= generation (:generation entry))
         (= :active (:phase entry)))))

(defn begin!
  [ctx id {:keys [phase] :or {phase :starting} :as options}]
  (let [next-state
        (swap! (:state ctx)
               (fn [state]
                 (let [old (get-in state [:instances id])]
                   (when (and (:resume-generation options)
                              (not (and (= (:resume-generation options) (:generation old))
                                        (= :stopped (:phase old)) (:desired? old)
                                        (= :complete (get-in old [:receipt :status])))))
                     (throw (ex-info "Plugin automatic recovery was superseded or disabled"
                                     {:type :plugin/recovery-cancelled :plugin id})))
                   (when (:closing? state)
                     (throw (ex-info "Plugin context is shutting down" {:type :plugin/closing})))
                   (when (or (contains? #{:starting :active :stopping} (:phase old))
                             (= :failed (get-in old [:receipt :status])))
                     (throw (ex-info "Plugin already loaded or its cleanup is incomplete"
                                     {:type :plugin/already-loaded :plugin id})))
                   (when (and (contains? options :requires)
                              (or (not= (set (:requires options)) (set (keys (:bindings options))))
                                  (not= (:bindings options) (bindings state (:requires options)))))
                     (throw (ex-info "Plugin dependencies changed before startup" {:type :plugin/dependencies-changed :plugin id})))
                   (assoc-in state [:instances id]
                             (merge options
                                    {:generation (inc (or (:generation old) 0))
                                     :phase phase :desired? true :calls 0
                                     :drained (promise) :effects [] :stoppers []})))))]
    (assoc ctx :plugin/id id :plugin/generation
           (get-in next-state [:instances id :generation]))))

(defn context [ctx id]
  (cond
    ;; Never upgrade a retained context to a newer instance implicitly.
    (and (= id (:plugin/id ctx)) (:plugin/generation ctx)) ctx
    :else
    (if-let [entry (get-in @(:state ctx) [:instances id])]
      (if (contains? #{:starting :active} (:phase entry))
        (assoc ctx :plugin/id id :plugin/generation (:generation entry))
        (throw (ex-info "Stopped plugin requires an explicit new lifecycle"
                        {:type :plugin/inactive :plugin id})))
      (begin! ctx id {:phase :active}))))

(defn active-call? [ctx]
  (= (.getId (Thread/currentThread)) (get *calls* (identity-key ctx))))

(defn current-call? [ctx]
  (or (active-call? ctx)
      (= (.getId (Thread/currentThread)) (get *cleanup* (identity-key ctx)))))

(defn inherited-call? [state ctx]
  (let [thread (.getId (Thread/currentThread))]
    (some (fn [[[owner-state id generation] caller-thread]]
            (let [entry (get-in state [:instances id])]
              (and (identical? owner-state (:state ctx)) (= thread caller-thread)
                   (= generation (:generation entry))
                   (contains? (get-in state [:instances (:plugin/id ctx) :stop-domain]) id)
                   (or (pos? (:calls entry 0)) (= thread (get *cleanup* [owner-state id generation])))
                   (some #(and (= (:plugin/id ctx) (:owner %))
                               (= (:plugin/generation ctx) (:generation %)))
                         (vals (:bindings entry)))))) (merge *calls* *cleanup*))))

(defn callable? [state ctx]
  (or (valid? state ctx)
      (and (= (:plugin/generation ctx) (get-in state [:instances (:plugin/id ctx) :generation]))
           (= :stopping (get-in state [:instances (:plugin/id ctx) :phase]))
           (or (active-call? ctx)
               (= (.getId (Thread/currentThread)) (get *cleanup* (identity-key ctx)))
               (inherited-call? state ctx)))))

(defn bound-service [ctx service-key]
  (let [state @(:state ctx) thread (.getId (Thread/currentThread))
        owners (merge *calls* *cleanup*)
        binding-for (fn [[owner-state id generation :as key]]
                      (when (and (identical? owner-state (:state ctx)) (= thread (get owners key))
                                 (= generation (get-in state [:instances id :generation])))
                        (get-in state [:instances id :bindings service-key])))]
    (or (binding-for (identity-key ctx))
        (some binding-for (reverse *call-stack*)))))

(defn with-call [ctx f]
  (let [key (identity-key ctx)
        reentrant? (or (active-call? ctx)
                       (= (.getId (Thread/currentThread)) (get *cleanup* key)))]
    (if reentrant?
      (f)
      (do
        (swap! (:state ctx)
               (fn [state]
                 (when-not (callable? state ctx) (check! state ctx))
                 (update-in state [:instances (:plugin/id ctx) :calls] inc)))
        (try
          (binding [*calls* (assoc *calls* key (.getId (Thread/currentThread)))
                    *call-stack* (conj *call-stack* key)] (f))
          (finally
            (let [state (swap! (:state ctx) update-in
                               [:instances (:plugin/id ctx) :calls] dec)
                  entry (get-in state [:instances (:plugin/id ctx)])]
              (when (and (= :stopping (:phase entry)) (zero? (:calls entry)))
                (deliver (:drained entry) true)))))))))

(defn inspection [f]
  (with-meta f (assoc (meta f) ::inspection true)))

(defn wrap-value [ctx value]
  (cond
    (fn? value) (with-meta (fn [& args]
                            (if (and (::inspection (meta value))
                                     (= :stopped (:phase (instance ctx))))
                              (apply value args)
                              (with-call ctx #(apply value args))))
                 (assoc (meta value) ::owner (identity-key ctx)))
    (map? value) (reduce-kv (fn [m k v] (assoc m k (wrap-value ctx v))) value value)
    :else value))

(defn once [dispose]
  (let [result (promise) claimed? (atom false)]
    (fn []
      (when (compare-and-set! claimed? false true)
        (try (deliver result {:value (dispose)})
             (catch Throwable error (deliver result {:error error}))))
      (let [{:keys [value error]} @result]
        (if error (throw error) value)))))

(defn commit!
  "Publish a registration and its cleanup in the same state transition."
  [ctx change dispose]
  (let [dispose (once dispose)]
    (swap! (:state ctx)
           (fn [state]
             (check! state ctx)
             (-> (change state)
                 (update-in [:instances (:plugin/id ctx) :effects] conj dispose))))
    dispose))

(defn await-cleanup [value]
  (when (instance? clojure.lang.IPending value)
    (recur @value)))

(defn track! [ctx dispose]
  (when-not (fn? dispose)
    (throw (ex-info "Plugin cleanup must be a function" {:type :plugin/invalid-effect})))
  (try
    ;; An admitted startup may finish after admission closes. Its returned
    ;; disposer still belongs to that generation and must join the drain barrier.
    (if (active-call? ctx)
      (let [dispose (once dispose)]
        (swap! (:state ctx)
               (fn [state]
                 (when-not (and (= (:plugin/generation ctx) (get-in state [:instances (:plugin/id ctx) :generation]))
                                (contains? #{:starting :active :stopping} (get-in state [:instances (:plugin/id ctx) :phase])))
                   (check! state ctx))
                 (update-in state [:instances (:plugin/id ctx) :effects] conj dispose)))
        dispose)
      (commit! ctx identity dispose))
    (catch Throwable error
      ;; Secondary registries allocate before handing us a disposer. Refusing
      ;; a late effect must still release that already-created resource.
      (let [id (str (random-uuid))
            _ (swap! (:state ctx) assoc-in [:late-cleanups id]
                     {:plugin (:plugin/id ctx) :generation (:plugin/generation ctx) :status :pending})
            cleanup (future
                      (let [result (try (await-cleanup (dispose)) {:status :complete}
                                        (catch Throwable cause {:status :failed :error (ex-message cause)}))]
                        (swap! (:state ctx) update-in [:late-cleanups id] merge result)
                        result))
            receipt (deref cleanup default-timeout-ms {:status :pending})]
        (throw (ex-info (ex-message error) (assoc (ex-data error) :cleanup receipt) error))))))

(defn track-stop! [ctx stop]
  (when-not (fn? stop) (throw (ex-info "Plugin stop signal must be a function" {})))
  (let [stop (once stop)
        state (swap! (:state ctx)
                     (fn [state]
                       (if (and (active-call? ctx) (= (:plugin/generation ctx) (get-in state [:instances (:plugin/id ctx) :generation]))
                                (= :stopping (get-in state [:instances (:plugin/id ctx) :phase])))
                         state
                         (do (check! state ctx)
                             (update-in state [:instances (:plugin/id ctx) :stoppers] conj stop)))))]
    ;; A startup already in flight must signal its late-created resources before
    ;; releasing its lease, even when the finalizer took its stopper snapshot.
    (when (= :stopping (get-in state [:instances (:plugin/id ctx) :phase]))
      (await-cleanup (stop))))
  nil)

(defn notify! [ctx]
  (when-let [reconcile @(:reconcile ctx)] (reconcile)))

(defn- cleanup-instance! [ctx completion]
  (let [errors (atom [])
        run (fn [f]
              (try (await-cleanup (f))
                   (catch Throwable error (swap! errors conj (ex-message error)))))
        entry (instance ctx)]
    ;; Admission has already closed. Stop signals must precede waiting for
    ;; admitted calls; ordinary effects/resources stay alive until they drain.
    (binding [*cleanup* (assoc *cleanup* (identity-key ctx) (.getId (Thread/currentThread)))
                *call-stack* (conj *call-stack* (identity-key ctx))]
      (doseq [stop (reverse (:stoppers entry))] (run stop)))
    @(:drained entry)
    (let [dependencies (mapv deref (:prerequisites entry))
          blocked? (some #(not= :complete (:status %)) dependencies)]
    (when-not blocked?
      (binding [*cleanup* (assoc *cleanup* (identity-key ctx) (.getId (Thread/currentThread)))
                *call-stack* (conj *call-stack* (identity-key ctx))]
        (doseq [dispose (reverse (:effects (instance ctx)))] (run dispose))))
    (let [receipt (cond-> {:plugin (:plugin/id ctx) :generation (:plugin/generation ctx)
                          :status (cond blocked? :blocked (seq @errors) :failed :else :complete)
                          :errors @errors}
                   blocked? (assoc :dependencies dependencies))]
      (swap! (:state ctx)
             (fn [state]
               (-> state
                   (assoc-in [:instances (:plugin/id ctx) :phase] (if blocked? :stopping :stopped))
                   (assoc-in [:instances (:plugin/id ctx) :receipt] receipt)
                   (cond-> (not blocked?)
                     (assoc-in [:instances (:plugin/id ctx) :effects] [])
                     (not blocked?)
                     (update :retired-services #(into {} (remove (fn [[_ item]]
                                                                 (and (= (:owner item) (:plugin/id ctx))
                                                                      (= (:generation item) (:plugin/generation ctx)))) %))))
                   (update :loaded #(vec (remove (fn [p] (= (:id p) (:plugin/id ctx))) %))))))
      (deliver completion receipt)
      (notify! ctx)))))

(defn dependency-domain [state root]
  (loop [affected #{root}]
    (let [next (into affected
                     (for [[id entry] (:instances state)
                           :when (and (or (contains? #{:starting :active :stopping} (:phase entry))
                                          (= :failed (get-in entry [:receipt :status])))
                                      (some #(contains? affected (:owner %)) (vals (:bindings entry))))] id))]
      (if (= affected next) affected (recur next)))))

(defn stop-many!
  "Stop a dependency domain atomically; all cancellation signals run before
  providers wait for consumer cleanup. The root receipt is bounded, not retried."
  [ctx id {:keys [timeout-ms preserve-desired? reason generation all?]
           :or {timeout-ms default-timeout-ms reason :explicit}}]
  (when-not (and (integer? timeout-ms) (<= 1 timeout-ms 60000))
    (throw (ex-info "Plugin shutdown timeout must be 1..60000 ms" {})))
  (let [[old state]
        (swap-vals! (:state ctx)
                    (fn [state]
                      (if (and generation (not= generation (get-in state [:instances id :generation])))
                        state
                        (let [ids (if all? (set (keys (:instances state))) (dependency-domain state id))
                              completions (into {} (map #(vector % (promise)) ids))
                              state (reduce
                                     (fn [state target]
                                       (if-let [entry (get-in state [:instances target])]
                                         (cond-> state
                                           (or all? (and (= target id) (not preserve-desired?)))
                                           (assoc-in [:instances target :desired?] false)
                                           (contains? #{:starting :active} (:phase entry))
                                           (update-in [:instances target] assoc
                                                      :phase :stopping :withdrawing? true
                                                      :stop-reason (if (= target id) reason :dependency-unavailable)
                                                      :completion (get completions target)
                                                      :stop-domain ids))
                                         state)) state ids)]
                          (reduce
                            (fn [state target]
                              (if (identical? (get completions target) (get-in state [:instances target :completion]))
                                (assoc-in state [:instances target :prerequisites]
                                          (vec (for [consumer ids :when (not= target consumer)
                                                     :let [entry (get-in state [:instances consumer])]
                                                     :when (some #(= target (:owner %)) (vals (:bindings entry)))]
                                                 (or (:completion entry) (doto (promise) (deliver (:receipt entry)))))))
                                state)) state ids)))))
        entry (get-in state [:instances id])
        ids (if all? (set (keys (:instances state))) (:stop-domain entry #{id}))
        stale? (and generation (not= generation (:generation entry)))]
    (when-not stale?
      (doseq [target ids
              :let [current (get-in state [:instances target])]
              :when (and current (contains? #{:starting :active} (get-in old [:instances target :phase])))]
        (when (zero? (:calls current)) (deliver (:drained current) true))
        (future (binding [*calls* {} *cleanup* {}]
                  (cleanup-instance! (assoc ctx :plugin/id target :plugin/generation (:generation current))
                                     (:completion current))))))
    (cond
      stale? {:plugin id :generation generation :status :complete :superseded true}
      (nil? entry) {:plugin id :status :complete :absent true}
      (= :stopped (:phase entry)) (:receipt entry)
      (some #(current-call? (assoc ctx :plugin/id % :plugin/generation
                                 (get-in state [:instances % :generation]))) ids)
      {:plugin id :generation (:generation entry) :status :pending :reason :in-flight-self}
      :else (deref (:completion entry) timeout-ms
                   {:plugin id :generation (:generation entry) :status :timeout
                    :phase :stopping :reason reason}))))

(defn bindings [state required]
  (into {}
        (for [key required
              :let [entry (get-in state [:services key])]
              :when (and entry (visible? state entry)
                         (not (get-in state [:instances (:owner entry) :withdrawing?]))
                         (= :active (get-in state [:instances (:owner entry) :phase])))]
          [key (select-keys entry [:owner :generation :entry-id])])))
