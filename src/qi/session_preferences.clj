(ns qi.session-preferences
  "Durable, session-local presentation preferences; never permissions.")

(def response-details #{"short" "auto" "detailed"})

(defn selected-detail [events]
  (some (fn [event]
          (when (contains? #{"session/preferences" :session/preferences} (:type event))
            (let [value (get-in event [:data :response_detail])]
              (when (contains? response-details value) value))))
        (reverse events)))

(defn snapshot [events]
  {:response_detail (or (selected-detail events) "auto")})
