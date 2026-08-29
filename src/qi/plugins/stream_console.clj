(ns qi.plugins.stream-console
  "Render normalized LLM text deltas as they arrive."
  (:require [qi.kernel :as kernel]))

(def plugin
  {:id :output/stream-console
   :description "Immediate console rendering for normalized text deltas."
   :provides #{:output/streaming}
   :start
   (fn [ctx {:keys [enabled] :or {enabled true}}]
     (let [printed? (atom false)
           response-open? (atom false)
           service {:printed? (fn [] @printed?)
                    :reset! (fn []
                              (reset! printed? false)
                              (reset! response-open? false))}]
       (kernel/register-service! ctx :output/streaming service)
       (when enabled
         (kernel/on!
          ctx :llm/stream
          (fn [_ event]
            (cond
              (= :text/delta (:type event))
              (when-let [delta (:delta event)]
                (when-not (empty? delta)
                  (print delta)
                  (flush)
                  (reset! printed? true)
                  (reset! response-open? true)))

              (contains? #{:response/completed :response/error}
                         (:type event))
              (when (compare-and-set! response-open? true false)
                (println)
                (flush))

              :else nil))))
       nil))})
