(ns qi.protocol
  "Versioned JSON event and stdin/stdout RPC projections."
  (:require [qi.kernel :as kernel]
            [cheshire.core :as json]
            [clojure.string :as str]))

(def protocol-version 1)

(defn- event-name [event]
  (if (keyword? event)
    (str (namespace event) "/" (name event))
    (str event)))

(defn- write-json! [value]
  (locking *out*
    (println (json/generate-string (assoc value :version protocol-version)))
    (flush)))

(defn- write-event!
  ([session-id event data] (write-event! session-id nil event data))
  ([session-id agent-id event data]
   (let [envelope
         (if (= :session/event event)
           {:type "event"
            :session_id session-id
            :seq (:seq data)
            :event_id (:id data)
            :run_id (or (:run-id data)
                        (:run_id data)
                        (get-in data [:data :run-id])
                        (get-in data [:data :run_id]))
            :event (event-name (:type data))
            :durable true
            :at (:at data)
            :data (:data data)}
           {:type "event"
            :session_id session-id
            :run_id (or (:run-id data) (:run_id data))
            :event (event-name event)
            :durable false
            :at (str (java.time.Instant/now))
            :data (if (= event (:type data)) (dissoc data :type) data)})]
     (write-json! (cond-> envelope agent-id (assoc :agent_id agent-id))))))

(defn subscribe-json! [ctx]
  (let [plugin-ctx (kernel/begin-plugin! ctx :protocol/json {:phase :active})
        session (kernel/require-service ctx :agent/session)
        store (kernel/require-service ctx :session/store)
        session-id (:session-id store)
        dispose-session
        ((:subscribe! session)
         (fn [event]
           (write-event! session-id (:type event) event)))]
    (doseq [event [:session/event :llm/stream :tool.execution/confirming
                   :tool.execution/start :tool.execution/update
                   :tool.execution/end
                   :approval/event :context/compacted
                   :context/compaction-fallback
                   :interaction/request :interaction/resolved
                   :remote/run-result :llm/model-selected
                   :automation/request
                   :repl/restarted
                   :subagent/provider-added :subagent/provider-removed
                   :subagent/start :subagent/end :subagent/event]]
      (kernel/on! plugin-ctx event
                  (fn [_ data]
                    (if (= :subagent/event event)
                      (write-event! (:session-id data) (:agent-id data)
                                    (:event data) (:data data))
                      (write-event! session-id event data)))))
    (fn []
      (dispose-session)
      (kernel/dispose-plugin! ctx :protocol/json {:generation (:plugin/generation plugin-ctx)}))))

(defn json-once! [ctx prompt]
  (let [dispose (subscribe-json! ctx)]
    (try
      (let [result ((kernel/require-service ctx :agent/run) prompt)]
        (write-json! {:type "result" :ok true :result result})
        result)
      (catch Throwable error
        (write-json! {:type "result" :ok false
                      :error {:message (ex-message error)
                              :data (ex-data error)}})
        (throw error))
      (finally (dispose)))))

(defn- rpc-response! [id result]
  (write-json! {:type "response" :id id :ok true :result result}))

(defn- rpc-error! [id error]
  (write-json! {:type "response" :id id :ok false
                :error {:message (ex-message error) :data (ex-data error)}}))

