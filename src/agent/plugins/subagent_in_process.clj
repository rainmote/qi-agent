(ns agent.plugins.subagent-in-process
  "Isolated in-process spawn/fork providers for the subagent runtime."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.plugin :as plugin]
            [agent.schema :as schema]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.time Instant]))

(def ^:private default-allowed-tools
  #{"current_time" "read" "read_file" "ls" "find" "grep" "load_skill"})

(def ^:private bridged-events
  [:session/event :llm/stream :tool.execution/confirming
   :tool.execution/start :tool.execution/update :tool.execution/end
   :approval/event :context/compacted :context/compaction-fallback
   :interaction/request :interaction/resolved :remote/run-result
   :llm/model-selected :repl/restarted :subagent/provider-added
   :subagent/provider-removed :subagent/start :subagent/end])

(defn- effective-messages [events]
  (reduce
   (fn [messages event]
     (case (:type event)
       "message" (conj messages (get-in event [:data :message]))
       "session/clear" []
       "session/compaction" (vec (get-in event
                                           [:data :replacement_messages]))
       messages))
   [] events))

(defn- completed-parent-messages [parent-ctx]
  (if-let [store (and parent-ctx
                      (kernel/service parent-ctx :session/store))]
    (let [events (vec ((:events store)))
          boundary (last (keep-indexed
                          (fn [index event]
                            (when (= "step/end" (:type event)) index))
                          events))
          completed (if (some? boundary)
                      (subvec events 0 (inc boundary))
                      [])
          ;; A clear or compaction may happen between runs. Preserve those
          ;; checkpoints while excluding messages from the currently open turn.
          later-checkpoints
          (->> (if (some? boundary)
                 (subvec events (inc boundary))
                 events)
               (filter #(contains? #{"session/clear" "session/compaction"}
                                    (:type %))))]
      (effective-messages (concat completed later-checkpoints)))
    []))

(defn- seed! [child messages]
  (let [store (kernel/require-service child :session/store)]
    (doseq [message messages]
      ((:append! store) "message" {:message message}))))

(defn- final-output [child]
  (or (some (fn [message]
              (when (= "assistant" (:role message)) (:content message)))
            (reverse ((:messages
                       (kernel/require-service child :session/store)))))
      ""))

(defn- effective-tool-filter [base requested]
  (let [base (set base)
        requested (when requested (set requested))
        outside (seq (remove base requested))]
    (when outside
      (throw (ex-info "Subagent tool filter cannot expand provider permissions"
                      {:requested requested
                       :allowed base
                       :disallowed (set outside)})))
    (or requested base)))

(defn- inherit-parent-resources! [child parent]
  (when-let [resources (and parent
                            (kernel/service parent :resources/catalog))]
    (let [bridge (kernel/plugin-context child :subagent/parent-resources)]
      (when-not (kernel/service child :resources/catalog)
        ;; The catalog switches atomically and exposes read-only skill access,
        ;; so a child can share it without rescanning or bypassing parent trust.
        (kernel/register-service! bridge :resources/catalog resources))
      (when (and (kernel/tool parent "load_skill")
                 (nil? (kernel/tool child "load_skill")))
        (kernel/register-tool! bridge (kernel/tool parent "load_skill")))
      (kernel/mark-loaded!
       child
       {:id :subagent/parent-resources
        :namespace 'agent.plugins.subagent-in-process
        :description "Inherited read-only skill catalog from the parent."}))))

(defn- install-boundary! [child {:keys [tool-filter persona output-schema]}]
  (let [boundary (kernel/plugin-context child :subagent/child-boundary)
        schema-text (when output-schema (json/generate-string output-schema))
        extra-prompt
        (str
         (when-not (str/blank? persona)
           (str "\n\nSubagent persona:\n" persona))
         (when schema-text
           (str "\n\nReturn only one JSON value matching this schema. "
                "Do not wrap it in Markdown fences:\n" schema-text)))]
    (kernel/intercept!
     boundary :llm/request -100
     (fn [_ request next]
       (next (cond-> (update request :tools
                             (fn [tools]
                               (filterv #(contains?
                                          tool-filter
                                          (get-in % [:function :name]))
                                        tools)))
               (not (str/blank? extra-prompt))
               (update :system-prompt str extra-prompt)))))
    (kernel/intercept!
     boundary :tool/pre-execute -100
     (fn [_ request next]
       (if (contains? tool-filter (get-in request [:execution :name]))
         (next request)
         (assoc request :decision :deny
                        :reason "Tool is outside the subagent read-only boundary"))))
    (kernel/mark-loaded! child
                         {:id :subagent/child-boundary
                          :namespace 'agent.plugins.subagent-in-process
                          :description "Per-child persona, schema, and tool boundary."})))

