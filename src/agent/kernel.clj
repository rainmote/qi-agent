(ns agent.kernel
  "Small plugin host. It owns registries and reversible effects, but no agent policy."
  (:require [clojure.string :as str]))

(defn create-context []
  {:state (atom {:services {}
                 :tools {}
                 :commands {}
                 :hooks {}
                 :effects {}
                 :loaded []
                 :sequence 0})})

(defn plugin-context [ctx plugin-id]
  (assoc ctx :plugin/id plugin-id))

(defn- owner! [ctx]
  (or (:plugin/id ctx)
      (throw (ex-info "Registration requires a plugin context" {}))))

(defn- next-sequence! [ctx]
  (:sequence (swap! (:state ctx) update :sequence inc)))

(defn track-effect!
  "Track a disposer under the active plugin. Effects unwind in reverse order."
  [ctx dispose]
  (let [owner (owner! ctx)
        active? (atom true)
        wrapped (fn []
                  (when (compare-and-set! active? true false)
                    (dispose)))]
    (swap! (:state ctx) update-in [:effects owner] (fnil conj []) wrapped)
    wrapped))

(defn register-service!
  "Register a single-owner service and return an idempotent disposer."
  [ctx service-key value]
  (let [owner (owner! ctx)]
    (swap! (:state ctx)
           (fn [state]
             (if-let [existing (get-in state [:services service-key])]
               (throw (ex-info (str "Service already registered: " service-key)
                               {:service service-key
                                :owner (:owner existing)}))
               (assoc-in state [:services service-key]
                         {:owner owner :value value}))))
    (track-effect!
     ctx
     #(swap! (:state ctx)
             (fn [state]
               (if (= owner (get-in state [:services service-key :owner]))
                 (update state :services dissoc service-key)
                 state))))))

(defn service [ctx service-key]
  (get-in @(:state ctx) [:services service-key :value]))

(defn require-service [ctx service-key]
  (or (service ctx service-key)
      (throw (ex-info (str "Required service is unavailable: " service-key)
                      {:service service-key}))))

(defn service-keys [ctx]
  (set (keys (:services @(:state ctx)))))

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
    (swap! (:state ctx)
           (fn [state]
             (if-let [existing (get-in state [:tools name])]
               (throw (ex-info (str "Tool already registered: " name)
                               {:tool name :owner (:owner existing)}))
               (assoc-in state [:tools name]
                         {:owner owner :definition tool}))))
    (track-effect!
     ctx
     #(swap! (:state ctx)
             (fn [state]
               (if (= owner (get-in state [:tools name :owner]))
                 (update state :tools dissoc name)
                 state))))))

(defn tool [ctx tool-name]
  (get-in @(:state ctx) [:tools tool-name :definition]))

(defn tools [ctx]
  (->> (:tools @(:state ctx))
       vals
       (map :definition)
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
    (swap! (:state ctx)
           (fn [state]
             (if-let [existing (get-in state [:commands name])]
               (throw (ex-info (str "Command already registered: " name)
                               {:command name :owner (:owner existing)}))
               (assoc-in state [:commands name]
                         {:owner owner :definition command}))))
    (track-effect!
     ctx
     #(swap! (:state ctx)
             (fn [state]
               (if (= owner (get-in state [:commands name :owner]))
                 (update state :commands dissoc name)
                 state))))))

(defn command [ctx name]
  (get-in @(:state ctx) [:commands name :definition]))

(defn commands [ctx]
  (->> (:commands @(:state ctx)) vals (map :definition)
       (sort-by :name) vec))

(defn- register-listener! [ctx event kind priority handler]
  (let [owner (owner! ctx)
        id (str (random-uuid))
        entry {:id id
               :owner owner
               :kind kind
               :priority priority
               :sequence (next-sequence! ctx)
               :handler handler}]
    (when-not (fn? handler)
      (throw (ex-info "Listener must be a function" {:event event})))
    (swap! (:state ctx) update-in [:hooks event] (fnil conj []) entry)
    (track-effect!
     ctx
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
  (->> (get-in @(:state ctx) [:hooks event] [])
       (filter (comp #{kind} :kind))
       (sort-by (juxt :priority :sequence))
       vec))

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
  "Unwind one plugin's effects in reverse registration order."
  [ctx plugin-id]
  (doseq [dispose (reverse (get-in @(:state ctx) [:effects plugin-id] []))]
    (try
      (dispose)
      (catch Throwable error
        (binding [*out* *err*]
          (println (str "dispose " plugin-id " failed: " (ex-message error)))))))
  (swap! (:state ctx)
         (fn [state]
           (-> state
               (update :effects dissoc plugin-id)
               (update :loaded #(vec (remove (comp #{plugin-id} :id) %))))))
  nil)

(defn mark-loaded! [ctx metadata]
  (swap! (:state ctx) update :loaded conj metadata)
  metadata)

(defn loaded-plugins [ctx]
  (:loaded @(:state ctx)))

(defn runtime-snapshot
  "Return deterministic, read-only runtime metadata for inspection.

  Service values, handlers, disposers, and executable functions are excluded."
  [ctx]
  (let [{:keys [commands hooks loaded services tools]} @(:state ctx)
        public-definition
        (fn [[name {:keys [owner definition]}]]
          (cond-> {:name (str name)
                   :owner (str owner)}
            (:description definition)
            (assoc :description (:description definition))))]
    {:plugins (->> loaded
                   (map #(select-keys % [:id :namespace :description]))
                   (map #(update % :id str))
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
  (doseq [plugin-id (reverse (map :id (loaded-plugins ctx)))]
    (dispose-plugin! ctx plugin-id))
  nil)