(defn- blocking-rpc? [method params]
  (or (contains? #{"repl.eval" "repl.reset" "session.compact" "command.execute"} method)
      (and (= "subagent.invoke" method)
           (blocking-rpc? (:method params) (:params params)))))

(defn- process-admission! [ctx]
    (let [owner (kernel/begin-plugin! ctx :protocol/process-admission {:phase :active})
          pending (atom {})
          closed? (atom false)]
      (kernel/register-service!
       owner :execution/process-admission
       {:admit! (fn [pid]
                  (when @closed? (throw (ex-info "Process admission is closed" {})))
                  (let [id (str (random-uuid)) result (promise)]
                    (swap! pending assoc id result)
                    (try
                      (write-json! {:type "process-admit" :id id :pid pid})
                      (when-not (= true (deref result 2000 ::unconfirmed))
                        (throw (ex-info "Native process admission was not confirmed; no PTY shell was started" {:uncertain true})))
                      true
                      (finally (swap! pending dissoc id)))))
        :resolve! (fn [params]
                    ;; A separate unguessable one-use request identity stays on
                    ;; the private worker stdio only. No capability is placed
                    ;; in an environment inherited by model REPL processes.
                    (when-not (and (boolean? (:admitted params)) (contains? @pending (:id params)))
                      (throw (ex-info "Invalid private process acknowledgement" {})))
                    (when-let [result (get @pending (:id params))]
                      (deliver result (:admitted params)))
                    {:accepted true})})
      (fn [] (reset! closed? true)
        (doseq [result (vals @pending)] (deliver result false))
        (reset! pending {})
        (kernel/dispose-plugin! ctx :protocol/process-admission {:generation (:plugin/generation owner)}))))

(defn rpc! [ctx]
  (let [session (kernel/require-service ctx :agent/session)
        store (kernel/require-service ctx :session/store)
        dispose (subscribe-json! ctx)
        dispose-admission (process-admission! ctx)
        tasks (atom #{})]
    (write-json! {:type "ready"
                  :session_id (:session-id store)
                  :methods (when-let [registry
                                      (kernel/service ctx :remote/registry)]
                             (mapv :method ((:methods registry))))})
    (try
      (loop []
        (when-let [line (read-line)]
          (let [shutdown? (atom false)]
            (when-not (str/blank? line)
              (let [{:keys [id method params] :as request}
                    (try
                      (json/parse-string line true)
                      (catch Throwable _
                        ;; Parser diagnostics can quote the input buffer,
                        ;; including a partially written private process ACK.
                        (rpc-error! nil (ex-info "Invalid RPC JSON" {:invalid-json true}))
                        nil))]
                (when request
                  (try
                    (let [registry (kernel/service ctx :remote/registry)]
                      (cond
                        (= "native.process-result" method)
                        (rpc-response! id ((:resolve! (kernel/require-service ctx :execution/process-admission)) params))

                        (= "shutdown" method)
                        (do
                          (reset! shutdown? true)
                          (rpc-response! id {:shutting-down true})
                          ((:abort! session)))

                        (and registry ((:method registry) method))
                        (if (or (blocking-rpc? method params)
                                (true? (:blocking ((:method registry) method))))
                          (let [task
                                (future
                                  (try
                                    (rpc-response!
                                     id ((:invoke! registry) method params))
                                    (catch Throwable error
                                      (rpc-error! id error))))]
                            (swap! tasks conj task)
                            (future
                              @task
                              (swap! tasks disj task)))
                          (rpc-response! id ((:invoke! registry) method params)))

                        (= "prompt" method)
                        (let [{:keys [task result]}
                              ((:submit! session) (:message params)
                               (or (:options params) {}))]
                          (swap! tasks conj task)
                          (rpc-response! id {:accepted true})
                          (future
                            (let [{:keys [ok value error]} @result]
                              (if ok
                                (write-json! {:type "run-result"
                                              :request-id id :ok true
                                              :result value})
                                (write-json! {:type "run-result"
                                              :request-id id :ok false
                                              :error
                                              {:message (ex-message error)
                                               :data (ex-data error)}}))
                              (swap! tasks disj task))))

                        (= "steer" method)
                        (rpc-response! id ((:steer! session)
                                           (:message params)))
                        (= "follow-up" method)
                        (rpc-response! id ((:follow-up! session)
                                           (:message params)))
                        (= "abort" method)
                        (rpc-response! id ((:abort! session)))
                        (= "state" method)
                        (rpc-response! id ((:state session)))
                        (= "clear" method)
                        (do ((:clear! store))
                            (rpc-response! id {:cleared true}))
                        (= "compact" method)
                        (rpc-response! id ((:compact! store) (or params {})))
                        (= "sessions" method)
                        (if-let [catalog (kernel/service ctx :session/catalog)]
                          (rpc-response! id ((:list catalog)))
                          (rpc-response! id []))
                        (= "providers" method)
                        (if-let [models (kernel/service ctx :llm/registry)]
                          (rpc-response! id
                                         {:current (some-> ((:current models))
                                                           (dissoc :generate))
                                          :providers ((:providers models))})
                          (rpc-response! id nil))
                        (= "select-provider" method)
                        (rpc-response!
                         id
                         (dissoc
                          ((:select! (kernel/require-service
                                      ctx :llm/registry))
                           (keyword (:provider params)))
                          :generate))
                        (= "reload" method)
                        (rpc-response!
                         id
                         ((:reload! (kernel/require-service
                                     ctx :resources/catalog))))
                        :else
                        (throw (ex-info "Unknown RPC method"
                                        {:method method}))))
                    (catch Throwable error
                      (rpc-error! id error))))))
            (when-not @shutdown? (recur)))))
      (finally
        (when dispose-admission (dispose-admission))
        ((:abort! session))
        (doseq [task @tasks] (deref task 1000 nil))
        (dispose)))))
