(ns qi.tool-recovery
  "Pure, append-only plans for interrupted native tool batches. Never dispatches."
  (:require [clojure.string :as str]))

(def scope-keys [:session_id :run-id :step :assistant-event-id])
(defn- kind [value] (if (keyword? value) (subs (str value) 1) value))
(defn- fail! [reason]
  (throw (ex-info "Interrupted tool context requires reconciliation"
                  {:code :tool_recovery_ambiguous :reason reason :retryable false})))

(defn- scope-events [events session-id]
  (reduce
   (fn [{:keys [owner run step closed] :as state} event]
     (let [type (kind (:type event)) data (:data event)
           owner (if (contains? #{"session/start" "session/fork"} type) (:session_id data) owner)
           run (cond (= "session/fork" type) nil (= "agent/run/start" type) (:run-id data) :else run)
           step (cond (contains? #{"session/fork" "agent/run/start"} type) nil
                      (= "step/start" type) (:step data) :else step)
           scope {:session_id owner :run-id run :step step}
           event (assoc event :type type :scope scope
                        :scope-conflict? (boolean (some #(and (contains? data %) (not= (get data %) (get scope %)))
                                                       [:session_id :run-id :step])))
           identity [owner (:run-id data)]]
       (cond-> (-> state (assoc :owner owner :run run :step step) (update :events conj event))
         (and (= "agent/run/start" type) (not (contains? closed identity)))
         (assoc-in [:pending identity] data)
         (= "agent/run/end" type) (update :pending dissoc identity)
         (= "agent/run/end" type) (update :closed conj identity))))
   {:owner session-id :run nil :step nil :closed #{} :pending {} :events []} events))

(defn pending-runs [events session-id]
  (into {} (filter #(= session-id (first (key %)))
                   (:pending (scope-events events session-id)))))

(defn- active-messages [events]
  (reduce (fn [messages event]
            (case (:type event)
              "message" (conj messages {:message (get-in event [:data :message]) :event event})
              "session/clear" []
              "session/compaction"
              (mapv (fn [message]
                      ;; A checkpoint retains exact messages. Reuse provenance only
                      ;; when that message has exactly one source in its snapshot.
                      (let [matches (filter #(= message (:message %)) messages)]
                        (if (= 1 (count matches)) (first matches) {:message message})))
                    (get-in event [:data :replacement_messages]))
              messages)) [] events))

(defn- verify-pair! [assistant result]
  (let [a (:event assistant) r (:event result) data (:data r)]
    (when (or (:scope-conflict? a) (:scope-conflict? r)
              (not= (:scope a) (:scope r))
              (and (:assistant-event-id data) (not= (:id a) (:assistant-event-id data)))
              (and (:call-id data) (not= (:call-id data) (get-in result [:message :tool_call_id]))))
      (fail! :conflicting-tool-message-ownership))))

(defn- dangling-batch [messages]
  (reduce
   (fn [batch {:keys [message] :as item}]
     (let [calls (:tool_calls message)]
       (cond
         (seq calls)
         (do
           (when batch (fail! :non-tail-tool-batch))
           (when (get-in item [:event :scope-conflict?]) (fail! :conflicting-tool-message-ownership))
           (when-not (and (= "assistant" (:role message))
                          (every? #(and (string? (:id %)) (not (str/blank? (:id %)))) calls)
                          (= (count calls) (count (set (map :id calls)))))
             (fail! :ambiguous-tool-identities))
           {:assistant item :calls (vec calls) :results [] :seen #{}})

         (= "tool" (:role message))
         (let [id (:tool_call_id message)]
           (when-not (and batch (some #(= id (:id %)) (:calls batch))
                          (not (contains? (:seen batch) id)))
             (fail! :unpaired-tool-message))
           (verify-pair! (:assistant batch) item)
           (let [next (-> batch (update :results conj item) (update :seen conj id))]
             (when (< (count (:seen next)) (count (:calls next))) next)))

         batch (fail! :non-tail-tool-batch)
         :else nil))) nil messages))

(defn recovery-plan
  "Repair only an open current-session tail. Closed, forked or ambiguous context
  is not rewritten. A missing start proves non-dispatch only for versioned logs."
  [events {:keys [session-id diagnostics]}]
  (let [{scoped :events pending :pending} (scope-events events session-id)
        batch (dangling-batch (active-messages scoped))
        pending (into {} (filter #(= session-id (first (key %))) pending))]
    {:pending-runs pending
     :repairs
     (if-not batch []
       (let [assistant (get-in batch [:assistant :event])
             scope (assoc (:scope assistant) :assistant-event-id (:id assistant))
             ids (mapv :id (:calls batch))
             seen (mapv #(get-in % [:message :tool_call_id]) (:results batch))]
         (when-not (and assistant (not (:scope-conflict? assistant))
                        (= session-id (:session_id scope))
                        (string? (:run-id scope)) (pos-int? (:step scope))
                        (contains? pending [session-id (:run-id scope)]))
           (fail! :unowned-or-closed-tool-batch))
         (when-not (= seen (subvec ids 0 (count seen))) (fail! :non-prefix-tool-results))
         (when-not (= 1 (count (filter #(and (= "message" (:type %))
                                             (= (:scope assistant) (:scope %))
                                             (seq (get-in % [:data :message :tool_calls]))) scoped)))
           (fail! :ambiguous-tool-step))
         (mapv
          (fn [call]
            (let [facts (filter #(and (= (:scope assistant) (:scope %))
                                     (= (:id call) (get-in % [:data :call-id]))
                                     (contains? #{"tool/start" "tool/result"} (:type %))) scoped)
                  _ (when (some #(or (<= (:seq %) (:seq assistant))
                                     (:scope-conflict? %)
                                     (and (get-in % [:data :name])
                                          (not= (get-in call [:function :name]) (get-in % [:data :name])))
                                     (and (get-in % [:data :assistant-event-id])
                                          (not= (:id assistant) (get-in % [:data :assistant-event-id])))) facts)
                      (fail! :conflicting-tool-ownership))
                  results (filter #(= "tool/result" (:type %)) facts)
                  _ (when (> (count (set (map :data results))) 1) (fail! :conflicting-tool-results))
                  result-event (first results)
                  _ (when (and result-event (not (contains? (:data result-event) :content)))
                      (fail! :missing-durable-result-content))
                  known-not-started? (and (= 1 (get-in assistant [:data :tool-dispatch-version]))
                                          (empty? diagnostics)
                                          (not-any? #(= "tool/start" (:type %)) facts))
                  execution-state (if known-not-started? :not-started :unknown)
                  data (or (:data result-event)
                           (merge scope
                                  {:call-id (:id call) :name (get-in call [:function :name])
                                   :status execution-state :ok false :is-error true
                                   :content (if known-not-started?
                                              "Tool was not dispatched before interruption. This call performed no action."
                                              "Tool outcome is unknown after interruption; the action may already have happened. Inspect current state before any retry. Do not automatically repeat it.")
                                   :details {:recovered true :execution-state execution-state
                                             :uncertain (not known-not-started?) :retryable false}
                                   :recovery {:version 1 :assistant-event-id (:id assistant)
                                              :execution-state execution-state}}))]
              {:identity [session-id (:run-id scope) (:step scope) (:id call)]
               :scope (assoc scope :call-id (:id call)) :call call
               :result-event result-event :result-data data}))
          (subvec (:calls batch) (count seen)))))}))
