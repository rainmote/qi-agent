(ns agent.plugins.model-registry
  "Runtime provider/model catalog and selector."
  (:require [agent.kernel :as kernel]))

(def plugin
  {:id :llm/model-registry
   :description "Multiple provider/model registrations with runtime selection."
   :provides #{:llm/registry :llm/generate}
   :start
   (fn [ctx {:keys [default-provider]}]
     (let [providers (atom {})
           selected (atom default-provider)
           upsert!
           (fn [{:keys [id generate] :as entry}]
             (when-not (and (keyword? id) (fn? generate))
               (throw (ex-info "Provider entry requires keyword :id and :generate"
                               {:entry (dissoc entry :generate)})))
             (let [previous (get @providers id)]
               (swap! providers assoc id entry)
               (compare-and-set! selected nil id)
               (fn []
                 (if previous
                   (swap! providers assoc id previous)
                   (do
                     (swap! providers dissoc id)
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
             (compare-and-set! selected nil id)
             (fn []
               (swap! providers dissoc id)
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
             (get @providers id))
           current (fn [] (get @providers @selected))
           generate
           (fn [request]
             (let [requested (or (get-in request [:options :provider]) @selected)
                   entry (get @providers requested)]
               (when-not entry
                 (throw (ex-info "No selected LLM provider is available"
                                 {:selected requested
                                  :available (set (keys @providers))})))
               ((:generate entry) (update request :options dissoc :provider))))
           registry
           {:register! register!
            :upsert! upsert!
            :select! select!
            :current current
            :providers (fn []
                         (->> @providers vals
                              (mapv (fn [entry]
                                      (dissoc entry :generate)))))
            :generate generate}]
       (kernel/register-service! ctx :llm/registry registry)
       (kernel/register-service! ctx :llm/generate generate))
     nil)})
