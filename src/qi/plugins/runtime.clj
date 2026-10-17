(ns qi.plugins.runtime
  "Controllable agent session, deterministic tool batches, and the default loop."
  (:require [qi.attachments :as attachments]
            [qi.cancellation :as cancellation]
            [qi.generation :as generation]
            [qi.kernel :as kernel]
            [qi.run-outcome :as outcome]
            [qi.schema :as schema]
            [qi.system-prompt :as system]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- record! [ctx type data]
  (let [store (kernel/require-service ctx :session/store)
        event ((:append! store) type data)]
    (kernel/emit! ctx :session/event event)
    event))

(defn- record-message! [ctx message]
  (record! ctx "message" {:message message})
  message)

(defn- messages [ctx]
  ((:messages (kernel/require-service ctx :session/store))))

(defn- nonblank-string [value]
  (when (and (string? value) (not (str/blank? value))) value))

(defn- base-system-prompt [{:keys [system-prompt system-prompt-template]}]
  (case system-prompt-template
    nil system-prompt
    :omp @system/omp-template
    (throw (ex-info "Unknown system prompt template"
                    {:template system-prompt-template}))))

(defn- system-prompt [ctx config]
  (let [resources (kernel/service ctx :resources/catalog)
        snapshot (when resources
                   ((or (:prompt-snapshot resources) (:snapshot resources))))
        custom (or (nonblank-string (:custom-system-prompt config))
                   (get-in snapshot [:system-prompt :content]))
        append-prompt (or (nonblank-string (:append-system-prompt config))
                          (get-in snapshot [:append-system-prompt :content]))]
    (system/assemble
     {:base-prompt (base-system-prompt config)
      :custom-prompt custom
      :append-prompt append-prompt
      :contexts (:contexts snapshot)
      :skills (or (:model-skills snapshot) (:skills snapshot))
      :tool-names (when resources (mapv :name (kernel/tools ctx)))
      :workspace (:workspace snapshot)
      :local-date (when resources (str (java.time.LocalDate/now)))
      :project-trusted (:project-trusted snapshot)})))

(defn- blank-content? [content]
  (or (nil? content)
      (and (string? content) (str/blank? content))
      (and (sequential? content) (empty? content))))

(defn- arguments [tool-call]
  (let [raw (get-in tool-call [:function :arguments])]
    (cond
      (map? raw) raw
      (str/blank? raw) {}
      (string? raw) (json/parse-string raw true)
      :else (throw (ex-info "Tool arguments must be a JSON string or map"
                            {:arguments raw})))))

(defn- result-content [value]
  (if (string? value) value (json/generate-string value)))

(defn- failure [execution message & [details]]
  {:ok false
   :is-error true
   :execution execution
   :error message
   :details details
   :content (str "ERROR: " message
                 (when (:uncertain details)
                   " Outcome is uncertain: the action may already have happened. Inspect current state before any retry."))})

(defn- cancelled-error? [error]
  (true? (:cancelled (ex-data error))))

(defn- cancelled-result [execution]
  (let [uncertain? (and (:uncertain-on-cancel execution) (:started-at execution))]
   {:ok false
   :is-error true
   :cancelled true
   :execution execution
   :error "Agent run was cancelled"
   :details (cond-> {:cancelled true} uncertain? (assoc :uncertain true))
   :content (if uncertain?
              "Tool execution was cancelled. Outcome is uncertain: desktop input may already have happened. Inspect current state before any retry."
              "Tool execution was cancelled.")}))

(defn- cancelled-result? [result]
  (or (true? (:cancelled result))
      (true? (get-in result [:details :cancelled]))))

(defn- run-tool-body [{:keys [tool execution]}]
  (try
    (cancellation/throw-if-cancelled! (:cancel-token execution))
    (let [value ((:execute tool) (:arguments execution) execution)
          details (when-let [details-fn (:result-details tool)]
                    (details-fn (:arguments execution) value))
          images (when-let [images-fn (:result-images tool)]
                   (images-fn (:arguments execution) value))
          is-error (boolean (when-let [error-fn (:result-error? tool)]
                              (error-fn (:arguments execution) value)))]
      (when-let [output-schema (:output-schema tool)]
        (schema/validate! output-schema value
                          "Tool returned invalid canonical output"))
      (cond-> {:ok (not is-error)
       :is-error is-error
       :execution execution
       :value value
       :details details
       :content (if-let [render (or (:render-model tool) (:render tool))]
                  (render (:arguments execution) value)
                  (result-content value))}
        (seq images) (assoc :images images)))
    (catch Throwable error
      (if (cancelled-error? error)
        (cancelled-result execution)
        (failure execution (ex-message error) (ex-data error))))))

(defn- record-tool-call! [ctx tool-call]
  (let [visible-arguments (try
                            (arguments tool-call)
                            (catch Throwable _
                              (get-in tool-call [:function :arguments])))]
    (record! ctx "tool/call"
             {:name (get-in tool-call [:function :name])
              :call-id (:id tool-call)
              :arguments visible-arguments})))

(defn- prepare-call! [ctx tool-call cancel-token on-update]
  (let [call-id (:id tool-call)
        tool-name (get-in tool-call [:function :name])
        tool (kernel/tool ctx tool-name)
        base-execution {:token (str (random-uuid))
                        :call-id call-id
                        :name tool-name
                        :cancel-token cancel-token
                        :on-update on-update
                        :uncertain-on-cancel (:uncertain-on-cancel tool)
                        :stop-batch-on-error (:stop-batch-on-error tool)}]
    (cond
      (cancellation/cancelled? cancel-token)
      {:call tool-call :result (cancelled-result base-execution)}

      (nil? tool)
      {:call tool-call
       :result (failure base-execution (str "Unknown tool: " tool-name))}

      :else
      (try
        (let [args (arguments tool-call)
              execution (cond-> (assoc base-execution :arguments args)
                          (:approval-target tool)
                          (assoc :approval
                                 ((:approval-target tool) args)))
              validation-errors (schema/errors (:parameters tool) args)]
          (cond
            (cancellation/cancelled? cancel-token)
            {:call tool-call :result (cancelled-result execution)}

            (seq validation-errors)
            {:call tool-call
             :result (failure execution "Invalid tool arguments"
                              {:errors validation-errors})}

            :else
            (let [gate (kernel/waterfall
                        ctx :tool/pre-execute
                        {:decision :pending
                         :execution execution
                         :tool tool}
                        #(assoc % :decision :allow))]
              (cond
                (cancellation/cancelled? cancel-token)
                {:call tool-call
                 :result (cancelled-result (:execution gate))}

                (= :deny (:decision gate))
                {:call tool-call
                 :result (assoc (failure execution
                                         (or (:reason gate)
                                             "Denied by policy"))
                                :terminate (boolean (:terminate gate)))}

                :else
                {:call tool-call
                 :prepared {:execution (:execution gate)
                            :tool (:tool gate)}}))))
        (catch Throwable error
          {:call tool-call
           :result (if (or (cancelled-error? error)
                           (cancellation/cancelled? cancel-token))
                     (cancelled-result base-execution)
                     (failure base-execution (ex-message error)
                              (ex-data error)))})))))

(defn- execute-prepared! [ctx {:keys [prepared result] :as entry} begin!]
  (if result
    entry
    (let [base-execution (:execution prepared)]
      (if (cancellation/cancelled? (:cancel-token base-execution))
        (assoc entry :result (cancelled-result base-execution))
        (let [started-at (System/currentTimeMillis)
              execution (assoc base-execution
                               :started-at-nanos (System/nanoTime)
                               :started-at started-at)
              prepared (assoc prepared :execution execution)]
          ;; The slot serializes start against cancellation. If cancellation
          ;; already won, no start can appear after the terminal event.
          (if-not (begin! execution)
            (assoc entry :result (cancelled-result execution))
            (try
              (let [outcome (kernel/waterfall
                             ctx :tool/post-execute
                             (kernel/waterfall ctx :tool/execute prepared
                                               run-tool-body)
                             identity)
                    outcome (cond
                              (cancelled-result? outcome)
                              (cancelled-result
                               (or (:execution outcome) execution))

                              (cancellation/cancelled?
                               (:cancel-token execution))
                              (cancelled-result
                               (or (:execution outcome) execution))

                              :else outcome)]
                (assoc entry :result outcome))
              (catch Throwable error
                (assoc entry :result
                       (if (or (cancelled-error? error)
                               (cancellation/cancelled?
                                (:cancel-token execution)))
                         (cancelled-result execution)
                         (failure execution (ex-message error)
                                  (ex-data error))))))))))))

(defn- result-status [{:keys [ok is-error details] :as result}]
  (let [exit-code (or (:exit-code details) (:exit_code details)
                      (:exitCode details))]
    (cond
      (cancelled-result? result) :canceled
      (or (false? ok) is-error
          (and (number? exit-code) (not (zero? exit-code)))) :error
      :else :success)))

(defn- tool-result-data [{:keys [call result]}]
  (let [execution (:execution result)
        started-at-nanos (:started-at-nanos execution)
        duration-ms (when (and started-at-nanos (:started-at execution))
                      (max 0 (quot (- (System/nanoTime) started-at-nanos)
                                   1000000)))
        status (result-status result)]
    (cond-> {:name (get-in call [:function :name])
     :call-id (:id call)
     :execution-id (:token execution)
     :started-at (:started-at execution)
     :status status
     :cancelled (= :canceled status)
     :ok (:ok result)
     :is-error (:is-error result)
     :error (:error result)
     :value (if (and (seq (:images result)) (map? (:value result)))
              (dissoc (:value result) :images)
              (:value result))
     :details (:details result)
     :content (:content result)
     :duration-ms duration-ms}
      (seq (:images result)) (assoc :images (:images result)))))

(defn- emit-tool-end! [ctx entry]
  (let [result-data (tool-result-data entry)]
    (kernel/emit! ctx :tool.execution/end result-data)
    (assoc entry :result-data result-data)))

(defn- record-tool-result! [ctx {:keys [call result result-data] :as entry}]
  (let [entry (if result-data entry (emit-tool-end! ctx entry))
        result-data (:result-data entry)]
    ;; Canonical values can be large and often duplicate model content. Persist
    ;; compact renderer data in model order, independently of live completion.
    (record! ctx "tool/result" (dissoc result-data :value))
    [call result]))

(defn- truncated-tool-results [tool-calls]
  (mapv (fn [tool-call]
          {:call tool-call
           :result
           (failure {:token (str (random-uuid))
                     :call-id (:id tool-call)
                     :name (get-in tool-call [:function :name])}
                    (str "Tool call was not executed because the model response "
                         "hit its output-token limit."))})
        tool-calls))

(defn- sequential-batch? [prepared]
  (boolean
   (some #(or (= :sequential (get-in % [:prepared :tool :execution-mode]))
              (true? (get-in % [:result :execution :stop-batch-on-error])))
         prepared)))

(defn- completion-slot [entry]
  {:entry entry
   :transition-lock (Object.)
   :terminal? (atom false)
   :execution (atom (or (get-in entry [:prepared :execution])
                        (get-in entry [:result :execution])))
   :completion (promise)})

(defn- begin-slot! [ctx {:keys [transition-lock terminal? execution]} started]
  (locking transition-lock
    (when-not @terminal?
      (reset! execution started)
      (kernel/emit! ctx :tool.execution/start
                    {:execution-id (:token started)
                     :call-id (:call-id started)
                     :name (:name started)
                     :started-at (:started-at started)})
      true)))

(defn- complete-slot!
  [ctx {:keys [transition-lock terminal? completion]} entry]
  (locking transition-lock
    (when-not @terminal?
      (reset! terminal? true)
      ;; Preflight failures are emitted as soon as they are known, before a
      ;; later approval can block the batch. Reuse that exact terminal payload
      ;; when the ordered completion slots are assembled afterwards.
      (deliver completion (if (:result-data entry)
                            entry
                            (emit-tool-end! ctx entry)))))
  nil)

(defn- cancel-slot!
  [ctx {:keys [entry execution transition-lock] :as slot}]
  (locking transition-lock
    (when-let [execution @execution]
      (complete-slot! ctx slot
                      (assoc entry :result
                             (cancelled-result execution))))))

(defn- execute-slots-sequentially! [ctx slots cancel-token]
  (loop [[{:keys [entry terminal? execution completion] :as slot} & remaining] slots
         blocked-by nil]
    (when slot
      (when-not @terminal?
        (cond
          (cancellation/cancelled? cancel-token)
          (cancel-slot! ctx slot)

          blocked-by
          (complete-slot!
           ctx slot
           (assoc entry :result
                  (failure @execution
                           "Skipped because an earlier desktop tool in this batch failed; inspect the current state before continuing."
                           {:skipped true :blocked-by blocked-by})))

          :else
          (complete-slot! ctx slot
                          (execute-prepared!
                           ctx entry #(begin-slot! ctx slot %)))))
      ;; Preflight failures have already completed their slots. Include them in
      ;; the same stop rule as execution failures, without emitting a second
      ;; terminal event. Only tools opting into this rule halt the batch.
      (let [{:keys [call result]} @completion
            blocked-by (or blocked-by
                           (when (and (get-in result [:execution :stop-batch-on-error])
                                      (not= :success (result-status result)))
                             (:id call)))]
        (recur remaining blocked-by)))))

(defn- execute-slots-in-parallel! [ctx slots tasks]
  (doseq [{:keys [entry terminal?] :as slot} slots
          :when (and (:prepared entry) (not @terminal?))]
    (swap! tasks conj
           (future
             (complete-slot! ctx slot
                             (execute-prepared!
                              ctx entry #(begin-slot! ctx slot %)))))))

(defn- execute-batch! [ctx tool-calls cancel-token]
  (let [update! (fn [execution update]
                  (kernel/emit! ctx :tool.execution/update
                                {:execution-id (:token execution)
                                 :call-id (:call-id execution)
                                 :name (:name execution)
                                 :update update}))
        _ (doseq [tool-call tool-calls]
            (record-tool-call! ctx tool-call))
        ;; Policy and approval remain serial and all finish before a body starts.
        ;; A terminal preflight outcome is nevertheless visible immediately;
        ;; durable results are still drained in model order below.
        prepared (mapv (fn [tool-call]
                         (let [entry (prepare-call! ctx tool-call cancel-token
                                                    update!)]
                           (if (:result entry)
                             (emit-tool-end! ctx entry)
                             entry)))
                       tool-calls)
        slots (mapv completion-slot prepared)
        tasks (atom [])]
    ;; Invalid, unknown, denied, and already-cancelled calls are terminal before
    ;; execution. Complete them before installing the cancellation callback.
    (doseq [{:keys [entry] :as slot} slots
            :when (:result entry)]
      (complete-slot! ctx slot entry))
    (let [dispose-cancel
          (cancellation/on-cancel!
           cancel-token
           (fn []
             (doseq [slot slots]
               (cancel-slot! ctx slot))))]
      (try
        (if (sequential-batch? prepared)
          (execute-slots-sequentially! ctx slots cancel-token)
          (execute-slots-in-parallel! ctx slots tasks))
        (let [executed (mapv #(deref (:completion %)) slots)]
          (when (cancellation/cancelled? cancel-token)
            (doseq [task @tasks]
              (future-cancel task)))
          ;; Only this ordered drain mutates the durable session.
          (mapv #(record-tool-result! ctx %) executed))
        (finally
          (dispose-cancel))))))

(defn- tool-result-message [tool-call result]
  (cond-> {:role "tool"
   :tool_call_id (:id tool-call)
   :content (:content result)}
    (seq (:images result)) (assoc :images (:images result))
    (:is-error result) (assoc :is-error true)))

(defn- add-usage [total usage]
  (merge-with (fn [left right]
                (if (and (number? left) (number? right))
                  (+ left right)
                  right))
              total (or usage {})))

(defn- publish! [ctx listeners type data]
  (let [event (assoc data :type type)]
    (kernel/emit! ctx type event)
    (doseq [listener (vals @listeners)]
      (try (listener event) (catch Throwable _)))
    event))

(defn- set-phase! [ctx state listeners phase & [extra]]
  (let [next-state
        (swap! state
               (fn [current]
                 (cond-> (-> (merge current {:phase phase} extra)
                             (assoc :revision (inc (or (:revision current) 0))))
                   (= phase :model)
                   (assoc :partial-assistant "" :partial-reasoning "")

                   (not= phase :model)
                   (dissoc :partial-assistant :partial-reasoning))))]
    (publish! ctx listeners :agent/state next-state)
    next-state))

(defn- track-partial! [ctx state listeners event]
  (when (= :model (:phase @state))
    (let [field (case (:type event)
                  :text/delta :partial-assistant
                  :reasoning/delta :partial-reasoning
                  nil)
          delta (:delta event)]
      (when (and field (string? delta))
        (let [[before next-state]
              (swap-vals! state
                          (fn [current]
                            (if (= :model (:phase current))
                              (-> current
                                  (update field str delta)
                                  (update :revision (fnil inc 0)))
                              current)))]
          (when (not= (:revision before) (:revision next-state))
            (publish! ctx listeners :agent/state next-state)))))))

(defn- drain-kind! [queue kind]
  (loop []
    (let [items @queue
          selected (filterv #(= kind (:kind %)) items)
          remaining (filterv #(not= kind (:kind %)) items)]
      (if (compare-and-set! queue items remaining)
        selected
        (recur)))))

(defn- inject-queued! [ctx queue listeners kind]
  (let [items (drain-kind! queue kind)]
    (doseq [{:keys [message]} items]
      (record-message! ctx {:role "user" :content message})
      (publish! ctx listeners :agent.message/queued-consumed
                {:kind kind :message message}))
    (when (seq items)
      (publish! ctx listeners :queue/changed {:queue @queue}))
    (count items)))

(defn- close-admission!
  [ctx active admission-lock queue listeners reason]
  (locking admission-lock
    (when @active
      (swap! active assoc :accepting-queue? false))
    (let [discarded @queue]
      (when (seq discarded)
        (reset! queue [])
        (doseq [item discarded]
          (record! ctx "queue/discarded" (assoc item :reason reason)))
        (publish! ctx listeners :queue/changed
                  {:queue [] :discarded (count discarded) :reason reason}))
      (count discarded))))

(defn- error-chain [error]
  (take-while some? (iterate ex-cause error)))

(defn- transport-error? [error]
  (let [message (->> (error-chain error)
                     (keep ex-message)
                     (str/join " ")
                     str/lower-case)]
    (or (some #(instance? java.io.IOException %) (error-chain error))
        (some #(str/includes? message %)
              ["remote host terminated the handshake"
               "connection reset"
               "connection refused"
               "connection closed"
               "broken pipe"
               "timed out"
               "timeout"
               "unexpected end of stream"
               "premature eof"
               "temporary failure in name resolution"]))))

(defn- retryable? [error]
  (let [data (ex-data error)
        status (or (:status data) (:http-status data))]
    (and (not (:cancelled data))
         (if (contains? data :retryable)
           (boolean (:retryable data))
           (or (contains? #{408 409 425 429 500 502 503 504} status)
               (and (nil? status) (transport-error? error)))))))

(defn- context-overflow? [error]
  (let [data (ex-data error)
        message (str/lower-case (or (ex-message error) ""))]
    (or (:context-overflow data)
        (str/includes? message "context length")
        (str/includes? message "context window")
        (str/includes? message "too many tokens"))))

(defn- cancellable-wait! [cancel-token milliseconds]
  (loop [remaining milliseconds]
    (cancellation/throw-if-cancelled! cancel-token)
    (when (pos? remaining)
      (let [slice (min remaining 50)]
        (Thread/sleep slice)
        (recur (- remaining slice))))))

(defn- generate-with-recovery! [ctx config request cancel-token state listeners]
  (let [context (kernel/service ctx :context/manager)
        max-retries (or (:max-retries config) 2)
        retry-delay-ms (or (:retry-delay-ms config) 250)]
    (loop [attempt 0 overflow-retried? false request request]
      (cancellation/throw-if-cancelled! cancel-token)
      (let [prepared (if context ((:prepare! context) request) request)]
        (set-phase! ctx state listeners :model {:attempt attempt})
        (let [outcome (try
                        {:response (kernel/waterfall
                                    ctx :llm/request prepared
                                    (fn [request]
                                      (let [resolved (attachments/resolve-request ctx request)
                                            checked (if context ((:check! context) resolved) resolved)]
                                        (when context
                                          (let [budget ((:budget! context) checked)]
                                            (record! ctx "context/budget" (assoc budget :run-id (:run-id @state)))
                                            (set-phase! ctx state listeners :model {:request-budget budget})))
                                        (generation/generate! ctx checked
                                                              {:purpose :main :attempt attempt
                                                               :run-id (:run-id @state)}))))}
                        (catch Throwable error {:error error}))
              error (:error outcome)]
          (cond
            (nil? error) (:response outcome)

            (and (context-overflow? error)
                 context
                 (not overflow-retried?))
            (do
              (set-phase! ctx state listeners :compacting)
              (let [result ((:compact! context) {:force true :reason :overflow
                                                 :cancel-token cancel-token
                                                 :request prepared})]
                (when-not (:compacted result)
                  (throw (ex-info "Provider rejected context and no safe compaction is available"
                                  {:code :context_unfit :reason (:reason result)
                                   :retryable false} error))))
              (publish! ctx listeners :agent/retry
                        {:reason :context-overflow :attempt (inc attempt)})
              (recur (inc attempt) true
                     (assoc prepared :messages (messages ctx))))

            (and (retryable? error) (< attempt max-retries))
            (do
              (set-phase! ctx state listeners :retry
                          {:attempt (inc attempt)})
              (publish! ctx listeners :agent/retry
                        {:reason :provider-error
                         :attempt (inc attempt)
                         :delay-ms (* retry-delay-ms (inc attempt))})
              (cancellable-wait! cancel-token
                                 (* retry-delay-ms (inc attempt)))
              (recur (inc attempt) overflow-retried? prepared))

            :else (throw error)))))))

(defn- finish-or-continue!
  "Atomically consume messages queued at a natural stop, or close admission.

  Without this boundary a follow-up could observe an active run immediately
  after the final queue drain and then remain stranded until another run."
  [ctx active admission-lock queue listeners]
  (locking admission-lock
    (let [steering-count (inject-queued! ctx queue listeners :steer)
          follow-up-count (if (zero? steering-count)
                            (inject-queued! ctx queue listeners :follow-up)
                            0)
          continue-count (+ steering-count follow-up-count)]
      (when (zero? continue-count)
        (swap! active assoc :accepting-queue? false))
      continue-count)))

(defn- close-aborted-step! [ctx listeners step]
  (let [turn-end {:step step :tool-count 0 :aborted true}]
    (record! ctx "step/end" turn-end)
    (publish! ctx listeners :agent.turn/end turn-end)))

(defn- run-agent-body!
  [ctx config active admission-lock prompt options cancel-token queue state
   listeners progress]
  (when (blank-content? prompt)
    (throw (ex-info "Prompt must not be blank" {})))
  (record-message! ctx {:role "user" :content prompt})
  (publish! ctx listeners :agent.message/start {:role "user" :content prompt})
  (let [max-steps (or (:max-steps options) (:max-steps config) 256)]
    (loop [step 1 usage {}]
      (cancellation/throw-if-cancelled! cancel-token)
      (when (> step max-steps)
        (throw (ex-info "Agent exceeded its step limit"
                        {:reason :step-budget :max-steps max-steps
                         :messages (messages ctx)})))
      ;; Steering becomes context immediately before the next model request.
      (inject-queued! ctx queue listeners :steer)
      (record! ctx "step/start" {:step step})
      (publish! ctx listeners :agent.turn/start {:step step})
      (let [current-system-prompt (system-prompt ctx config)
            _ (when (= step 1)
                (record! ctx "context/snapshot"
                         {:step step :content current-system-prompt}))
            request {:system-prompt current-system-prompt
                     :messages (messages ctx)
                     :tools (kernel/tool-schemas ctx)
                     :cancel-token cancel-token
                     :options (:model-options options)}
            response (try
                       (generate-with-recovery!
                        ctx config request cancel-token state listeners)
                       (catch Throwable error
                         ;; Some providers report an ordinary HTTP/transport
                         ;; error after their request has already been aborted.
                         ;; The user cancellation is authoritative and must
                         ;; close the open step as an abort, not an agent error.
                         (if (cancellation/cancelled? cancel-token)
                           (do
                             (close-aborted-step! ctx listeners step)
                             (cancellation/throw-if-cancelled! cancel-token))
                           (throw error))))
            assistant (assoc (:message response) :role "assistant")
            tool-calls (vec (:tool_calls assistant))
            next-usage (add-usage usage (:usage response))]
        (reset! progress {:steps step :usage next-usage})
        ;; A provider may ignore cooperative cancellation and return a normal
        ;; response later. Close the already-open step, but do not commit that
        ;; stale assistant answer or any stale tool calls into the durable
        ;; conversation.
        (when (cancellation/cancelled? cancel-token)
          (close-aborted-step! ctx listeners step)
          (cancellation/throw-if-cancelled! cancel-token))
        (when (or (not (map? (:message response))) (:error response))
          (throw (ex-info "Provider returned an invalid response" {:reason :provider-error})))
        (record-message! ctx assistant)
        (publish! ctx listeners :agent.message/end {:message assistant})
        (if (seq tool-calls)
          (let [executions (if (= "length" (:finish-reason response))
                             (do
                               (doseq [tool-call tool-calls]
                                 (record-tool-call! ctx tool-call))
                               (mapv #(record-tool-result! ctx %)
                                     (truncated-tool-results tool-calls)))
                             (do
                               (set-phase! ctx state listeners :tool)
                               (execute-batch! ctx tool-calls cancel-token)))
                results (mapv second executions)
                turn-end (cond-> {:step step :tool-count (count results)}
                           (cancellation/cancelled? cancel-token)
                           (assoc :aborted true))]
            (doseq [[call result] executions]
              (record-message! ctx (tool-result-message call result)))
            (record! ctx "step/end" turn-end)
            (publish! ctx listeners :agent.turn/end turn-end)
            (cancellation/throw-if-cancelled! cancel-token)
            (if (some :terminate results)
              (do
                (close-admission! ctx active admission-lock queue listeners
                                  :tool-terminated)
                (throw (ex-info "Agent run was terminated by tool policy"
                                {:reason :tool-terminated :terminated true})))
              (recur (inc step) next-usage)))
          (let [continue-count (finish-or-continue!
                                ctx active admission-lock queue listeners)
                turn-end (cond-> {:step step :tool-count 0}
                           (cancellation/cancelled? cancel-token)
                           (assoc :aborted true))]
            (record! ctx "step/end" turn-end)
            (publish! ctx listeners :agent.turn/end turn-end)
            (cancellation/throw-if-cancelled! cancel-token)
            (when-not (outcome/complete-response? response)
              (throw (ex-info "Provider returned an incomplete final response"
                              {:reason (if (contains? #{"length" "max_tokens"}
                                                      (some-> (:finish-reason response) name))
                                         :output-limit :provider-incomplete)
                               :finish-reason (:finish-reason response)})))
            (if (pos? continue-count)
              (recur (inc step) next-usage)
              {:content (or (:content assistant) "")
               :steps step :usage next-usage
               :messages (messages ctx)})))))))

(defn- run-agent!
  [ctx config active admission-lock prompt options queue state listeners]
  (let [token (or (:cancel-token options) (cancellation/create-token))
        run-id (str (random-uuid))
        progress (atom {:steps 0 :usage {}})
        ended? (atom false)
        end! (fn [result]
               (when (compare-and-set! ended? false true)
                 (let [terminal (assoc (select-keys result
                                                    [:status :stop-reason :reason :error
                                                     :usage :request-usage :steps :verification :code])
                                       :run-id run-id)]
                   (record! ctx "agent/run/end" terminal)
                   (publish! ctx listeners :agent.run/end terminal))))]
    (cancellation/throw-if-cancelled! token)
    (locking admission-lock
      (when-not (compare-and-set! active nil {:token token :run-id run-id
                                              :accepting-queue? true})
        (throw (ex-info "An agent run is already active" {}))))
    (set-phase! ctx state listeners :model {:run-id run-id :attempt 0
                                           :last-result nil :last-error nil :request-budget nil})
    (try
      (record! ctx "agent/run/start" {:run-id run-id})
      (let [result (outcome/normalize
                    (assoc (binding [generation/*run* (generation/run-budget run-id config)]
                             (run-agent-body! ctx config active admission-lock prompt
                                              options token queue state listeners progress))
                           :run-id run-id :status :completed
                           :request-usage (generation/request-summary ctx run-id)))]
        (end! result)
        (set-phase! ctx state listeners :idle
                    {:run-id nil :attempt nil :last-result result :last-outcome result})
        result)
      (catch Throwable cause
        (let [terminal (merge @progress (outcome/from-error cause)
                              {:run-id run-id :request-usage (generation/request-summary ctx run-id)})
              error (ex-info (ex-message cause) (merge (ex-data cause) terminal) cause)]
          (close-admission! ctx active admission-lock queue listeners
                            (if (:cancelled (ex-data error)) :aborted :error))
          (if (:cancelled (ex-data error))
            (do
              (record! ctx "agent/aborted" {:run-id run-id})
              (publish! ctx listeners :agent/aborted {:run-id run-id}))
            (record! ctx "agent/error"
                     {:run-id run-id :message (ex-message error)}))
          (end! terminal)
          (set-phase! ctx state listeners :idle
                      {:run-id nil :attempt nil :last-error (ex-message error) :last-outcome terminal})
          (throw error)))
      (finally
        (locking admission-lock
          (reset! active nil))))))

(defn- enqueue! [ctx active admission-lock queue listeners kind message]
  (when (blank-content? message)
    (throw (ex-info "Queued message must not be blank" {:kind kind})))
  (locking admission-lock
    (when-not (and @active (:accepting-queue? @active))
      (throw (ex-info "No agent run is accepting queued messages"
                      {:kind kind})))
    (let [item {:id (str (random-uuid)) :kind kind :message message}]
      (swap! queue conj item)
      (record! ctx "queue/added" item)
      (publish! ctx listeners :queue/changed {:queue @queue})
      item)))

(defn- recover-interrupted-runs! [ctx]
  (let [store (kernel/require-service ctx :session/store)
        pending (reduce (fn [runs event]
                          (let [id (get-in event [:data :run-id])]
                            (case (:type event)
                              "agent/run/start" (assoc runs id (:data event))
                              "agent/run/end" (dissoc runs id)
                              runs))) {} ((:events store)))]
    ;; Legacy logs without run envelopes remain readable and are not reclassified.
    (doseq [[id _] pending :when id]
      (record! ctx "agent/run/end"
               (assoc (outcome/normalize {:status :uncertain :reason :restored})
                      :run-id id :usage nil :steps nil)))))

(def plugin
  {:id :agent/default-loop
   :description "Controllable session with deterministic parallel tool batches."
   :requires #{:session/store :llm/generate}
   :provides #{:agent/run :agent/cancel :agent/session}
   :start
   (fn [ctx config]
     (recover-interrupted-runs! ctx)
     (let [active (atom nil)
           admission-lock (Object.)
           queue (atom [])
           listeners (atom {})
           state (atom {:phase :idle :run-id nil :revision 0})
           run (fn
                 ([prompt] (run-agent! ctx config active admission-lock prompt
                                       {} queue state listeners))
                 ([prompt options]
                  (run-agent! ctx config active admission-lock prompt options
                              queue state listeners)))
           abort! (fn []
                    (when-let [{:keys [token]} @active]
                      (cancellation/cancel! token)))
           submit! (fn [message options]
                     (let [result (promise)
                           task (future
                                  (try
                                    (deliver result {:ok true
                                                     :value (run message options)})
                                    (catch Throwable error
                                      (deliver result {:ok false
                                                       :error error}))))]
                       {:task task :result result}))
           session
           {:submit! (fn
                       ([message] (submit! message {}))
                       ([message options] (submit! message options)))
            :steer! #(enqueue! ctx active admission-lock queue listeners
                               :steer %)
            :follow-up! #(enqueue! ctx active admission-lock queue listeners
                                   :follow-up %)
            :abort! abort!
            :state (fn [] @state)
            :system-prompt #(system-prompt ctx config)
            :subscribe!
            (fn [listener]
              (when-not (fn? listener)
                (throw (ex-info "Session listener must be a function" {})))
              (let [id (str (random-uuid))]
                (swap! listeners assoc id listener)
                (fn [] (swap! listeners dissoc id))))}]
       (kernel/on! ctx :llm/stream
                   (fn [_ event]
                     (track-partial! ctx state listeners event)))
       (kernel/register-service! ctx :agent/run run)
       (kernel/register-service! ctx :agent/cancel abort!)
       (kernel/register-service! ctx :agent/session session))
     nil)})
