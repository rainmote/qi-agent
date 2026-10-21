(ns qi.plugins.terminal
  "Session-owned PTY commands with the normal tool/trust/plan/approval gates."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.schema :as schema]))

(def parameters
  {:type "object" :additionalProperties false :required ["action"]
   :properties {:action {:type "string" :enum ["open" "read" "input" "resize" "interrupt" "close"]}
                :terminal_id {:type "string" :maxLength 80}
                :text {:type "string" :maxLength 16384}
                :since {:type "integer" :minimum 0}
                :cols {:type "integer" :minimum 2 :maximum 300}
                :rows {:type "integer" :minimum 2 :maximum 300}}})

;; Transport identity belongs to manual RPCs. Model tool call IDs are owned by
;; the runtime and cannot impersonate a cancelled manual request.
(def manual-parameters
  (assoc-in parameters [:properties :request_id] {:type "string" :maxLength 80}))

(def plugin
  {:id :execution/terminal
   :requires #{:execution/world :remote/registry :tool/policy :project/trust}
   :provides #{:execution/terminal}
   :start
   (fn [ctx _]
     (let [world (kernel/require-service ctx :execution/world)
           registry (kernel/require-service ctx :remote/registry)
           method-disposers (atom [])
           register-method! #(swap! method-disposers conj ((:register! registry) %))
           terminals (atom {}) disposed? (atom false) lock (Object.)
           pending (atom {}) cancelled (atom #{}) admission-closed? (atom false)
           trusted? #(when-let [trust (kernel/service ctx :project/trust)] ((:trusted? trust)))
           status (fn []
                    {:available (boolean (and (not @disposed?) (not @admission-closed?)
                                              (:terminal-controller world) (kernel/service ctx :execution/process-admission)))
                     :trusted (boolean (trusted?)) :sandbox (:sandbox world)
                     :runtime (:workspace-runtime world)
                     :pending_request_ids (vec (keys @pending))
                     :reason (if @admission-closed?
                               "Terminal request admission is closed; inspect or close existing terminals and use a new session."
                               (when-not (:terminal-controller world) (or (get-in world [:terminal-capability :reason])
                                                                         (get-in world [:workspace-runtime :reason]) "No safe terminal runtime is configured.")))
                     :terminals (mapv (fn [[id terminal]] (assoc ((:status terminal)) :id id)) @terminals)})
           close-all! (fn []
                        (let [tasks (mapv #(future ((:close! %))) (vals @terminals))
                              deadline (+ (System/nanoTime) 6000000000)]
                          (mapv #(deref % (max 0 (long (/ (- deadline (System/nanoTime)) 1000000))) ::unknown) tasks)))
           execute
           (fn [{:keys [action terminal_id text since cols rows] :as args} execution]
             (schema/validate! parameters args "Invalid terminal request")
             (when @disposed? (throw (ex-info "Terminal plugin is closed" {})))
             (when (and @admission-closed? (not (contains? #{"read" "close" "interrupt"} action)))
               (throw (ex-info "Terminal request admission is closed; only inspection and cleanup remain available" {})))
             (when-not (contains? #{"close" "interrupt"} action)
               (kernel/require-service ctx :tool/policy)
               (when-not (trusted?)
                 (close-all!)
                 (throw (ex-info "Terminal requires a trusted project; running terminals were asked to close" {}))))
             (cancellation/throw-if-cancelled! (:cancel-token execution))
             (if (= action "open")
               (let [admission (kernel/require-service ctx :execution/process-admission)
                     [id terminal]
                     (locking lock
                       (when @disposed? (throw (ex-info "Terminal plugin is closed" {})))
                       (when (some #(= "unknown" (:status ((:status %)))) (vals @terminals))
                         (throw (ex-info "Existing terminal cleanup is UNKNOWN; inspect and close it before opening another" {:uncertain true})))
                       (when (>= (count (remove #(= "closed" (:status ((:status %)))) (vals @terminals))) 4)
                         (throw (ex-info "At most four PTY terminals may be open in one session" {})))
                       (when (>= (count @terminals) 64)
                         (throw (ex-info "Terminal history limit reached; use a new session" {})))
                       (let [factory (:terminal-controller world)
                             _ (when-not factory (throw (ex-info "Pinned workspace terminal runtime is unavailable" {})))
                             terminal (factory) id (str (random-uuid))]
                         (swap! terminals assoc id terminal)
                         [id terminal]))
                     dispose-cancel (cancellation/on-cancel! (:cancel-token execution) #(future ((:close! terminal))))]
                 (try
                   (let [result ((:start! terminal) (:admit! admission) (or cols 90) (or rows 24))]
                     (cancellation/throw-if-cancelled! (:cancel-token execution))
                     (assoc result :terminal_id id))
                   (catch Throwable error
                     (throw (ex-info (ex-message error) (merge (ex-data error) {:terminal_id id :state ((:status terminal))}) error)))
                   (finally (dispose-cancel))))
               (let [terminal (get @terminals terminal_id)
                     _ (when-not terminal (throw (ex-info "Terminal belongs to another session or no longer exists" {})))
                     dispose-cancel (cancellation/on-cancel! (:cancel-token execution) #(future ((:close! terminal))))]
                 (try
                   (assoc (if (= "close" action)
                            ((:close! terminal))
                            ((:request! terminal)
                             (case action
                               "read" {:op "read" :since (or since 0)}
                               "input" (do (when-not (string? text) (throw (ex-info "Terminal input text required" {}))) {:op "input" :text text})
                               "resize" {:op "resize" :cols (or cols 90) :rows (or rows 24)}
                               "interrupt" {:op "interrupt"}))) :terminal_id terminal_id)
                   (finally (dispose-cancel))))))
           tool {:name "terminal" :description "Open/read/control a session-owned PTY in the existing execution sandbox. No login startup, automatic input retry or host-Python fallback. Unknown cleanup retains its identity."
                 :parameters parameters :requires-trust true :requires-approval true
                 :execution-mode :sequential :uncertain-on-cancel true :stop-batch-on-error true
                 :execute execute}
           gated (fn [args]
                   (schema/validate! manual-parameters args "Invalid terminal request")
                   (if (contains? #{"close" "interrupt"} (:action args))
                     ;; Closing or interrupting cannot start another command;
                     ;; it remains possible after trust/policy revocation.
                     (execute (dissoc args :request_id) {})
                     (let [token (cancellation/create-token)
                           arguments (dissoc args :request_id)
                           _ (kernel/require-service ctx :tool/policy)
                           id (or (:request_id args) (str (random-uuid)))
                           _ (try (java.util.UUID/fromString id) (catch Throwable _ (throw (ex-info "Invalid terminal request identity" {}))))
                           _ (locking lock
                               (when (or @disposed? @admission-closed? (contains? @cancelled id)
                                         (>= (count @pending) 32) (contains? @pending id))
                                 (throw (ex-info "Terminal request was cancelled, is already pending or admission is closed" {})))
                               (swap! pending assoc id token))
                           request {:tool tool :execution {:name "terminal" :arguments arguments :token (str (random-uuid))
                                                           :call-id id :cancel-token token}}]
                       (try
                         (cancellation/throw-if-cancelled! token)
                         (let [gate (kernel/waterfall ctx :tool/pre-execute request #(assoc % :decision :allow))]
                           (when-not (= :allow (:decision gate))
                             (throw (ex-info (or (:reason gate) "Terminal was not approved") {})))
                           (cancellation/throw-if-cancelled! token)
                           (kernel/waterfall ctx :tool/execute gate #(execute arguments (:execution %))))
                         (finally (swap! pending dissoc id))))))
           monitor (future
                     (loop []
                       (when-not @disposed?
                         (when (seq @terminals)
                           (when-not (try (and (trusted?)
                                             (if-let [plan (kernel/service ctx :planning/runtime)]
                                               ((:permitted? plan) "terminal" "input") true))
                                           (catch Throwable _ false)) (close-all!)))
                         (Thread/sleep 200)
                         (recur))))]
       (kernel/register-service! ctx :execution/terminal {:status status :execute! gated :close! close-all!})
       (when (:terminal-controller world) (kernel/register-tool! ctx tool))
       (register-method! {:method "terminal.status" :description "Inspect session-owned terminal capability and cleanup state."
                              :params-schema {:type "object" :properties {} :additionalProperties false} :result-schema {:type "object"}
                              :handler (fn [_] (status))})
       (register-method! {:method "terminal.execute" :description "User terminal control through normal trust, planning and approval gates."
                              :blocking true :params-schema manual-parameters :result-schema {:type "object"} :handler gated})
       (register-method! {:method "terminal.read" :description "Read bounded output from an existing session-owned terminal; never starts a process."
                              :blocking true :params-schema {:type "object" :additionalProperties false :required ["terminal_id"]
                                                             :properties {:terminal_id {:type "string" :maxLength 80} :since {:type "integer" :minimum 0}}}
                              :result-schema {:type "object"} :handler #(execute (assoc % :action "read") {})})
       (register-method! {:method "terminal.stop" :description "Close an owned terminal even after approval, trust or plan revocation. No input or restart."
                              :blocking true :params-schema {:type "object" :additionalProperties false :required ["terminal_id"]
                                                             :properties {:terminal_id {:type "string" :maxLength 80}}}
                              :result-schema {:type "object"} :handler #(execute (assoc % :action "close") {})})
       (register-method! {:method "terminal.cancel" :description "Record cancellation of one queued or pending user terminal request without replay or restart."
                         :params-schema {:type "object" :additionalProperties false :required ["request_id"]
                                         :properties {:request_id {:type "string" :maxLength 80}}}
                         :result-schema {:type "object"}
                         :handler (fn [{:keys [request_id]}]
                                    (try (java.util.UUID/fromString request_id)
                                         (catch Throwable _ (throw (ex-info "Invalid terminal request identity" {}))))
                                    (let [token (locking lock
                                                  ;; A cancellation can overtake a blocking RPC.
                                                  ;; Never evict its identity; close new admission
                                                  ;; at the finite limit, while preserving cleanup.
                                                  (if (or (contains? @cancelled request_id) (< (count @cancelled) 128))
                                                    (swap! cancelled conj request_id)
                                                    (reset! admission-closed? true))
                                                  (get @pending request_id))]
                                      (when token (cancellation/cancel! token))
                                      {:cancelled true :pending (boolean token) :admission_closed @admission-closed?}))})
       (fn []
         (locking lock (reset! disposed? true))
         (doseq [token (vals @pending)] (cancellation/cancel! token))
         (future-cancel monitor)
         (doseq [dispose (reverse @method-disposers)] (dispose))
         (close-all!))))})
