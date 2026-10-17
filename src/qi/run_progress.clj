(ns qi.run-progress
  "Bound unchanged reads and describe one nonexecuting diagnostic step."
  (:require [qi.kernel :as kernel]
            [qi.generation :as generation])
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

(defn- result-identity [result]
  (cond-> (select-keys result [:ok :is-error :value :details :images])
    (not (contains? result :value)) (assoc :content (:content result))))

(defn- diagnostic-plan [state uncertain?]
  {:schema-version 1 :automatic-execution false
   :call-ids (:call-ids state) :evidence (:evidence state)
   :evidence-gap (if uncertain? :external-result-unreconciled :no-new-observation)
   :budget {:run-id (:run-id generation/*run*) :root-run-id (:root-run-id generation/*run*)
            :requests-used (some-> (:requests generation/*run*) deref)
            :max-requests (:max-requests generation/*run*) :deadline-at-ms (:deadline generation/*run*)}
   :steps [{:action (if uncertain? :reconcile-current-state :inspect-different-evidence)
            :read-only true
            :suggestion (if uncertain?
                          "Read the current external state and reconcile the recorded action before any retry."
                          "Check one different source or revision against these unchanged result fingerprints.")} ]})

(defn observe!
  "Successful serial mutations reset progress; explicit polls keep their own cap.
  Eight batch fingerprints bound short read cycles. Diagnostics never dispatch."
  [ctx tracker executions config]
  (let [entries (mapv (fn [[call result]]
                       {:call call :result result
                        :tool (kernel/tool ctx (get-in call [:function :name]))}) executions)
        uncertain? (boolean (some #(or (true? (get-in % [:result :details :uncertain]))
                                      (true? (get-in % [:result :uncertain]))) entries))
        mutation? (some #(and (= :sequential (get-in % [:tool :execution-mode]))
                              (true? (get-in % [:result :ok]))) entries)
        polling? (every? #(and (= :poll (get-in % [:tool :progress-mode]))
                              (true? (get-in % [:result :ok]))) entries)]
    (if (and mutation? (not uncertain?))
      (reset! tracker nil)
      (let [digest (fingerprint
                    (mapv (fn [{:keys [call result]}]
                            [(get-in call [:function :name])
                             (or (get-in result [:execution :arguments]) (get-in call [:function :arguments]))
                             (result-identity result)]) entries))
            evidence (mapv (fn [{:keys [call result]}]
                             {:call-id (:id call) :tool (get-in call [:function :name])
                              :result-fingerprint (fingerprint (result-identity result))}) entries)
            limit (if polling? (or (:max-stalled-polls config) 32)
                      (or (:max-repeated-tool-results config) 3))
            next (swap! tracker
                        (fn [old]
                          (let [history (vec (take-last 8 (conj (:history old [])
                                                               {:fingerprint digest :polling polling? :evidence evidence})))
                                consecutive (if (= digest (:fingerprint old)) (inc (:consecutive old 0)) 1)
                                repetitions (if polling? consecutive
                                              (count (filter #(and (not (:polling %)) (= digest (:fingerprint %))) history)))
                                recent (vec (take-last 3 (mapcat :evidence history)))]
                            {:fingerprint digest :consecutive consecutive :repetitions repetitions :history history
                             :evidence recent :call-ids (mapv :call-id recent)})))]
        (when (or uncertain? (>= (:repetitions next) limit))
          (let [state (-> next (dissoc :history :consecutive)
                          (assoc :limit limit :polling polling?
                                 :kind (cond uncertain? :uncertain-action
                                             (< (:consecutive next) (:repetitions next)) :read-cycle
                                             :else :unchanged)))]
            (throw (ex-info "Agent stopped without new evidence; inspect the diagnostic plan"
                            {:reason :no-progress :retryable false :no-progress state
                             :diagnostic-plan (diagnostic-plan state uncertain?)}))))))))
