(ns qi.plugins.remote-registry
  "Declarative, schema-validated RPC method registry for local and remote UIs."
  (:require [qi.kernel :as kernel]
            [qi.schema :as schema]
            [clojure.string :as str]))

(defn- public-method [entry]
  (dissoc entry :handler :result-schema))

(def plugin
  {:id :remote/registry
   :description "Schema-validated, reversible remote method registry."
   :provides #{:remote/registry}
   :start
   (fn [ctx _]
     (let [methods (atom {})
           register!
           (fn [{:keys [method description params-schema result-schema handler]
                :as entry}]
             (when-not (and (string? method) (not (str/blank? method))
                            (string? description)
                            (map? params-schema) (map? result-schema)
                            (fn? handler))
               (throw (ex-info "Invalid remote method definition"
                               {:method method})))
             (when (contains? @methods method)
               (throw (ex-info "Remote method is already registered"
                               {:method method})))
             (swap! methods assoc method entry)
             (let [active? (atom true)]
               (fn []
                 (when (compare-and-set! active? true false)
                   (swap! methods dissoc method)))))
           invoke!
           (fn [method params]
             (let [entry (get @methods method)]
               (when-not entry
                 (throw (ex-info "Unknown RPC method" {:method method})))
               (let [params (or params {})]
                 (schema/validate! (:params-schema entry) params
                                   "Invalid remote method parameters")
                 (let [result ((:handler entry) params)]
                   (schema/validate! (:result-schema entry) result
                                     "Invalid remote method result")
                   result))))
           service
           {:register! register!
            :invoke! invoke!
            :method #(some-> (get @methods %) public-method)
            :methods #(->> @methods vals (map public-method)
                           (sort-by :method) vec)}]
       (kernel/register-service! ctx :remote/registry service))
     nil)})
