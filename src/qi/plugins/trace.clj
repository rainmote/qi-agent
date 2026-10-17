(ns qi.plugins.trace
  (:require [qi.kernel :as kernel]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- limited [value max-chars]
  (let [text (str value)]
    (str (subs text 0 (min max-chars (count text)))
         (when (> (count text) max-chars) "\n[trace truncated]"))))

(defn- render-arguments [arguments max-chars]
  (limited
   (if (map? arguments)
     (json/generate-string arguments)
     (pr-str arguments))
   max-chars))

(defn- print-event! [{:keys [show-results show-steps max-content-chars]}
                     {:keys [type data]}]
  (case type
    "tool/call"
    (println (str "→ tool " (:name data) " "
                  (render-arguments (:arguments data) max-content-chars)))

    "tool/result"
    (do
      (println (str "← tool " (:name data) " "
                    (if (:ok data) "ok" "error")))
      (when (and show-results (not (str/blank? (:content data))))
        (println (limited (:content data) max-content-chars))))

    "step/start"
    (when show-steps (println (str "· step " (:step data))))

    "approval/decision"
    (println (str "? approval " (:tool data) " "
                  (name (:decision data))))

    nil))

(def plugin
  {:id :telemetry/console
   :description "Contained session-event tracing."
   :start
   (fn [ctx {:keys [enabled show-results show-steps max-content-chars]
             :or {enabled false
                  show-results true
                  show-steps false
                  max-content-chars 4000}}]
     (when enabled
       (when-not (pos-int? max-content-chars)
         (throw (ex-info ":max-content-chars must be a positive integer"
                         {:max-content-chars max-content-chars})))
       (kernel/on!
        ctx :session/event
        (fn [_ event]
          (binding [*out* *err*]
            (print-event! {:show-results show-results
                           :show-steps show-steps
                           :max-content-chars max-content-chars}
                          event)))))
     nil)})
