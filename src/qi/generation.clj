(ns qi.generation
  "Write-ahead accounting for logical model requests, including failed attempts."
  (:require [qi.kernel :as kernel]))

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

(defn request-summary [ctx run-id]
  (let [events (some-> (kernel/service ctx :session/store) :events (apply []))
        requests (vals (reduce (fn [calls {:keys [type data]}]
                                 (if (and (= type "usage/request")
                                          (or (= run-id (:run-id data)) (= run-id (:root-run-id data))))
                                   (assoc calls (:request_id data) data) calls)) {} events))
        tokens (fn [request key alternate]
                 (let [value (or (get-in request [:usage key]) (get-in request [:usage alternate]))]
                   (when (and (integer? value) (not (neg? value))) value)))
        input #(tokens % :input_tokens :prompt_tokens)
        output #(tokens % :output_tokens :completion_tokens)
        unknown (count (filter #(or (= :started (:status %)) (nil? (input %)) (nil? (output %))) requests))]
    {:scope :logical-requests :requests (count requests) :unknown-requests unknown
     :known-input-tokens (reduce + 0 (keep input requests))
     :known-output-tokens (reduce + 0 (keep output requests))
     :token-usage-complete (boolean (and (seq requests) (zero? unknown)))
     :total-cost-usd nil :accounting-complete false}))

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
                      (catch Throwable error
                        (throw (ex-info "Could not persist request accounting"
                                        {:code :usage_persistence_failed :retryable false
                                         :request_id id} error))))))]
    ;; If this write fails, no paid operation has been admitted.
    (append! (assoc common :status :started))
    (let [{:keys [response error]}
          (try {:response ((kernel/require-service ctx :llm/generate) (assoc request :accounting common))}
               (catch Throwable error {:error error}))]
      (append! (assoc common :status (if error :failed :completed)
                            :duration_ms (- (System/currentTimeMillis) started)
                            :usage (if error (:usage (ex-data error)) (:usage response))
                            :error_code (when error (:code (ex-data error)))))
      (if error (throw error) response))))
