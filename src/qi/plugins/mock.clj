(ns qi.plugins.mock
  "Deterministic offline provider used by examples and tests."
  (:require [qi.kernel :as kernel]))

(def plugin
  {:id :llm/mock
   :description "Deterministic response queue for offline verification."
   :provides #{:llm/generate}
   :start
   (fn [ctx {:keys [responses generate] :as config}]
     (let [queue (atom (vec responses))]
       (let [generator
             (fn [request]
               (if generate
                 (generate request)
                 (let [response (first @queue)]
                   (when-not response
                     (throw (ex-info "Mock provider response queue is empty" {})))
                   (swap! queue subvec 1)
                   response)))]
         (if-let [registry (kernel/service ctx :llm/registry)]
           (kernel/track-effect!
            ctx
            ((:register! registry)
             {:id (or (:provider-id config) :mock)
              :provider :mock
              :model (or (:model config) "mock")
              :context-window (:context-window config)
              :input-modalities #{:text}
              :generate (kernel/wrap-plugin-value ctx generator)}))
           (kernel/register-service! ctx :llm/generate generator)))
       nil))})
