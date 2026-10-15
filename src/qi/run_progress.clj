(ns qi.run-progress
  "Bound consecutive unchanged read batches without replaying any operation."
  (:require [qi.kernel :as kernel])
  (:import [java.security MessageDigest]))

(defn- canonical [value]
  (cond
    (map? value) (into (sorted-map-by #(compare (pr-str %1) (pr-str %2)))
                       (map (fn [[k v]] [k (canonical v)])) value)
    (set? value) (sort-by pr-str (map canonical value))
    (sequential? value) (mapv canonical value)
    :else value))

(defn- fingerprint [value]
  (let [bytes (.digest (MessageDigest/getInstance "SHA-256")
                       (.getBytes (pr-str (canonical value)) "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and % 255)) bytes))))

(defn observe!
  "Successful serial mutations are progress; explicit polls have a separate cap.
  Call IDs/timing/execution tokens never affect a read result's identity."
  [ctx tracker executions config]
  (let [entries (mapv (fn [[call result]]
                        {:call call :result result
                         :tool (kernel/tool ctx (get-in call [:function :name]))}) executions)
        mutation? (some #(and (= :sequential (get-in % [:tool :execution-mode]))
                              (true? (get-in % [:result :ok]))) entries)
        polling? (every? #(and (= :poll (get-in % [:tool :progress-mode]))
                              (true? (get-in % [:result :ok]))) entries)]
    (if mutation?
      (reset! tracker nil)
      (let [digest (fingerprint
                    (mapv (fn [{:keys [call result]}]
                            [(get-in call [:function :name])
                             (or (get-in result [:execution :arguments])
                                 (get-in call [:function :arguments]))
                             (cond-> (select-keys result [:ok :is-error :value :details :images])
                               (not (contains? result :value)) (assoc :content (:content result)))]) entries))
            limit (if polling? (or (:max-stalled-polls config) 32)
                      (or (:max-repeated-tool-results config) 3))
            next (swap! tracker
                        (fn [old]
                          {:fingerprint digest
                           :repetitions (if (= digest (:fingerprint old)) (inc (:repetitions old)) 1)
                           :call-ids (vec (take-last 3 (concat (when (= digest (:fingerprint old)) (:call-ids old))
                                                            (map (comp :id :call) entries))))}))]
        (when (>= (:repetitions next) limit)
          (throw (ex-info "Agent stopped after repeated unchanged tool results"
                          {:reason :no-progress :retryable false
                           :no-progress (assoc next :limit limit :polling polling?)})))))))
