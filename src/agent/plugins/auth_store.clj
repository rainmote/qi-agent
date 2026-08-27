(ns agent.plugins.auth-store
  "Dynamic credential resolver registry; secrets are resolved per request."
  (:require [agent.kernel :as kernel]))

(def plugin
  {:id :auth/store
   :description "Provider credential resolver lifecycle without secret caching."
   :provides #{:auth/store}
   :start
   (fn [ctx _config]
     (let [resolvers (atom {})
           upsert!
           (fn [id resolver metadata]
             (when-not (and (keyword? id) (fn? resolver))
               (throw (ex-info "Auth resolver requires keyword id and function"
                               {:id id})))
             (let [previous (get @resolvers id)]
               (swap! resolvers assoc id {:resolve resolver
                                          :metadata metadata})
               (fn []
                 (if previous
                   (swap! resolvers assoc id previous)
                   (swap! resolvers dissoc id)))))
           register!
           (fn [id resolver metadata]
             (when-not (and (keyword? id) (fn? resolver))
               (throw (ex-info "Auth resolver requires keyword id and function"
                               {:id id})))
             (when (contains? @resolvers id)
               (throw (ex-info "Auth resolver already exists" {:id id})))
             (swap! resolvers assoc id {:resolve resolver
                                        :metadata metadata})
             (fn [] (swap! resolvers dissoc id)))
           resolve! (fn [id]
                      (if-let [resolver (get @resolvers id)]
                        ((:resolve resolver))
                        (throw (ex-info "Auth resolver is unavailable"
                                        {:id id}))))]
       (kernel/register-service!
        ctx :auth/store
        {:register! register!
         :upsert! upsert!
         :resolve! resolve!
         :providers (fn []
                      (mapv (fn [[id entry]]
                              (assoc (:metadata entry) :id id))
                            @resolvers))}))
     nil)})
