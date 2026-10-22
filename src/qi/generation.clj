(ns qi.generation
  "Write-ahead accounting for logical model requests, including failed attempts."
  (:require [qi.kernel :as kernel]
            [qi.context-summary :as summary]))

(def ^:dynamic *run* nil)

(defn run-budget [run-id config]
  {:run-id run-id :root-run-id (or (:root-run-id *run*) run-id)
   :requests (or (:requests *run*) (atom 0))
   :max-requests (or (:max-requests *run*) (:max-model-requests config))
   :deadline (or (:deadline *run*)
                 (when-let [ms (:max-wall-ms config)] (+ (System/currentTimeMillis) ms)))})

(defn- admit! []
  (when-let [deadline (:deadline *run*)]
    (when (>= (System/currentTimeMillis) deadline)
      (throw (ex-info "Model request deadline reached" {:reason :wall-budget :retryable false}))))
  (when-let [limit (:max-requests *run*)]
    (when (> (swap! (:requests *run*) inc) limit)
      (throw (ex-info "Model request budget exhausted" {:reason :request-budget :retryable false})))))

(defn root-target [ctx]
  (or (kernel/service ctx :usage/root-target)
      {:context ctx :store (kernel/service ctx :session/store)}))

(defn- append-index! [ctx type data]
  (when (:root-run-id data)
    (let [{:keys [context store]} (root-target ctx)]
      (when store
        (try
          (kernel/emit! context :session/event ((:append! store) type data))
          (catch Throwable error
            (throw (ex-info "Could not persist task-tree request accounting"
                            {:code :usage_persistence_failed :retryable false} error))))))))

(defn record-tree-run! [ctx run-id root-run-id status]
  (append-index! ctx "usage/tree-run"
                 {:run-id run-id :root-run-id root-run-id :status status
                  :session_id (:session-id (kernel/service ctx :session/store))
                  :agent-id (:child-agent-id (root-target ctx))
                  :index-version 1}))

(defn record-provider! [ctx result status]
  (append-index! ctx "usage/tree-provider"
                 (assoc (select-keys result [:root-run-id :provider :id :execution-run-id])
                        :registry-run-id (:run-id result) :status status)))

(defn- phase [value] (if (string? value) (keyword value) value))

(defn- latest-fact [previous data]
  ;; Replayed starts must not erase a settled request or terminal run.
  (if (and previous (not (contains? #{:started :running} (phase (:status previous))))
           (contains? #{:started :running} (phase (:status data))))
    previous data))

(defn- summarize [requests scope]
  (let [tokens (fn [request key alternate]
                 (let [value (or (get-in request [:usage key]) (get-in request [:usage alternate]))]
                   (when (and (integer? value) (not (neg? value))) value)))
        input #(tokens % :input_tokens :prompt_tokens)
        output #(tokens % :output_tokens :completion_tokens)
        unknown (count (filter #(or (= :started (phase (:status %))) (nil? (input %)) (nil? (output %))) requests))]
    {:scope scope :request-scope :logical-requests :requests (count requests) :unknown-requests unknown
     :known-input-tokens (reduce + 0 (keep input requests))
     :known-output-tokens (reduce + 0 (keep output requests))
     :token-usage-complete (boolean (and (seq requests) (zero? unknown)))
     :total-cost-usd nil :accounting-complete false}))

(defn- request-facts [events run-id types]
  (vals (reduce (fn [calls {:keys [type data]}]
                  (if (and (contains? types type)
                           (or (= run-id (:run-id data)) (= run-id (:root-run-id data))))
                    (update calls [(:session_id data) (:request_id data)] latest-fact data) calls)) {} events)))

(defn request-summary [ctx run-id]
  (summarize (request-facts (some-> (kernel/service ctx :session/store) :events (apply []))
                            run-id #{"usage/request"}) :session-local))

(defn root-request-summary [ctx root-run-id]
  (let [events (some-> (root-target ctx) :store :events (apply []))
        requests (request-facts events root-run-id #{"usage/request" "usage/child-request"})
        facts (fn [type key]
                (vals (reduce (fn [values event]
                                (let [data (:data event)]
                                  (if (and (= type (:type event)) (= root-run-id (:root-run-id data)))
                                    (update values (key data) latest-fact data) values))) {} events)))
        runs (facts "usage/tree-run" #(vector (:session_id %) (:run-id %)))
        providers (facts "usage/tree-provider" :registry-run-id)
        root (first (filter #(= root-run-id (:run-id %)) runs))
        expected (set (keep :session_id runs))
        observed (set (keep :session_id requests))
        pending (filter #(contains? #{:started :running :uncertain} (phase (:status %))) runs)
        native-runs (into {} (map (juxt :run-id identity) runs))
        unknown-providers (filter #(or (contains? #{:started :running :uncertain} (phase (:status %)))
                                      (nil? (:id %))
                                      (not= (:id %) (get-in native-runs [(:execution-run-id %) :agent-id]))) providers)
        coverage-complete (and root (every? observed expected) (empty? pending) (empty? unknown-providers))
        summary (summarize requests :root-tree)]
    (assoc summary
           :coverage {:status (if root :indexed :legacy-unindexed)
                      :expected-sessions (vec (sort expected)) :observed-sessions (vec (sort observed))
                      :request-coverage-complete (boolean coverage-complete)}
           :pending-children (mapv :run-id (remove #(= root-run-id (:run-id %)) pending))
           :unknown-provider-runs (mapv :registry-run-id unknown-providers)
           :token-usage-complete (boolean (and coverage-complete (:token-usage-complete summary))))))

(defn generate! [ctx request metadata]
  (admit!)
  (let [metadata (merge (select-keys *run* [:run-id :root-run-id]) metadata)
        store (kernel/service ctx :session/store)
        registry (kernel/service ctx :llm/registry)
        provider (when registry
                   (if-let [id (get-in request [:options :provider])]
                     ((:lookup registry) id) ((:current registry))))
        id (str (random-uuid))
        started (System/currentTimeMillis)
        common (merge (select-keys metadata [:purpose :attempt :run-id :root-run-id :operation-id :compaction-id :chunk-index])
                      {:request_id id :provider (:id provider) :model (:model provider)
                       :session_id (:session-id store) :cost_usd nil
                       ;; Provider-internal transport retries and billing are not inferred.
                       :accounting_complete false :scope :logical_request})
        append! (fn [data]
                  (when store
                    (try
                      (kernel/emit! ctx :session/event ((:append! store) "usage/request" data))
                      (when (and (:root-run-id data)
                                 (not (identical? store (:store (root-target ctx)))))
                        (append-index! ctx "usage/child-request" data))
                      (catch Throwable error
                        (throw (ex-info "Could not persist request accounting"
                                        {:code :usage_persistence_failed :retryable false
                                         :request_id id} error))))))]
    ;; If this write fails, no paid operation has been admitted.
    (append! (assoc common :status :started))
    (let [{:keys [response error]}
          (try {:response ((kernel/require-service ctx :llm/generate)
                           (assoc (summary/wire-request request) :accounting common))}
               (catch Throwable error {:error error}))]
      (append! (assoc common :status (if error :failed :completed)
                            :duration_ms (- (System/currentTimeMillis) started)
                            :usage (if error (:usage (ex-data error)) (:usage response))
                            :error_code (when error (:code (ex-data error)))))
      (if error (throw error) response))))
