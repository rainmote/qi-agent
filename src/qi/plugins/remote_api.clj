(ns qi.plugins.remote-api
  "Frontend-neutral remote methods exposed by the agent worker."
  (:require [qi.attachments :as attachments]
            [qi.command :as command]
            [qi.kernel :as kernel]
            [clojure.java.io :as io])
  (:import [java.time Instant]))

(def ^:private empty-params
  {:type "object" :additionalProperties false})

(defn- object-params [properties & required]
  (cond-> {:type "object"
           :properties properties
           :additionalProperties false}
    (seq required) (assoc :required (vec required))))

(defn- public-provider [entry]
  (some-> entry (dissoc :generate)))

(defn- public-command-result [command-name result]
  (if-not (= "model" command-name)
    result
    (update result :output
            (fn [output]
              (if (and (map? output) (contains? output :providers))
                (-> output
                    (update :current public-provider)
                    (update :providers #(mapv public-provider %)))
                (public-provider output))))))

(defn- event-time-ms [event]
  (try
    (some-> (:at event) str Instant/parse .toEpochMilli)
    (catch Throwable _ nil)))

(defn- session-lifecycle [events]
  (cond
    (some #(contains? #{"session/archive" :session/archive} (:type %))
          events)
    :archived

    (some #(and (contains? #{"message" :message} (:type %))
                (= "assistant" (some-> % :data :message :role name)))
          events)
    :live

    :else :draft))

(defn- session-last-activity-ms [store events]
  (or (when-let [timestamps (seq (keep event-time-ms events))]
        (apply max timestamps))
      (when-let [path (:path store)]
        (let [file (io/file path)]
          (when (.isFile file) (.lastModified file))))))

(defn- session-summary [ctx]
  (let [store (kernel/require-service ctx :session/store)
        session (kernel/require-service ctx :agent/session)
        events ((:events store))]
    {:session_id (:session-id store)
     :path (:path store)
     :cursor (or (:seq (last events)) 0)
     :lifecycle (session-lifecycle events)
     :activity (if (= :idle (:phase ((:state session)))) :idle :working)
     :last_activity_at_ms (session-last-activity-ms store events)}))

(defn- latest-system-prompt [events]
  (some (fn [event]
          (when (contains? #{"context/snapshot" :context/snapshot}
                           (:type event))
            (get-in event [:data :content])))
        (reverse events)))

(defn- context-status [ctx]
  (when-let [manager (kernel/service ctx :context/manager)]
    (let [store (kernel/require-service ctx :session/store)
          models (kernel/service ctx :llm/registry)
          events ((:events store))
          messages ((:messages store))
          system-prompt (latest-system-prompt events)
          tools (kernel/tool-schemas ctx)
          estimate! (:estimate! manager)
          system-tokens (if (seq system-prompt)
                          (estimate! system-prompt)
                          0)
          tool-tokens (if (seq tools) (estimate! tools) 0)
          message-tokens (if (seq messages) (estimate! messages) 0)
          used-tokens (+ system-tokens tool-tokens message-tokens)
          context-window (or (when models
                               (some-> ((:current models)) :context-window))
                             (:context-window manager))
          percent (if (and (number? context-window) (pos? context-window))
                    (min 100 (long (Math/round
                                    (* 100.0 (/ used-tokens
                                                (double context-window))))))
                    0)]
      {:used_tokens used-tokens
       :context_window context-window
       :percent percent
       :system_tokens system-tokens
       :tool_tokens tool-tokens
       :message_tokens message-tokens})))

(defn- session-snapshot [ctx]
  (let [store (kernel/require-service ctx :session/store)
        session (kernel/require-service ctx :agent/session)
        models (kernel/service ctx :llm/registry)
        interactions (kernel/service ctx :interaction/remote)
        interaction-snapshot (when interactions
                               (if-let [snapshot (:snapshot interactions)]
                                 (snapshot)
                                 {:pending ((:pending interactions))}))
        approval-policy (kernel/service ctx :approval/policy)
        repl (kernel/service ctx :execution/repl)
        subagents (kernel/service ctx :subagents/runtime)
        durable-state (kernel/service ctx :agent/durable-state)]
    {:session_id (:session-id store)
     :path (:path store)
     :cursor (or (:seq (last ((:events store)))) 0)
     :events ((:events store))
     :state ((:state session))
     :models (when models
               {:current (public-provider ((:current models)))
                :providers ((:providers models))})
     :context (context-status ctx)
     :interactions (or (:pending interaction-snapshot) [])
     :interactions_revision (:revision interaction-snapshot)
     :policy (when approval-policy ((:status approval-policy)))
     :trust (when-let [trust (kernel/service ctx :project/trust)]
              (command/trust-info trust))
     :children (if subagents ((:jobs subagents)) [])
     :repl (when repl
             (if-let [status (:status repl)]
               (status)
               (select-keys repl [:backend :sandbox :available? :reason])))
     :durable_state (when durable-state ((:snapshot durable-state)))}))

(defn- received-message [store message-id]
  (when message-id
    (some (fn [event]
            (when (and (= "agent/message/received" (:type event))
                       (= message-id (get-in event [:data :message_id])))
              event))
          (reverse ((:events store))))))

(def plugin
  {:id :remote/api
   :description "Remote session, turn, model, command, and runtime methods."
   :requires #{:remote/registry :session/store :agent/session}
   :start
   (fn [ctx _]
     (let [registry (kernel/require-service ctx :remote/registry)
           store (kernel/require-service ctx :session/store)
           session (kernel/require-service ctx :agent/session)
           tasks (atom #{})
           register!
           (fn [definition]
             (kernel/track-effect! ctx ((:register! registry) definition)))
           method!
           (fn [method description params-schema result-schema handler]
             (register! {:method method
                         :description description
                         :params-schema params-schema
                         :result-schema result-schema
                         :handler handler}))]
       (method! "remote.methods" "Describe every registered remote method."
                empty-params {:type "array"}
                (fn [_] ((:methods registry))))
       (method! "session.snapshot" "Return a replayable session snapshot."
                empty-params {:type "object"}
                (fn [_] (session-snapshot ctx)))
       (method! "session.summary" "Return compact lifecycle and activity metadata."
                empty-params {:type "object"}
                (fn [_] (session-summary ctx)))
       (method! "session.events" "Return durable events after a cursor."
                (object-params {"after" {:type "integer" :minimum 0}})
                {:type "object"}
                (fn [{:keys [after]}]
                  (let [events ((:events-after store) (or after 0))]
                    {:session_id (:session-id store)
                     :after (or after 0)
                     :cursor (or (:seq (last events)) (or after 0))
                     :events events})))
       (method! "session.rename" "Rename the current session."
                (object-params {"name" {:type "string" :minLength 1}}
                               "name")
                {:type "object"}
                (fn [{:keys [name]}]
                  (let [event ((:name! store) name)]
                    (kernel/emit! ctx :session/event event)
                    {:name name :event event})))
       (method! "session.clear" "Clear the active conversation branch."
                empty-params {:type "object"}
                (fn [_]
                  ((:clear! store))
                  (let [event (last ((:events store)))]
                    (kernel/emit! ctx :session/event event)
                    {:cleared true :event event})))
       (method! "session.compact" "Compact old session messages."
                (object-params
                 {"summary" {:type "string"}
                  "retain" {:type "integer" :minimum 1}})
                {:type "object"}
                (fn [params]
                  (let [result ((:compact! store) params)]
                    (when (:compacted result)
                      (kernel/emit! ctx :session/event
                                    (last ((:events store)))))
                    result)))
       (method! "session.tree" "Return the append-only session tree."
                empty-params {:type "array"}
                (fn [_] ((:tree store))))
       (method! "session.fork" "Fork the session to a host-selected destination."
                (object-params
                 {"destination" {:type "string" :minLength 1}}
                 "destination")
                {:type "object"}
                (fn [{:keys [destination]}] ((:fork! store) destination)))
       (method! "turn.submit" "Start an agent turn asynchronously."
                (object-params
                 {"message" attachments/content-schema
                  "request_id" {:type "string" :minLength 1}
                  "options" {:type "object"}}
                 "message")
                {:type "object"}
                (fn [{:keys [message options request_id]}]
                  (attachments/validate-user-content! ctx message)
                  (let [request-id (or request_id (str (random-uuid)))
                        {:keys [task result]}
                        ((:submit! session) message (or options {}))]
                    (swap! tasks conj task)
                    (future
                      (let [{:keys [ok value error]} @result]
                        (kernel/emit!
                         ctx :remote/run-result
                         (if ok
                           {:request_id request-id :ok true :result value}
                           {:request_id request-id :ok false
                            :error {:message (ex-message error)
                                    :data (ex-data error)}}))
                        (swap! tasks disj task)))
                    {:accepted true :request_id request-id})))
       (method! "turn.steer" "Queue steering content for the active turn."
                (object-params {"message" attachments/content-schema}
                               "message")
                {:type "object"}
                (fn [{:keys [message]}] ((:steer! session) (attachments/validate-user-content! ctx message))))
       (method! "turn.follow-up" "Queue a follow-up for the active turn."
                (object-params {"message" attachments/content-schema}
                               "message")
                {:type "object"}
                (fn [{:keys [message]}] ((:follow-up! session) (attachments/validate-user-content! ctx message))))
       (method! "turn.abort" "Abort the active turn and cancel pending interactions."
                empty-params {:type "object"}
                (fn [_]
                  (let [aborted (boolean ((:abort! session)))
                        interaction (kernel/service ctx :interaction/remote)]
                    ;; Direct commands can wait on approval without an active
                    ;; model turn. Stopping must also release that RPC lane.
                    {:aborted aborted
                     :interactions_cancelled (if-let [cancel (:cancel-all! interaction)]
                                               (cancel) 0)})))
       (method! "turn.state" "Return the live agent state."
                empty-params {:type "object"}
                (fn [_] ((:state session))))
       (method! "trust.status" "Read effective project trust before starting work."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [trust (kernel/service ctx :project/trust)]
                    (command/trust-info trust)
                    {:configured false})))
       (method! "model.list" "List available providers and current selection."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [models (kernel/service ctx :llm/registry)]
                    {:current (public-provider ((:current models)))
                     :providers ((:providers models))}
                    {:current nil :providers []})))
       (method! "model.select" "Select the provider used by future turns."
                (object-params {"provider" {:type "string" :minLength 1}}
                               "provider")
                {:type "object"}
                (fn [{:keys [provider]}]
                  (public-provider
                   ((:select! (kernel/require-service ctx :llm/registry))
                    (keyword provider)))))
       (method! "model.thinking.select"
                "Select the reasoning effort used by future turns."
                (object-params {"level" {:type "string" :minLength 1}}
                               "level")
                {:type "object"}
                (fn [{:keys [level]}]
                  (public-provider
                   ((:select-thinking!
                     (kernel/require-service ctx :llm/registry))
                    (keyword level)))))
       (method! "context.status" "Estimate current model context usage."
                empty-params {:type "object"}
                (fn [_] (or (context-status ctx) {})))
       (method! "provider.settings.reload"
                "Reload persistent provider settings into this agent."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [settings (kernel/service ctx :provider/settings)]
                    ((:reload! settings))
                    {:providers 0 :models 0 :available false})))
       (method! "policy.status" "Return the active per-session approval policy."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [policy (kernel/service ctx :approval/policy)]
                    ((:status policy))
                    {:mode :deny :modes []})))
       (method! "policy.select" "Select the per-session approval policy."
                (object-params {"mode" {:type "string"
                                         :enum ["deny" "ask" "allow"]}}
                               "mode")
                {:type "object"}
                (fn [{:keys [mode]}]
                  ((:select! (kernel/require-service ctx :approval/policy))
                   (keyword mode))))
       (method! "command.list" "List shared slash commands."
                empty-params {:type "array"}
                (fn [_] (command/commands ctx)))
       (method! "command.execute" "Execute one shared slash command."
                (object-params {"command" {:type "string" :minLength 1}}
                               "command")
                {:type "object"}
                (fn [{command-text :command}]
                  (let [{:keys [name]} (command/parse command-text)]
                    (when (contains? #{"fork" "quit"} name)
                      (throw (ex-info
                              "This command is unavailable over the remote boundary"
                              {:command name})))
                    (public-command-result
                     name (command/dispatch! ctx command-text)))))
       (method! "runtime.status" "Describe loaded plugins, tools, and resources."
                empty-params {:type "object"}
                (fn [_]
                  (let [resources (kernel/service ctx :resources/catalog)]
                    {:plugins
                     (mapv #(-> (select-keys % [:id :namespace :description])
                                (update :namespace str))
                           (kernel/loaded-plugins ctx))
                     :tools (mapv #(select-keys % [:name :description
                                                   :parameters])
                                  (kernel/tools ctx))
                     :commands (command/commands ctx)
                     :resources
                     (when resources
                       (let [snapshot ((:snapshot resources))]
                         {:context-count (count (:contexts snapshot))
                          :prompt-count (count (:prompts snapshot))
                          :skill-count (count (:skills snapshot))
                          :project-trusted (:project-trusted snapshot)}))})))
       (method! "repl.status" "Return this agent's logical Clojure REPL state."
                empty-params {:type "object"}
                (fn [_]
                  (let [repl (kernel/require-service ctx :execution/repl)]
                    (if-let [status (:status repl)]
                      (status)
                      (select-keys repl [:backend :sandbox :available? :reason])))))
       (method! "repl.eval" "Evaluate code in this agent's persistent REPL."
                (object-params
                 {"code" {:type "string" :minLength 1}
                  "replay_safe" {:type "boolean"}}
                 "code")
                {:type "object"}
                (fn [{:keys [code replay_safe]}]
                  (let [repl (kernel/require-service ctx :execution/repl)]
                    (when (= false (:available? repl))
                      (throw (ex-info (or (:reason repl) "REPL is unavailable")
                                      {})))
                    ((:eval! repl) {:code code :replay-safe replay_safe}))))
       (method! "repl.interrupt" "Interrupt the active REPL evaluation."
                (object-params {"eval_id" {:type "string"}})
                {:type "object"}
                (fn [{:keys [eval_id]}]
                  (let [repl (kernel/require-service ctx :execution/repl)]
                    {:interrupted (boolean ((:interrupt! repl) eval_id))})))
       (method! "repl.reset" "Restart only this agent's REPL namespace."
                empty-params {:type "object"}
                (fn [_]
                  ((:reset! (kernel/require-service ctx :execution/repl)) {})))
       (method! "repl.describe" "Describe REPL backend and recovery semantics."
                empty-params {:type "object"}
                (fn [_]
                  (let [repl (kernel/require-service ctx :execution/repl)]
                    (if-let [describe (:describe repl)]
                      (describe)
                      (select-keys repl [:backend :sandbox :available? :reason])))))
       (method! "state.snapshot" "Return this agent's explicit durable state."
                empty-params {:type "object"}
                (fn [_]
                  ((:snapshot (kernel/require-service
                               ctx :agent/durable-state)))))
       (method! "state.get" "Read one key from explicit durable state."
                (object-params {"key" {}} "key") {}
                (fn [{:keys [key]}]
                  {:key key
                   :value ((:get (kernel/require-service
                                  ctx :agent/durable-state)) key)}))
       (method! "state.put" "Persist one key in explicit durable state."
                (object-params {"key" {} "value" {}} "key" "value") {}
                (fn [{:keys [key value]}]
                  ((:put! (kernel/require-service ctx :agent/durable-state))
                   key value)
                  {:key key :value value :persisted true}))
       (method! "state.delete" "Delete one key from explicit durable state."
                (object-params {"key" {}} "key") {:type "object"}
                (fn [{:keys [key]}]
                  {:key key
                   :deleted ((:delete! (kernel/require-service
                                        ctx :agent/durable-state)) key)}))
       (method! "subagent.status" "List subagent providers and jobs."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [subagents (kernel/service ctx :subagents/runtime)]
                    {:providers ((:providers subagents))
                     :jobs ((:jobs subagents))
                     :tombstones ((:tombstones subagents))}
                    {:providers [] :jobs []})))
       (method! "agent.message.send" "Send a durable message to a retained child."
                (object-params {"to" {:type "string" :minLength 1}
                                "message" {:type "string" :minLength 1}
                                "from" {:type "string" :minLength 1}
                                "message_id" {:type "string" :minLength 1}}
                               "to" "message")
                {:type "object"}
                (fn [{:keys [to message] :as params}]
                  ((:send! (kernel/require-service ctx :subagents/runtime))
                   to (cond-> {:message message}
                        (:from params) (assoc :from (:from params))
                        (:message_id params) (assoc :message_id
                                                    (:message_id params))))))
       (method! "agent.message.receive"
                "Persist a daemon-routed inbox message before dispatch."
                (object-params {"from" {:type "string" :minLength 1}
                                "message" {:type "string" :minLength 1}
                                "message_id" {:type "string" :minLength 1}}
                               "from" "message" "message_id")
                {:type "object"}
                (fn [{:keys [from message message_id]}]
                  (if-let [event (received-message store message_id)]
                    {:accepted true :duplicate true :message_id message_id
                     :inbox_event_id (:id event)}
                    (let [event ((:append! store) "agent/message/received"
                                 {:from from :message message
                                  :message_id message_id})
                          phase (:phase ((:state session)))]
                      (try
                        (if (= :idle phase)
                          (let [{:keys [task result]} ((:submit! session) message)]
                            (swap! tasks conj task)
                            (future
                              (try @result
                                   (finally (swap! tasks disj task))))
                            {:accepted true :dispatched true
                             :message_id message_id
                             :inbox_event_id (:id event)})
                          (do
                            ((:follow-up! session) message)
                            {:accepted true :queued true
                             :message_id message_id
                             :inbox_event_id (:id event)}))
                        (catch Throwable error
                          ((:append! store) "agent/message/dispatch-failed"
                           {:from from :message_id message_id
                            :error (ex-message error)})
                          {:accepted true :dispatched false
                           :message_id message_id
                           :inbox_event_id (:id event)
                           :error (ex-message error)}))))))
       (method! "agent.message.record_sent"
                "Record a daemon-routed message in the sender session."
                (object-params {"to" {:type "string" :minLength 1}
                                "message" {:type "string" :minLength 1}
                                "message_id" {:type "string" :minLength 1}}
                               "to" "message" "message_id")
                {:type "object"}
                (fn [{:keys [to message message_id]}]
                  (let [event ((:append! store) "agent/message/sent"
                               {:to to :message message
                                :message_id message_id})]
                    {:recorded true :message_id message_id
                     :event_id (:id event)})))
       (method! "subagent.stop" "Stop a retained child context."
                (object-params {"agent_id" {:type "string" :minLength 1}}
                               "agent_id")
                {:type "object"}
                (fn [{:keys [agent_id]}]
                  {:agent_id agent_id
                   :stopped ((:stop! (kernel/require-service
                                      ctx :subagents/runtime)) agent_id)}))
       (method! "subagent.passivate" "Release an idle retained child runtime."
                (object-params {"agent_id" {:type "string" :minLength 1}}
                               "agent_id")
                {:type "object"}
                (fn [{:keys [agent_id]}]
                  {:agent_id agent_id
                   :passivated ((:passivate! (kernel/require-service
                                              ctx :subagents/runtime))
                                 agent_id)}))
       (method! "subagent.delete" "Delete child routing and retain a tombstone."
                (object-params {"agent_id" {:type "string" :minLength 1}}
                               "agent_id")
                {:type "object"}
                (fn [{:keys [agent_id]}]
                  {:tombstone ((:delete! (kernel/require-service
                                          ctx :subagents/runtime)) agent_id)}))
       (method! "subagent.invoke" "Invoke a scoped method on a retained child."
                (object-params {"agent_id" {:type "string" :minLength 1}
                                "method" {:type "string" :minLength 1}
                                "params" {:type "object"}}
                               "agent_id" "method")
                {}
                (fn [{:keys [agent_id method params]}]
                  ((:invoke! (kernel/require-service ctx :subagents/runtime))
                   agent_id method (or params {}))))
       (fn []
         ((:abort! session))
         (doseq [task @tasks] (deref task 1000 nil)))))})
