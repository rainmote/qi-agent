(ns qi.generation
  "Write-ahead accounting for logical model requests, including failed attempts."
  (:require [qi.kernel :as kernel]))

(defn generate! [ctx request metadata]
  (let [store (kernel/service ctx :session/store)
        registry (kernel/service ctx :llm/registry)
        provider (when registry
                   (if-let [id (get-in request [:options :provider])]
                     ((:lookup registry) id) ((:current registry))))
        id (str (random-uuid))
        started (System/currentTimeMillis)
        common (merge (select-keys metadata [:purpose :attempt :run-id])
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
          (try {:response ((kernel/require-service ctx :llm/generate) request)}
               (catch Throwable error {:error error}))]
      (append! (assoc common :status (if error :failed :completed)
                            :duration_ms (- (System/currentTimeMillis) started)
                            :usage (if error (:usage (ex-data error)) (:usage response))
                            :error_code (when error (:code (ex-data error)))))
      (if error (throw error) response))))
