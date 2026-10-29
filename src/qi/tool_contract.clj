(ns qi.tool-contract
  "Shared final boundary for model and manual tool invocation.
  Middleware is extensibility, not an authority to change an approved action."
  (:require [qi.kernel :as kernel]
            [qi.schema :as schema]
            [qi.cancellation :as cancellation]))

(defn canonical-data!
  "Return a bounded, immutable JSON snapshot. Keyword names retain namespaces;
  sequences backed by mutable arrays are copied, never retained in approvals."
  [value]
  (let [remaining (volatile! 100000)]
    (letfn [(walk [v depth]
              (when (or (> depth 64) (neg? (vswap! remaining dec)))
                (throw (ex-info "Canonical tool data exceeds structural limits" {})))
              (cond
                (or (nil? v) (boolean? v) (string? v) (keyword? v)) v
                (number? v)
                (do (when (or (not (or (integer? v) (decimal? v) (float? v)))
                              (and (float? v) (not (Double/isFinite (double v)))))
                      (throw (ex-info "Canonical tool data contains a mutable or non-JSON number" {})))
                    v)
                (map? v)
                (let [ks (keys v)]
                  (when-not (every? #(or (string? %) (keyword? %)) ks)
                    (throw (ex-info "Canonical object keys must be strings or keywords" {})))
                  (when-not (= (count ks) (count (set (map #(if (keyword? %) (subs (str %) 1) %) ks))))
                    (throw (ex-info "Canonical object has duplicate JSON keys" {})))
                  (reduce-kv (fn [out key item] (assoc out key (walk item (inc depth)))) {} v))
                (sequential? v) (mapv #(walk % (inc depth)) v)
                :else (throw (ex-info "Tool data is not canonical JSON data"
                                     {:class (str (type v))}))))]
      (walk value 0))))

(defn canonical! [tool value]
  (let [value (canonical-data! value)]
    (when-let [output-schema (:output-schema tool)]
      (schema/validate! output-schema value "Tool returned invalid canonical output"))
    value))

(defn identity-of [request]
  ;; Maps compare functions and atoms by identity. Never serialize cancellation
  ;; tokens or callbacks, and never accept authority from a middleware flag.
  {:tool (:tool request)
   :execution (dissoc (:execution request) :started-at :started-at-nanos)})

(defn- unchanged! [original request]
  (when-not (= (identity-of original) (identity-of request))
    (throw (ex-info "Tool invocation changed after preparation or approval"
                    {:type :tool/identity-changed}))))

(defn- enforce! [ctx prepared request]
  (unchanged! prepared request)
  (cancellation/throw-if-cancelled! (get-in prepared [:execution :cancel-token]))
  (let [{:keys [tool]} prepared
        {:keys [guards policy owner]} (::boundary prepared)]
    (when (and (::kernel/registration tool) (not (kernel/tool-current? ctx tool)))
      (throw (ex-info "Tool registration changed after preparation" {:type :tool/stale})))
    (when (and owner
               (not= owner (select-keys (get-in @(:state ctx) [:instances (:plugin/id ctx)])
                                       [:generation :phase])))
      (throw (ex-info "Manual tool owner is no longer active" {:type :tool/stale})))
    (when-not (= guards (kernel/tool-guard-identities ctx))
      (throw (ex-info "Tool guards changed after preparation" {:type :tool/guards-changed})))
    (when (or (and policy (not (identical? policy (kernel/service ctx :tool/policy))))
              (and (or (:requires-trust tool) (:requires-approval tool))
                   (nil? (kernel/service ctx :tool/policy))))
      (throw (ex-info "Required tool policy is unavailable or changed" {:type :tool/policy-unavailable})))
    (when-let [denial (kernel/check-tool-guards! ctx request)]
      (throw (ex-info (:reason denial) (assoc denial :type :tool/denied))))))

(defn release! [prepared]
  (when-let [release (get-in prepared [::boundary :policy :release!])]
    ;; A retired policy clears all receipts in its own cleanup.
    (try (release (get-in prepared [:execution :token])) (catch Throwable _))))

(defn prepare! [ctx {:keys [tool execution] :as request}]
  (let [execution (cond-> (update execution :arguments canonical-data!)
                    (contains? execution :approval) (update :approval canonical-data!))
        request (assoc request :execution execution)
        _ (schema/validate! (:parameters tool) (:arguments execution) "Invalid tool arguments")
        prepared (assoc request ::boundary
                        {:guards (kernel/tool-guard-identities ctx)
                         :policy (kernel/service ctx :tool/policy)
                         :owner (when-not (::kernel/registration tool)
                                  {:generation (:plugin/generation ctx) :phase :active})})]
    (try
      (let [gate (kernel/waterfall ctx :tool/pre-execute request #(assoc % :decision :allow))]
        (unchanged! request gate)
        (when-not (= :allow (:decision gate))
          (throw (ex-info (or (:reason gate) "Tool execution was not approved")
                          {:type :tool/denied :terminate (:terminate gate)})))
        (enforce! ctx prepared request)
        prepared)
      (catch Throwable error (release! prepared) (throw error)))))

(defn dispatch!
  "Run execute middleware around one immutable invocation. A swallowed boundary
  error is still a failure when control returns from the middleware."
  [ctx prepared invoke]
  (let [request (select-keys prepared [:tool :execution])
        called? (atom false) violation (atom nil)
        body-result (atom nil)]
    (enforce! ctx prepared request)
    (let [result (kernel/waterfall
                  ctx :tool/execute request
                  (fn [candidate]
                    (try
                      (enforce! ctx prepared candidate)
                      (when-not (compare-and-set! called? false true)
                        (throw (ex-info "Tool middleware invoked the body more than once" {})))
                      (let [result (invoke request)] (reset! body-result result) result)
                      (catch Throwable error (reset! violation error) (throw error)))))]
      (when-let [error @violation] (throw error))
      (when (and (not @called?)
                 (or (true? (:ok result))
                     (not (or (false? (:ok result)) (true? (:blocked result))
                              (true? (:is-error result)) (true? (:cancelled result))))))
        (throw (ex-info "Tool middleware claimed a result without executing the body" {})))
      (when (and (map? @body-result) (contains? @body-result :ok))
        (when-not (boolean? (:ok result))
          (throw (ex-info "Tool middleware removed the execution outcome" {})))
        (unchanged! prepared {:tool (:tool prepared) :execution (:execution result)}))
      (when (and (or (false? (:ok @body-result)) (:is-error @body-result) (:cancelled @body-result))
                 (not (false? (:ok result))))
        (throw (ex-info "Tool middleware upgraded a failed execution to success" {})))
      result)))

(defn final-result! [prepared before result]
  (when-not (and (map? result) (boolean? (:ok result)))
    (throw (ex-info "Invalid final tool outcome" {})))
  (let [result (reduce (fn [out key]
                         (if (contains? out key) (update out key canonical-data!) out))
                       result [:value :content :details :images :error])]
    (unchanged! prepared {:tool (:tool prepared) :execution (:execution result)})
    (when (and (or (not (true? (:ok before))) (:cancelled before) (:is-error before) (:blocked before))
               (true? (:ok result)))
      (throw (ex-info "Tool post hook upgraded a failed execution to success" {})))
    (when (true? (:ok result))
      (when (or (:is-error result) (:cancelled result) (:blocked result) (not (contains? result :value)))
        (throw (ex-info "Successful tool outcome is missing canonical output" {})))
      (canonical! (:tool prepared) (:value result)))
    (cond-> (assoc result :execution (:execution prepared))
      (false? (:ok result)) (assoc :is-error true))))
