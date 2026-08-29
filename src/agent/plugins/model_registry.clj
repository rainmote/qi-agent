(ns agent.plugins.model-registry
  "Runtime provider/model catalog and selector."
  (:require [agent.kernel :as kernel]))

(defn- normalize-thinking-level [level]
  (cond
    (keyword? level) level
    (string? level) (keyword level)
    :else nil))

(defn- thinking-levels [entry]
  (mapv normalize-thinking-level (or (:thinking-levels entry) [])))

(defn- default-thinking-level [entry]
  (let [levels (thinking-levels entry)
        configured (normalize-thinking-level (:default-thinking-level entry))]
    (cond
      (and configured (some #{configured} levels)) configured
      (seq levels) (last levels)
      :else nil)))

(defn- with-thinking-level [entry selected-thinking]
  (when entry
    (if-let [level (get selected-thinking (:id entry))]
      (assoc entry :thinking-level level)
      entry)))

(defn- thinking-options [entry level]
  (cond
    (nil? level) {}

    (= :openai-compatible (:provider entry))
    (if (= :off level)
      {:thinking {:type "disabled"}}
      {:thinking {:type "enabled"}
       :reasoning_effort (name level)})

    (contains? #{:openai :chatgpt-subscription} (:provider entry))
    {:reasoning {:effort (name level)}}

    :else {}))

(def plugin
  {:id :llm/model-registry
   :description "Multiple provider/model registrations with runtime selection."
   :provides #{:llm/registry :llm/generate}
   :start
   (fn [ctx {:keys [default-provider]}]
     (let [providers (atom {})
           selected (atom default-provider)
           selected-thinking (atom {})
           upsert!
           (fn [{:keys [id generate] :as entry}]
             (when-not (and (keyword? id) (fn? generate))
               (throw (ex-info "Provider entry requires keyword :id and :generate"
                               {:entry (dissoc entry :generate)})))
             (let [previous (get @providers id)
                   previous-thinking (get @selected-thinking id ::missing)
                   supported (set (thinking-levels entry))
                   retained (get @selected-thinking id)
                   next-thinking (if (contains? supported retained)
                                   retained
                                   (default-thinking-level entry))]
               (swap! providers assoc id entry)
               (if next-thinking
                 (swap! selected-thinking assoc id next-thinking)
                 (swap! selected-thinking dissoc id))
               (compare-and-set! selected nil id)
               (fn []
                 (if previous
                   (do
                     (swap! providers assoc id previous)
                     (if (= ::missing previous-thinking)
                       (swap! selected-thinking dissoc id)
                       (swap! selected-thinking assoc id previous-thinking)))
                   (do
                     (swap! providers dissoc id)
                     (swap! selected-thinking dissoc id)
                     (when (= id @selected)
                       (reset! selected (first (keys @providers)))))))))
           register!
           (fn [{:keys [id generate] :as entry}]
             (when-not (and (keyword? id) (fn? generate))
               (throw (ex-info "Provider entry requires keyword :id and :generate"
                               {:entry (dissoc entry :generate)})))
             (when (contains? @providers id)
               (throw (ex-info "Provider is already registered" {:id id})))
             (swap! providers assoc id entry)
             (when-let [level (default-thinking-level entry)]
               (swap! selected-thinking assoc id level))
             (compare-and-set! selected nil id)
             (fn []
               (swap! providers dissoc id)
               (swap! selected-thinking dissoc id)
               (when (= id @selected)
                 (reset! selected (first (keys @providers))))))
           select!
           (fn [id]
             (when-not (contains? @providers id)
               (throw (ex-info "Provider is not registered"
                               {:provider id
                                :available (set (keys @providers))})))
             (reset! selected id)
             (kernel/emit! ctx :llm/model-selected
                           {:provider id :model (:model (get @providers id))})
             (with-thinking-level (get @providers id) @selected-thinking))
           select-thinking!
           (fn [level]
             (let [id @selected
                   entry (get @providers id)
                   normalized (normalize-thinking-level level)
                   available (set (thinking-levels entry))]
               (when-not entry
                 (throw (ex-info "No selected LLM provider is available" {})))
               (when-not (contains? available normalized)
                 (throw (ex-info "Thinking level is not supported"
                                 {:provider id
                                  :level normalized
                                  :available available})))
               (swap! selected-thinking assoc id normalized)
               (kernel/emit! ctx :llm/thinking-level-selected
                             {:provider id :level normalized})
               (with-thinking-level entry @selected-thinking)))
           current (fn []
                     (with-thinking-level (get @providers @selected)
                                          @selected-thinking))
           generate
           (fn [request]
             (let [requested (or (get-in request [:options :provider]) @selected)
                   entry (get @providers requested)
                   level (get @selected-thinking requested)]
               (when-not entry
                 (throw (ex-info "No selected LLM provider is available"
                                 {:selected requested
                                  :available (set (keys @providers))})))
               ((:generate entry)
                (update request :options
                        (fn [options]
                          (-> (merge (thinking-options entry level)
                                     (or options {}))
                              (dissoc :provider)))))))
           registry
           {:register! register!
            :upsert! upsert!
            :select! select!
            :select-thinking! select-thinking!
            :current current
            :providers (fn []
                         (->> @providers vals
                              (mapv #(some-> (with-thinking-level %
                                                                  @selected-thinking)
                                            (dissoc :generate)))))
            :generate generate}]
       (kernel/register-service! ctx :llm/registry registry)
       (kernel/register-service! ctx :llm/generate generate))
     nil)})
