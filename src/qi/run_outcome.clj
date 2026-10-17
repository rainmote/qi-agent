(ns qi.run-outcome
  "Terminal outcomes shared by the agent, child providers, and workflows.
  Completion describes execution only; verification requires separate evidence.")

(defn- as-keyword [value]
  (if (string? value) (keyword value) value))

(defn normalize [value]
  (let [result (if (map? value) value {:error "Provider returned an invalid run result"})
        status (as-keyword (:status result))
        stop (as-keyword (:stop-reason result))
        status (cond
                 (or (:cancelled result) (= :cancelled status)
                     (contains? #{:aborted :cancelled} stop)) :cancelled
                 (or (:error result) (false? (:ok result)) (:is-error result)
                     (= :failed status) (:terminated result)
                     (contains? #{:error :failed :length :max_tokens} stop)) :failed
                 (or (= :uncertain status) (contains? #{:restored :unknown} stop)) :uncertain
                 (and stop (not= :completed stop)) :uncertain
                 (and status (not= :completed status)) :uncertain
                 (or (= :completed stop) (= :completed status)) :completed
                 :else :uncertain)
        reason (or (when (= :cancelled status)
                     (if (= :stopped (as-keyword (:reason result))) :stopped :cancelled))
                   (when-not (and (not= :completed status)
                                 (= :completed (as-keyword (:reason result))))
                     (as-keyword (:reason result)))
                   (case status
                     :completed :completed
                     :cancelled :cancelled
                     :failed (if (:terminated result) :tool-terminated :provider-error)
                     :uncertain (if (= :restored stop) :restored :unknown)))]
    (assoc result :status status :reason reason
           ;; Keep the legacy stop-reason contract for existing clients.
           :stop-reason (case status :completed :completed :cancelled :aborted
                              :failed :error :uncertain :restored)
           :verification (or (:verification result) :not-run))))

(defn successful? [result]
  (= :completed (:status (normalize result))))

(defn host-deadline-outcomes
  "Correct terminals from an expired older worker generation in this session.
  The host's private receipt is authoritative only for its bound identities."
  [receipt {:keys [worker-id generation session-id]} events]
  (let [receipt-generation (:generation receipt)
        starts (set (keep #(when (= "agent/run/start" (:type %)) (get-in % [:data :run-id])) events))
        corrected (set (keep #(when (and (= "agent/run/end" (:type %))
                                         (contains? #{:hard-wall-timeout "hard-wall-timeout"} (get-in % [:data :reason]))
                                         (= receipt-generation (get-in % [:data :host-generation])))
                                (get-in % [:data :run-id])) events))]
    (if (and (= 1 (:schema_version receipt)) (= "hard-wall-timeout" (:reason receipt))
             (= worker-id (:worker_id receipt)) (string? worker-id)
             (integer? generation) (integer? receipt-generation) (< receipt-generation generation))
      (->> (:runs receipt)
           (filter #(and (= session-id (:session_id %)) (string? (:run_id %))
                         (contains? starts (:run_id %)) (not (contains? corrected (:run_id %)))))
           (mapv (fn [run]
                   (assoc (normalize {:status :uncertain :reason :hard-wall-timeout})
                          :run-id (:run_id run) :usage nil :steps nil
                          :host-worker-id worker-id :host-generation receipt-generation
                          :host-arbitrated true :deadline-at-ms (:deadline_at_ms run)))))
      [])))

(defn from-error [error]
  (normalize (merge (select-keys (ex-data error)
                                [:run-id :reason :cancelled :usage :steps :code :no-progress :diagnostic-plan])
                    {:status :failed :error (ex-message error)})))

(defn complete-response?
  "Nil is supported for legacy providers; an explicit nonterminal finish is not."
  [response]
  (and (not (:error response))
       (contains? #{nil :completed} (as-keyword (:status response)))
       (contains? #{nil "stop" "end_turn" "stop_sequence" "completed"}
                  (some-> (:finish-reason response) name))))