(defn- install-event-bridge! [child parent agent-id]
  (when parent
    (let [bridge (kernel/plugin-context child :subagent/event-bridge)
          session (kernel/require-service child :agent/session)
          store (kernel/require-service child :session/store)
          session-id (:session-id store)
          forward! (fn [event data]
                     (kernel/emit! parent :subagent/event
                                   {:agent-id agent-id
                                    :session-id session-id
                                    :event event
                                    :data data}))]
      (kernel/track-effect!
       bridge
       ((:subscribe! session) #(forward! (:type %) %)))
      (doseq [event bridged-events]
        (kernel/on! bridge event (fn [_ data] (forward! event data))))
      (kernel/mark-loaded!
       child
       {:id :subagent/event-bridge
        :namespace 'agent.plugins.subagent-in-process
        :description "Route child events through the owning worker."}))))

(defn- structured-output [output output-schema]
  (when output-schema
    (let [value (json/parse-string output true)]
      (schema/validate! output-schema value
                        "Subagent output did not match the requested schema")
      value)))

(defn- child-session-path [request agent-id]
  (or (:session-path request)
      (when-let [parent-path
                 (some-> (:parent-context request)
                         (kernel/service :session/store)
                         :path)]
        (str (io/file (.getParentFile (io/file parent-path))
                      (str "child-" agent-id ".jsonl"))))))

(defn- configure-child-profile [profile agent-id session-path]
  (let [configure
        (fn [spec]
          (case (:ns spec)
            agent.plugins.session
            (cond-> (update spec :config #(merge % {:ephemeral false}))
              session-path (assoc-in [:config :path] session-path))

            agent.plugins.durable-state
            (assoc-in spec [:config :agent-id] agent-id)

            agent.plugins.bb-repl
            (assoc-in spec [:config :agent-id] agent-id)

            agent.plugins.jvm-clojure-repl
            (assoc-in spec [:config :agent-id] agent-id)

            spec))
        plugins (mapv configure (:plugins profile))
        namespaces (set (map :ns plugins))
        plugins (cond-> plugins
                  (not (contains? namespaces 'agent.plugins.durable-state))
                  (conj {:ns 'agent.plugins.durable-state
                         :config {:root "." :agent-id agent-id}})

                  (not (or (contains? namespaces 'agent.plugins.bb-repl)
                           (contains? namespaces
                                      'agent.plugins.jvm-clojure-repl)))
                  (conj {:ns 'agent.plugins.bb-repl
                         :config {:root "." :sandbox :auto
                                  :agent-id agent-id}}))]
    (assoc profile :plugins plugins)))

(defn- child-run-result [result]
  (let [completion (promise)]
    (future
      (let [{:keys [ok value error]} @result]
        (deliver completion
                 (if ok
                   {:output (:content value)
                    :stop-reason :completed
                    :usage (:usage value)
                    :steps (:steps value)}
                   {:output ""
                    :stop-reason :error
                    :error (ex-message error)
                    :details (ex-data error)}))))
    completion))

(defn- received-message [store message-id]
  (when message-id
    (some (fn [event]
            (when (and (= "agent/message/received" (:type event))
                       (= message-id (get-in event [:data :message_id])))
              event))
          (reverse ((:events store))))))

(defn- event-time-ms [event]
  (try
    (some-> (:at event) str Instant/parse .toEpochMilli)
    (catch Throwable _ nil)))

(defn- child-session-summary [child]
  (let [store (kernel/require-service child :session/store)
        session (kernel/require-service child :agent/session)
        events ((:events store))]
    {:session_id (:session-id store)
     :path (:path store)
     :cursor (or (:seq (last events)) 0)
     :lifecycle (if (some #(contains? #{"message" :message} (:type %))
                           events)
                  :live
                  :draft)
     :activity (if (= :idle (:phase ((:state session)))) :idle :working)
     :last_activity_at_ms
     (or (when-let [timestamps (seq (keep event-time-ms events))]
           (apply max timestamps))
         (when-let [path (:path store)]
           (let [file (io/file path)]
             (when (.isFile file) (.lastModified file)))))}))

(defn- receive-child-message! [child agent-id payload]
  (let [{:keys [from message message_id]}
        (if (map? payload) payload {:message payload})
        store (kernel/require-service child :session/store)
        session (kernel/require-service child :agent/session)]
    (when (str/blank? message)
      (throw (ex-info "Agent message must not be blank" {:agent-id agent-id})))
    (if-let [event (received-message store message_id)]
      {:accepted true :duplicate true :queued true
       :message_id message_id :inbox_event_id (:id event)}
      (let [phase (:phase ((:state session)))
            inbox-event ((:append! store) "agent/message/received"
                         (cond-> {:to agent-id :message message}
                           from (assoc :from from)
                           message_id (assoc :message_id message_id)))]
        (if (= :idle phase)
          (let [{:keys [task result]} ((:submit! session) message)]
            {:accepted true
             :message_id message_id
             :inbox_event_id (:id inbox-event)
             :task task
             :result (child-run-result result)})
          (do
            ((:follow-up! session) message)
            {:accepted true
             :message_id message_id
             :queued true
             :inbox_event_id (:id inbox-event)}))))))

(defn- start-child
  [child-profile mode allowed-tools request]
  (let [agent-id (:agent-id request)
        session-path (child-session-path request agent-id)
        child-profile (configure-child-profile child-profile agent-id session-path)
        child-token (cancellation/create-token)
        detach-parent (if-let [parent-token (:cancel-token request)]
                        (cancellation/on-cancel!
                         parent-token #(cancellation/cancel! child-token))
                        (fn []))
        child-holder (atom nil)
        ready (promise)
        result (promise)
        message-lock (Object.)
        disposed? (atom false)
        cancel! #(cancellation/cancel! child-token)
        dispose! (fn []
                   (when (compare-and-set! disposed? false true)
                     (cancel!)
                     (detach-parent)
                     (when-let [child @child-holder]
                       (kernel/dispose-all! child))))
        task
        (future
          (try
            (let [child (plugin/boot! child-profile)
                  tools (effective-tool-filter allowed-tools
                                               (:tool-filter request))]
              (reset! child-holder child)
              (when @disposed?
                (kernel/dispose-all! child)
                (cancellation/throw-if-cancelled! child-token))
              (when (= :fork mode)
                (seed! child (completed-parent-messages
                              (:parent-context request))))
              (inherit-parent-resources! child (:parent-context request))
              (install-boundary! child
                                 {:tool-filter tools
                                  :persona (:persona request)
                                  :output-schema (:output-schema request)})
              (install-event-bridge! child (:parent-context request) agent-id)
              (deliver ready child)
              (if (:restore request)
                (deliver result (or (:result request)
                                    {:output "" :stop-reason :restored}))
                (let [run (kernel/require-service child :agent/run)
                      value (run (:prompt request)
                                 {:cancel-token child-token
                                  :max-steps (:max-steps request)
                                  :model-options (:model-options request)})
                      output (:content value)]
                  (deliver result
                           (cond-> {:output output
                                    :stop-reason :completed
                                    :usage (:usage value)
                                    :steps (:steps value)}
                             (:output-schema request)
                             (assoc :structured
                                    (structured-output
                                     output (:output-schema request))))))))
            (catch Throwable error
              (deliver ready error)
              (let [aborted? (or (:cancelled (ex-data error))
                                 (cancellation/cancelled? child-token))]
                (deliver result
                         {:output (if-let [child @child-holder]
                                    (final-output child)
                                    "")
                          :stop-reason (if aborted? :aborted :error)
                          :error (ex-message error)
                          :details (ex-data error)})))
            (finally
              (detach-parent)
              (when (and @disposed? @child-holder)
                (kernel/dispose-all! @child-holder)))))]
    {:result result
     :task task
     :agent-id agent-id
     :session-path session-path
     :cancel! cancel!
     :dispose! dispose!
     :invoke!
     (fn [method params]
       (let [child (deref ready 30000 ::timeout)]
         (when (= ::timeout child)
           (throw (ex-info "Subagent context is still starting"
                           {:agent-id agent-id})))
         (when (instance? Throwable child) (throw child))
         (case method
           "repl.status"
           ((:status (kernel/require-service child :execution/repl)))
           "repl.eval"
           ((:eval! (kernel/require-service child :execution/repl)) params)
           "repl.interrupt"
           {:interrupted
            ((:interrupt! (kernel/require-service child :execution/repl))
             (or (:eval_id params) (:eval-id params)))}
           "repl.reset"
           ((:reset! (kernel/require-service child :execution/repl)) params)
           "repl.describe"
           ((:describe (kernel/require-service child :execution/repl)))
           "state.snapshot"
           ((:snapshot (kernel/require-service child :agent/durable-state)))
           "state.put"
           (let [{:keys [key value]} params]
             ((:put! (kernel/require-service child :agent/durable-state)) key value)
             {:key key :value value :persisted true})
           "agent.message.receive"
           (dissoc (receive-child-message! child agent-id params) :task :result)
           "agent.message.record_sent"
           (let [store (kernel/require-service child :session/store)
                 event ((:append! store) "agent/message/sent" params)]
             {:recorded true :message_id (:message_id params)
              :event_id (:id event)})
           "session.snapshot"
           (let [store (kernel/require-service child :session/store)
                 session (kernel/require-service child :agent/session)]
             {:session_id (:session-id store)
              :path (:path store)
              :cursor (or (:seq (last ((:events store)))) 0)
              :events ((:events store))
              :state ((:state session))
              :repl ((:status (kernel/require-service
                               child :execution/repl)))})
           "session.summary"
           (child-session-summary child)
           (throw (ex-info "Unsupported retained child method"
                           {:agent-id agent-id :method method})))))
     :message!
     (fn [message]
       (locking message-lock
         (let [child (deref ready 30000 ::timeout)]
           (when (= ::timeout child)
             (throw (ex-info "Subagent context is still starting"
                             {:agent-id agent-id})))
           (when (instance? Throwable child) (throw child))
           (receive-child-message! child agent-id message))))}))

(def plugin
  {:id :subagent/in-process
   :description "Spawn and safe-fork subagents in isolated plugin contexts."
   :requires #{:subagents/runtime}
   :start
   (fn [ctx {:keys [child-profile allowed-tools max-depth providers]
             :or {allowed-tools default-allowed-tools
                  max-depth 1
                  providers [{:id :spawn :mode :spawn}
                             {:id :fork :mode :fork}]}}]
     (when-not (and (map? child-profile) (seq (:plugins child-profile)))
       (throw (ex-info "In-process subagents require a non-empty child profile"
                       {})))
     (when-not (and (pos-int? max-depth) (= 1 max-depth))
       (throw (ex-info
               "The in-process provider currently supports max-depth 1"
               {:max-depth max-depth})))
     (let [runtime (kernel/require-service ctx :subagents/runtime)
           allowed-tools (set allowed-tools)]
       (doseq [{:keys [id mode]} providers]
         (when-not (contains? #{:spawn :fork} mode)
           (throw (ex-info "Unknown in-process subagent mode"
                           {:provider id :mode mode})))
         (kernel/track-effect!
          ctx
          ((:register! runtime)
           {:id id
            :kind :in-process
            :mode mode
            :capabilities {:output-schema true
                           :persona true
                           :tool-filter true
                           :retained true
                           :durable-inbox true
                           :max-depth max-depth}
            :start #(start-child child-profile mode allowed-tools %)
            :restore #(start-child child-profile mode allowed-tools
                                   (assoc % :agent-id (:id %)
                                            :restore true
                                            :parent-context ctx))}))))
     nil)})
