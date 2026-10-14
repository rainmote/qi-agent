(ns qi.plugins.subagent-tools
  "Model-facing adapters for delegation and subagent task control."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.run-outcome :as outcome]))

(def ^:private start-parameters
  {:type "object"
   :required ["prompt"]
   :properties
   {"prompt" {:type "string" :minLength 1}
    "description" {:type "string"}
    "persona" {:type "string"}
    "tool_filter" {:type "array" :items {:type "string"}
                   :uniqueItems true}
    "output_schema" {:type "object"}
    "run_in_background" {:type "boolean"}
    "max_steps" {:type "integer" :minimum 1}}
   :additionalProperties false})

(defn- completed! [runtime run-id result]
  (when-not (outcome/successful? result)
    (throw (ex-info "Subagent did not complete successfully" result)))
  result)

(defn- start-tool [ctx runtime {:keys [name provider mode description]}]
  {:name name
   :description description
   :parameters start-parameters
   :execute
   (fn [{:keys [prompt persona tool_filter output_schema run_in_background
                max_steps]
         label :description}
        execution]
     (let [job ((:start! runtime)
                {:provider provider
                 :prompt prompt
                 :label label
                 :persona persona
                 :tool-filter tool_filter
                 :output-schema output_schema
                 :max-steps max_steps
                 :parent-depth 0
                 :parent-context ctx
                 :cancel-token (:cancel-token execution)})
           run-id (:id job)]
       (if run_in_background
         {:id run-id
          :provider provider
          :mode mode
          :status :running
          :description (:label job)}
         (let [detach (cancellation/on-cancel!
                       (:cancel-token execution)
                       #((:interrupt! runtime) run-id))]
           (try
             (completed! runtime run-id ((:wait! runtime) run-id))
             (finally (detach)))))))})

(defn- list-tool [runtime]
  {:name "list_agents"
   :description "List running and completed background subagent tasks."
   :parameters {:type "object" :additionalProperties false}
   :execute (fn [_ _] {:agents ((:jobs runtime))
                       :tombstones ((:tombstones runtime))})})

(defn- wait-tool [runtime]
  {:name "wait_agent"
   :description "Wait for a background subagent and collect its result."
   :parameters {:type "object"
                :required ["id"]
                :properties {"id" {:type "string"}
                             "timeout_ms" {:type "integer" :minimum 0}}
                :additionalProperties false}
   :execute
   (fn [{:keys [id timeout_ms]} _]
     (let [result ((:wait! runtime) id timeout_ms)]
       (if (= :running (:status result))
         result
         result)))})

(defn- interrupt-tool [runtime]
  {:name "interrupt_agent"
   :description "Cooperatively interrupt a running background subagent."
   :parameters {:type "object"
                :required ["id"]
                :properties {"id" {:type "string"}}
                :additionalProperties false}
   :execute (fn [{:keys [id]} _]
              {:id id :interrupted ((:interrupt! runtime) id)})})

(defn- send-tool [runtime]
  {:name "send_agent"
   :description "Send a durable follow-up message to a retained child agent."
   :parameters {:type "object"
                :required ["id" "message"]
                :properties {"id" {:type "string"}
                             "message" {:type "string" :minLength 1}}
                :additionalProperties false}
   :execute (fn [{:keys [id message]} _] ((:send! runtime) id message))})

(defn- stop-tool [runtime]
  {:name "stop_agent"
   :description "Stop a retained child while preserving its transcript."
   :parameters {:type "object" :required ["id"]
                :properties {"id" {:type "string"}}
                :additionalProperties false}
   :execute (fn [{:keys [id]} _] {:id id :stopped ((:stop! runtime) id)})})

(defn- delete-tool [runtime]
  {:name "delete_agent"
   :description "Remove child routing and write a durable tombstone."
   :parameters {:type "object" :required ["id"]
                :properties {"id" {:type "string"}}
                :additionalProperties false}
   :execute (fn [{:keys [id]} _] {:tombstone ((:delete! runtime) id)})})

(def plugin
  {:id :subagent/tools
   :description "Delegation, background collection, listing, and interruption tools."
   :requires #{:subagents/runtime}
   :start
   (fn [ctx {:keys [delegates]
             :or {delegates
                  [{:name "delegate_task"
                    :provider :spawn
                    :mode :spawn
                    :description
                    "Delegate an independent task to an isolated subagent. Sibling calls may run concurrently."}
                   {:name "fork_agent"
                    :provider :fork
                    :mode :fork
                    :description
                    "Fork completed conversation turns into an isolated subagent, then run a task."}]}}]
     (let [runtime (kernel/require-service ctx :subagents/runtime)]
       (doseq [delegate delegates]
         (when-not ((:provider runtime) (:provider delegate))
           (throw (ex-info "Delegate tool references an unknown provider"
                           {:tool (:name delegate)
                            :provider (:provider delegate)})))
         (kernel/register-tool! ctx (start-tool ctx runtime delegate)))
       (kernel/register-tool! ctx (list-tool runtime))
       (kernel/register-tool! ctx (wait-tool runtime))
       (kernel/register-tool! ctx (interrupt-tool runtime))
       (kernel/register-tool! ctx (send-tool runtime))
       (kernel/register-tool! ctx (stop-tool runtime))
       (kernel/register-tool! ctx (delete-tool runtime)))
     nil)})
