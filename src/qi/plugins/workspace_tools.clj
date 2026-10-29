(ns qi.plugins.workspace-tools
  "Pinned desktop Office assets through the existing ExecutionWorld and gates."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.tool-contract :as contract]
            [qi.schema :as schema]
            [qi.workspace-runtime :as runtime]))

(defn quote-argument [value]
  (str "'" (str/replace (str value) "'" "'\\''") "'"))

(def parameters
  {:type "object" :additionalProperties false :required ["path" "output"]
   :properties {:path {:type "string" :minLength 1 :maxLength 2048}
                :output {:type "string" :minLength 1 :maxLength 2048}}})

(def plugin
  {:id :tools/workspace-runtime
   :requires #{:execution/world :tool/policy :project/trust :remote/registry}
   :start
   (fn [ctx _]
     (let [world (kernel/require-service ctx :execution/world)
           registry (kernel/require-service ctx :remote/registry)
           pending (atom {}) cancelled (atom #{}) closed? (atom false) lock (Object.)
           available? #(and (get-in world [:workspace-runtime :available?])
                            (true? (get-in world [:workspace-runtime :office-available?]))
                            (contains? (:capabilities world) :process))
           tool {:name "office_preview"
               :description "Convert an authorized workspace Office document to a new PDF using the pinned native engine. Input stays unchanged, existing outputs are never replaced; no host runtime or WASM fallback."
               :parameters parameters
               :requires-trust true :requires-approval true :execution-mode :sequential
               :uncertain-on-cancel true :stop-batch-on-error true
               :execute (fn [{:keys [path output]} execution]
                          (schema/validate! parameters {:path path :output output} "Invalid Office conversion")
                          (cancellation/throw-if-cancelled! (:cancel-token execution))
                          (let [_ (when @closed? (throw (ex-info "Office provider is closed" {})))
                                _ (when-not (available?) (throw (ex-info "Pinned workspace Office runtime is unavailable" {})))
                                trust (kernel/require-service ctx :project/trust)
                                _ (kernel/require-service ctx :tool/policy)
                                _ (when-not ((:trusted? trust)) (throw (ex-info "Office conversion requires a trusted project" {})))
                                assets (runtime/describe)
                                _ (when-not (and (:available? assets) (:office-available? assets))
                                    (throw (ex-info (or (:office-reason assets) (:reason assets) "Pinned Office runtime is unavailable") {})))
                                source ((:resolve! world) path)
                                destination ((:resolve-write! world) output)
                                _ (when (fs/exists? destination) (throw (ex-info "Office output already exists" {})))
                                command (str/join " " (map quote-argument [(:node assets) (:office-helper assets) (:root world) source destination]))
                                result (do (when-let [on-start (::on-process-start execution)] (on-start))
                                           ((:spawn! world) {:command command :cwd "." :timeout-ms 30000 :cancel-token (:cancel-token execution)}))]
                            (when-not (zero? (:exit-code result)) (throw (ex-info "Office conversion failed or outcome is unconfirmed; inspect output before retry" {:uncertain true})))
                            (let [rendered (json/parse-string (str/trim (:stdout result)) true)
                                  expected (str (fs/relativize (:root world) destination))]
                              (when-not (and (map? rendered) (= expected (:output rendered))
                                             (pos-int? (:bytes rendered)) (<= (:bytes rendered) 40000000))
                                (throw (ex-info "Office conversion returned an invalid output identity" {:uncertain true})))
                              (cancellation/throw-if-cancelled! (:cancel-token execution))
                              (assoc rendered :converted true))))}
           manual-schema (assoc-in parameters [:properties :request_id] {:type "string" :maxLength 80})
           render! (fn [args]
                     (schema/validate! manual-schema args "Invalid Office preview request")
                     (let [id (or (:request_id args) (str (random-uuid)))
                           _ (when-not (and (string? id) (re-matches #"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" id))
                               (throw (ex-info "Invalid Office request identity" {})))
                           token (cancellation/create-token)
                           started? (atom false) generated (atom nil)
                           arguments (dissoc args :request_id)
                           _ (locking lock
                               (when (or @closed? (seq @pending) (contains? @cancelled id))
                                 (throw (ex-info "An Office conversion is already pending or the provider is closed" {})))
                               (swap! pending assoc id token))
                           request {:tool tool :execution {:name "office_preview" :arguments arguments
                                                           :token (str (random-uuid)) :call-id id :cancel-token token}}]
                       (try
                         (cancellation/throw-if-cancelled! token)
                         (let [gate (contract/prepare! ctx request)]
                          (try
                           (cancellation/throw-if-cancelled! token)
                           (let [result (contract/dispatch! ctx gate
                                                         #(let [value (contract/canonical! tool ((:execute tool) (get-in % [:execution :arguments]) (assoc (:execution %) ::on-process-start (fn [] (reset! started? true)))))]
                                                            (reset! generated value) value))]
                             (when-not (and @generated (= result @generated) (true? (:converted result)))
                               (throw (ex-info "Office conversion was not executed or its result was replaced; no preview is claimed" {})))
                             result)
                           (finally (contract/release! gate))))
                         (catch Throwable error
                           (if @started?
                             (throw (ex-info "Office conversion result is unconfirmed; inspect the chosen output before retry"
                                             (assoc (ex-data error) :uncertain true :status "uncertain") error))
                             (throw error)))
                         (finally (swap! pending dissoc id)))))
           methods [{:method "workspace.runtime-status" :description "Inspect packaged workspace runtime capability without starting a process."
                     :params-schema {:type "object" :additionalProperties false :properties {}} :result-schema {:type "object"}
                     :handler (fn [_] {:available (boolean (and (not @closed?) (available?)))
                                       :runtime (if @closed? {:reason "Office request admission is closed; inspect existing outputs and use a new session."}
                                                  (cond-> (:workspace-runtime world)
                                                    (get-in world [:workspace-runtime :office-reason])
                                                    (assoc :reason (get-in world [:workspace-runtime :office-reason]))))
                                       :trusted (boolean ((:trusted? (kernel/require-service ctx :project/trust))))})}
                    {:method "workspace.office-preview" :description "Explicitly create a new PDF for file-panel preview through ordinary tool/trust/plan/approval gates."
                     :blocking true :params-schema manual-schema :result-schema {:type "object"} :handler render!}
                    {:method "workspace.office-cancel" :description "Cancel the current Office request; does not execute input, delete outputs or retry conversion."
                     :params-schema {:type "object" :required ["request_id"] :additionalProperties false
                                     :properties {:request_id {:type "string" :maxLength 80}}} :result-schema {:type "object"}
                     :handler (fn [{:keys [request_id]}]
                                (when-not (and (string? request_id) (re-matches #"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" request_id))
                                  (throw (ex-info "Invalid Office cancellation identity" {})))
                                (let [token (locking lock
                                              ;; A cancel may overtake the queued blocking
                                              ;; request. Never evict its tombstone; at the
                                              ;; finite limit close all future admission.
                                              (if (or (contains? @cancelled request_id) (< (count @cancelled) 128))
                                                (swap! cancelled conj request_id)
                                                (reset! closed? true))
                                              (get @pending request_id))]
                                  (when token (cancellation/cancel! token))
                                  {:cancelled true :pending (boolean token) :admission_closed @closed?}))}]
           disposers (mapv #((:register! registry) (kernel/wrap-plugin-value ctx %)) methods)]
       (kernel/track-stop! ctx #(do (locking lock (reset! closed? true))
                                   (doseq [token (vals @pending)] (cancellation/cancel! token))))
       (when (available?) (kernel/register-tool! ctx tool))
       (fn []
         (locking lock (reset! closed? true))
         (doseq [token (vals @pending)] (cancellation/cancel! token))
         (doseq [dispose (reverse disposers)] (dispose)))))})
