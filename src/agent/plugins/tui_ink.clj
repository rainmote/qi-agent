(ns agent.plugins.tui-ink
  "External TUI process bridge (Ratatui by default, Ink-compatible).

  The child process owns the terminal. Its stdin/stdout are reserved for a
  versioned, line-delimited JSON protocol, so this plugin never rebinds or
  consumes the worker's global stdin/stdout."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.protocol :as protocol]
            [agent.schema :as schema]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.lang ProcessBuilder ProcessBuilder$Redirect]
           [java.nio.charset StandardCharsets]
           [java.time Instant]
           [java.util.concurrent TimeUnit]))

(def ^:private decisions #{:allow :allow-session :deny})

;; Runtime publishes model deltas twice: as raw :llm/stream kernel events and as
;; the accumulated :agent/state delivered by the session subscription. Ink uses
;; only the latter as its canonical streaming text source, otherwise one model
;; delta is appended once and then observed again in the complete partial text.
(def ^:private live-events
  [:session/event :tool.execution/confirming :tool.execution/start
   :tool.execution/update :tool.execution/end
   :approval/event :context/compacted :context/compaction-fallback
   :interaction/request :interaction/resolved :remote/run-result
   :llm/model-selected :subagent/provider-added :subagent/provider-removed
   :subagent/start :subagent/end :ui/extensions :ui/run-error])

(def ^:private empty-params
  {:type "object" :additionalProperties false})

(def ^:private public-prompt-keys
  [:title :message :items :options :default :value :placeholder :lines :model
   :schema :required?])

(defn- event-name [event]
  (if (keyword? event)
    (str (namespace event) "/" (name event))
    (str event)))

(defn- durable-envelope [session-id event]
  {:type "event"
   :session_id session-id
   :seq (:seq event)
   :event_id (:id event)
   :run_id (or (:run-id event)
               (:run_id event)
               (get-in event [:data :run-id])
               (get-in event [:data :run_id]))
   :event (event-name (:type event))
   :durable true
   :at (:at event)
   :data (:data event)})

(defn- live-envelope [session-id event data]
  {:type "event"
   :session_id session-id
   :run_id (or (:run-id data) (:run_id data))
   :event (event-name event)
   :durable false
   :at (str (Instant/now))
   :data (if (= event (:type data)) (dissoc data :type) data)})

(defn- write-json! [writer value]
  (locking writer
    (.write ^java.io.Writer writer
            (json/generate-string
             (assoc value :version protocol/protocol-version)))
    (.write ^java.io.Writer writer "\n")
    (.flush ^java.io.Writer writer))
  true)

(defn- error-data [error]
  {:message (or (ex-message error) (str error))
   :data (ex-data error)})

(defn- response [id result]
  {:type "response" :id id :ok true :result result})

(defn- error-response [id error]
  {:type "response" :id id :ok false :error (error-data error)})

(defn- normalize-command [{:keys [command entrypoint]}]
  (let [command (or command
                    (when entrypoint ["node" entrypoint])
                    ["apps/tui-rs/target/release/bb-agent-tui"])]
    (when-not (and (sequential? command)
                   (seq command)
                   (every? #(and (string? %) (not (str/blank? %))) command))
      (throw (ex-info "TUI :command must be a non-empty argv vector"
                      {:command command})))
    (vec command)))

(defn- start-process! [{:keys [cwd env] :as config}]
  (when-not (or (nil? env) (map? env))
    (throw (ex-info "TUI :env must be a map" {:env env})))
  (let [command (normalize-command config)
        builder (ProcessBuilder. ^java.util.List command)]
    (when cwd
      (let [directory (.getCanonicalFile (io/file cwd))]
        (when-not (.isDirectory directory)
          (throw (ex-info "TUI :cwd must be a directory"
                          {:cwd (str directory)})))
        (.directory builder directory)))
    ;; Child-only defaults keep Ink on its production renderer and preserve
    ;; Qwen's 256-color palette even when the host shell exports NO_COLOR.
    ;; Explicit plugin :env entries are applied afterwards and remain
    ;; authoritative for development and diagnostics.
    (.remove (.environment builder) "NO_COLOR")
    (.put (.environment builder) "TERM" "xterm-256color")
    (.put (.environment builder) "FORCE_COLOR" "1")
    (.put (.environment builder) "NODE_ENV" "production")
    (doseq [[key value] env]
      (.put (.environment builder) (str key) (str value)))
    ;; stdout is protocol output; only diagnostics may reach the host terminal.
    (.redirectError builder ProcessBuilder$Redirect/INHERIT)
    (.start builder)))

(defn- stop-process! [^Process process timeout-ms]
  (try (.close (.getOutputStream process)) (catch Throwable _))
  (try (.close (.getInputStream process)) (catch Throwable _))
  (when (.isAlive process)
    (.destroy process)
    (when-not (.waitFor process timeout-ms TimeUnit/MILLISECONDS)
      (.destroyForcibly process)
      (.waitFor process timeout-ms TimeUnit/MILLISECONDS)))
  nil)

(defn- normalize-outcome [outcome]
  (let [next-session (or (:next-session outcome) (:next_session outcome)
                         (get outcome "next-session")
                         (get outcome "next_session"))
        next-provider (or (:next-provider outcome) (:next_provider outcome)
                          (get outcome "next-provider")
                          (get outcome "next_provider"))]
    (cond-> {}
      (some? next-session) (assoc :next-session next-session)
      (some? next-provider)
      (assoc :next-provider
             (if (keyword? next-provider)
               next-provider
               (keyword (str next-provider)))))))

(defn- json-key [value]
  (cond
    (string? value) value
    (keyword? value) (subs (str value) 1)
    (symbol? value) (str value)
    (or (number? value) (boolean? value) (char? value)) (str value)
    (nil? value) "null"
    :else (str "[host-key:" (.getName (class value)) "]")))

(defn- class-name [value]
  (if (nil? value) "nil" (.getName (class value))))

(declare json-safe-value)

(defn- json-safe-number [value]
  (try
    (json/generate-string value)
    value
    (catch Throwable _ (str value))))

(defn- json-safe-map [value depth]
  (into
   (sorted-map)
   (map (fn [[key item]]
          [(json-key key) (json-safe-value item (inc depth))]))
   ;; Normalized JSON keys can collide (for example, :mode and "mode"). The
   ;; class tie-break makes the surviving value stable across map iterations.
   (sort-by (fn [[key _]] [(json-key key) (class-name key)]) value)))

(defn- json-safe-sequence [value depth]
  (let [limit 512
        projected (mapv #(json-safe-value % (inc depth))
                        (take (inc limit) value))]
    (if (> (count projected) limit)
      (conj (subvec projected 0 limit) "[truncated]")
      projected)))

(defn- json-safe-value
  ([value] (json-safe-value value 0))
  ([value depth]
   (cond
     (> depth 24) "[maximum projection depth reached]"
     (nil? value) nil
     (or (string? value) (boolean? value)) value
     (number? value) (json-safe-number value)
     (keyword? value) value
     (symbol? value) (str value)
     (char? value) (str value)
     (fn? value) "[host function unavailable]"
     (map? value) (json-safe-map value depth)
     (set? value) (->> value
                       (map #(json-safe-value % (inc depth)))
                       (sort-by json/generate-string)
                       vec)
     (sequential? value) (json-safe-sequence value depth)
     (instance? java.util.UUID value) (str value)
     (instance? java.time.temporal.TemporalAccessor value) (str value)
     :else (str "[host value unavailable:" (.getName (class value)) "]"))))

(defn- public-shortcuts [shortcuts]
  (reduce-kv
   (fn [result id options]
     (assoc result (json-key id)
            (cond-> {:host-invokable true}
              (contains? options :description)
              (assoc :description
                     (json-safe-value (:description options))))))
   (sorted-map) shortcuts))

(defn- public-registry [registry]
  (reduce-kv (fn [result id value]
               (assoc result (json-key id) (json-safe-value value)))
             (sorted-map) registry))

(defn- registry-service [ctx send-event! initial-theme]
  (let [state (atom {:message-renderers {} :entry-renderers {}
                     :tool-renderers {} :shortcuts {} :statuses {}
                     :widgets {}})
        theme (atom initial-theme)
        registration-order (atom 0)
        effective
        (fn [bucket]
          (reduce (fn [result [[_ id] registration]]
                    (assoc result id (:value registration)))
                  {}
                  (sort-by (comp :order val) (get @state bucket))))
        registries
        (fn [] {:message-renderers (effective :message-renderers)
                :entry-renderers (effective :entry-renderers)
                :tool-renderers (effective :tool-renderers)
                :shortcuts (effective :shortcuts)
                :statuses (effective :statuses)
                :widgets (effective :widgets)})
        snapshot
        (fn []
          (let [{:keys [shortcuts statuses widgets]} (registries)]
            {:registries {:shortcuts (public-shortcuts shortcuts)
                          :statuses (public-registry statuses)
                          :widgets (public-registry widgets)}
             :theme (json-safe-value @theme)}))
        changed!
        (fn [reason]
          (send-event! {:kind :snapshot
                        :reason reason
                        :snapshot (snapshot)}))
        register!
        (fn [bucket owner id value visible?]
          (let [key [owner id]
                active? (atom true)]
            (swap! state assoc-in [bucket key]
                   {:order (swap! registration-order inc) :value value})
            (when visible? (changed! :registered))
            (fn []
              (when (compare-and-set! active? true false)
                (swap! state update bucket dissoc key)
                (when visible? (changed! :unregistered))))))]
    {:registries registries
     :register-message-renderer!
     #(register! :message-renderers %1 %2 %3 false)
     :register-entry-renderer!
     #(register! :entry-renderers %1 %2 %3 false)
     :register-tool-renderer!
     #(register! :tool-renderers %1 %2 %3 false)
     :register-shortcut!
     #(register! :shortcuts %1 %2 %3 true)
     :set-status!
     #(register! :statuses %1 %2 {:value %3} true)
     :set-widget!
     #(register! :widgets %1 %2 {:value %3 :options %4} true)
     :notify!
     (fn [notification]
       (send-event! {:kind :notification :notification notification}))
     :set-theme!
     (fn [next-theme]
       (reset! theme next-theme)
       (changed! :theme)
       next-theme)
     :snapshot snapshot}))

(defn- register-method! [ctx registry definition]
  (kernel/track-effect! ctx ((:register! registry) definition)))

(defn- deny-pending! [pending]
  (let [entries (vals (swap! pending (constantly {})))]
    (doseq [{:keys [completion approval?]} entries]
      (deliver completion (when approval? :deny))))
  nil)

(defn- decision-value [value]
  (cond
    (keyword? value) value
    (string? value) (keyword value)
    :else nil))

(defn- approval-request? [kind request]
  (let [values (map (comp decision-value :value) (:items request))]
    (and (= :select kind)
         (seq values)
         (every? decisions values))))

(defn- public-prompt [kind id request]
  (let [projected (assoc (select-keys request public-prompt-keys)
                         :id id
                         :kind kind
                         :created-at (str (Instant/now)))]
    (try
      ;; Fail before installing a pending request rather than silently losing an
      ;; event because a custom prompt accidentally contains a JVM value.
      (json/generate-string projected)
      projected
      (catch Throwable error
        (throw (ex-info "TUI prompt is not JSON serializable"
                        {:kind kind} error))))))

(defn- option-values [request]
  (let [options (or (when (and (sequential? (:items request))
                               (seq (:items request)))
                      (:items request))
                    (when (and (sequential? (:options request))
                               (seq (:options request)))
                      (:options request)))]
    (mapv #(if (map? %) (:value %) %) options)))

(defn- json-value-key [value]
  (json/generate-string value))

(defn- validate-prompt-value! [{:keys [kind request]} value]
  ;; Values arriving over JSON are already serializable. This explicit check
  ;; also protects direct in-process calls to the registry service.
  (try
    (json-value-key value)
    (catch Throwable error
      (throw (ex-info "Prompt result must be JSON serializable" {} error))))
  (let [options (option-values request)
        value
        (cond
          (contains? #{:select :confirm} kind)
          (if (seq options)
            (let [matches (filter #(= (json-value-key value)
                                      (json-value-key %))
                                  options)]
              (when-not (seq matches)
                (throw (ex-info "Prompt result is not a declared option"
                                {:kind kind :value value})))
              ;; Preserve keywords and other host-side values represented as
              ;; strings or JSON objects on the wire.
              (first matches))
            value)

          (= :input kind)
          (do
            (when-not (string? value)
              (throw (ex-info "Input prompt result must be a string"
                              {:value value})))
            value)

          :else value)]
    (when-let [value-schema (:schema request)]
      (schema/validate! value-schema value "Invalid prompt result"))
    value))

(defn- timeout-value [{:keys [approval? request]}]
  (cond
    approval? (if (contains? request :default) (:default request) :deny)
    (contains? request :default) (:default request)
    :else nil))

(defn- await-tasks! [tasks timeout-ms]
  (let [deadline (+ (System/nanoTime) (* 1000000 timeout-ms))]
    (doseq [task (vec @tasks)]
      (let [remaining-ms (max 0
                              (quot (- deadline (System/nanoTime)) 1000000))]
        (when (pos? remaining-ms)
          (deref task remaining-ms ::timeout))))
    (doseq [task (vec @tasks)]
      (when-not (future-done? task)
        (future-cancel task))))
  nil)

(defn- process-request! [registry writer tasks close-reader! line]
  (let [request
        (try
          (json/parse-string line true)
          (catch Throwable error
            (write-json! writer (error-response nil error))
            nil))]
    (when request
      (let [{:keys [type id method params]} request]
        (try
          (when-not (= "request" type)
            (throw (ex-info "Expected a request envelope" {:type type})))
          (when-not (and (string? method) (not (str/blank? method)))
            (throw (ex-info "Request method must be a non-empty string" {})))
          ;; A remote method may synchronously open a UI prompt. Run every
          ;; invocation off the sole stdout reader so its resolve request can be
          ;; consumed concurrently and responses may complete out of order.
          (let [start (promise)
                task-ref (atom nil)
                task
                (future
                  @start
                  (try
                    (let [result ((:invoke! registry) method (or params {}))]
                      (write-json! writer (response id result))
                      ;; frontend.exit has now flushed its response. Closing the
                      ;; reader wakes a loop otherwise blocked waiting for a
                      ;; child that is itself waiting for that response.
                      (when (= "frontend.exit" method)
                        (close-reader!)))
                    (catch Throwable error
                      (try
                        (write-json! writer (error-response id error))
                        (catch Throwable _)))
                    (finally
                      (swap! tasks disj @task-ref))))]
            (reset! task-ref task)
            (swap! tasks conj task)
            (deliver start true))
          (catch Throwable error
            (write-json! writer (error-response id error))))))))

(defn- run-process!
  [ctx config registry store session active-run pending extensions-snapshot]
  (let [timeout-ms (or (:shutdown-timeout-ms config) 1000)]
    (when-not (pos-int? timeout-ms)
      (throw (ex-info ":shutdown-timeout-ms must be a positive integer"
                      {:shutdown-timeout-ms timeout-ms})))
    (locking active-run
      (when @active-run
        (throw (ex-info "The TUI is already running" {})))
      (let [process (start-process! config)
            writer (io/writer (.getOutputStream process)
                              :encoding (.name StandardCharsets/UTF_8))
            reader (io/reader (.getInputStream process)
                              :encoding (.name StandardCharsets/UTF_8))
            exit? (atom false)
            outcome (atom nil)
            ready? (atom false)
            pre-ready (atom [])
            tasks (atom #{})
            run-state {:process process :writer writer :reader reader
                       :exit? exit? :outcome outcome :pending pending
                       :ready? ready? :pre-ready pre-ready :tasks tasks}]
        (try
          ;; Publish the run before ready so concurrent events are buffered, then
          ;; hold the writer lock through ready + buffer drain. Ready is always
          ;; the first frame without creating an event-loss window.
          (reset! active-run run-state)
          (locking writer
            (write-json!
             writer
             {:type "ready"
              :session_id (:session-id store)
              :methods (mapv :method ((:methods registry)))})
            (reset! ready? true)
            (doseq [message (swap! pre-ready (constantly []))]
              (write-json! writer message)))
          (write-json!
           writer
           (live-envelope (:session-id store) :ui/extensions
                          {:kind :snapshot
                           :reason :ready
                           :snapshot (extensions-snapshot)}))
          (try
            (loop []
              (when-not @exit?
                (if-let [line (.readLine ^java.io.BufferedReader reader)]
                  (do
                    (when-not (str/blank? line)
                      (process-request!
                       registry writer tasks
                       #(try (.close ^java.io.Reader reader)
                             (catch Throwable _))
                       line))
                    (when-not @exit? (recur)))
                  nil)))
            (catch Throwable error
              (when-not @exit? (throw error))))
          (let [requested? @exit?
                result @outcome]
            (when-not requested?
              (.waitFor process timeout-ms TimeUnit/MILLISECONDS))
            (if requested?
              result
              (if (and (not (.isAlive process)) (zero? (.exitValue process)))
                nil
                (throw (ex-info "TUI process exited unexpectedly"
                                {:command (normalize-command config)
                                 :exit-code (when-not (.isAlive process)
                                              (.exitValue process))})))))
          (finally
            (deny-pending! (:pending run-state))
            ((:abort! session))
            (await-tasks! tasks timeout-ms)
            ;; A handler racing with shutdown may have opened a prompt after the
            ;; first drain but before cancellation took effect.
            (deny-pending! (:pending run-state))
            (compare-and-set! active-run run-state nil)
            (try (.close ^java.io.Reader reader) (catch Throwable _))
            (try (.close ^java.io.Writer writer) (catch Throwable _))
            (stop-process! process timeout-ms)))))))

(def plugin
  {:id :frontend/tui-ink
   :description "Qwen-style Ratatui/Ink child process and JSON-RPC bridge."
   :requires #{:agent/session :session/store :remote/registry}
   :provides #{:frontend/interactive :ui/prompt :interaction/remote
               :ui/extensions}
   :start
   (fn [ctx config]
     (let [registry (kernel/require-service ctx :remote/registry)
           session (kernel/require-service ctx :agent/session)
           store (kernel/require-service ctx :session/store)
           active-run (atom nil)
           pending (atom {})
           timeout-ms (or (:interaction-timeout-ms config)
                          (:timeout-ms config)
                          300000)
           send!
           (fn [message]
             (when-let [{:keys [writer ready? pre-ready]} @active-run]
               (try
                 (locking writer
                   (if @ready?
                     (write-json! writer message)
                     (swap! pre-ready conj message)))
                 (catch Throwable _ false))))
           send-live!
           (fn [event data]
             (send! (live-envelope (:session-id store) event data)))
           extension-service
           (registry-service ctx #(send-live! :ui/extensions %)
                             (:theme config))
           request!
           (fn [kind prompt]
             (when-not (:writer @active-run)
               (throw (ex-info "The TUI prompt service is not active" {})))
             (let [id (str (random-uuid))
                   completion (promise)
                   approval? (approval-request? kind prompt)
                   public-request (public-prompt kind id prompt)
                   entry {:kind kind
                          :request prompt
                          :public-request public-request
                          :approval? approval?
                          :completion completion}]
               (swap! pending assoc id entry)
               (kernel/emit! ctx :interaction/request public-request)
               (let [dispose-cancel
                     (cancellation/on-cancel!
                      (:cancel-token prompt)
                      #(deliver completion ::cancelled))]
                 (try
                   (let [resolved (deref completion timeout-ms ::timeout)
                         cancelled? (= ::cancelled resolved)
                         timed-out? (= ::timeout resolved)
                         result (cond
                                  cancelled? (when approval? :deny)
                                  timed-out? (timeout-value entry)
                                  :else resolved)]
                     (kernel/emit! ctx :interaction/resolved
                                   (cond-> {:id id :kind kind
                                            :value result
                                            :cancelled (or cancelled?
                                                           (nil? result))
                                            :timed-out timed-out?}
                                     approval? (assoc :decision result)))
                     result)
                   (finally
                     (dispose-cancel)
                     (swap! pending dissoc id))))))
           select! #(request! :select %)
           confirm!
           #(request! :confirm
                      (merge {:items [{:label "Yes" :value true}
                                      {:label "No" :value false}]
                              :default false}
                             %))
           input! #(request! :input %)
           custom! #(request! :custom %)
           resolve-approval!
           (fn [id decision]
             (let [decision (keyword decision)
                   entry (get @pending id)]
               (when-not (contains? decisions decision)
                 (throw (ex-info "Invalid interaction decision"
                                 {:decision decision})))
               (when-not entry
                 (throw (ex-info "Interaction is not pending" {:id id})))
               (when-not (:approval? entry)
                 (throw (ex-info
                         "interaction.resolve only accepts approval prompts"
                         {:id id :kind (:kind entry)})))
               (let [value (validate-prompt-value! entry decision)]
                 (deliver (:completion entry) value)
                 {:id id :decision value :resolved true})))
           resolve-prompt!
           (fn [{:keys [id value cancelled] :as params}]
             (let [entry (get @pending id)]
               (when-not entry
                 (throw (ex-info "Interaction is not pending" {:id id})))
               (when (:approval? entry)
                 (throw (ex-info
                         "Approval prompts require interaction.resolve"
                         {:id id})))
               (when (and (true? cancelled) (contains? params :value))
                 (throw (ex-info
                         "A cancelled prompt must not include a value"
                         {:id id})))
               (when (and (true? cancelled)
                          (get-in entry [:request :required?]))
                 (throw (ex-info "This prompt cannot be cancelled" {:id id})))
               (when-not (or (true? cancelled) (contains? params :value))
                 (throw (ex-info
                         "Prompt resolution requires value or cancelled=true"
                         {:id id})))
               (let [result (when-not (true? cancelled)
                              (validate-prompt-value! entry value))]
                 (deliver (:completion entry) result)
                 {:id id :kind (:kind entry) :value result
                  :cancelled (true? cancelled) :resolved true})))
           interaction-service
           {:pending #(->> @pending vals (mapv :public-request))
            :resolve! resolve-approval!
            :resolve-prompt! resolve-prompt!}
           prompt-service
           {:active? #(boolean (:writer @active-run))
            :select! select!
            :confirm! confirm!
            :input! input!
            :custom! custom!}
           register!
           (fn [definition] (register-method! ctx registry definition))]
       (when-not (pos-int? timeout-ms)
         (throw (ex-info "TUI interaction timeout must be positive"
                         {:timeout-ms timeout-ms})))
       (register!
        {:method "interaction.list"
         :description "List unresolved user interactions."
         :params-schema empty-params
         :result-schema {:type "array"}
         :handler (fn [_] ((:pending interaction-service)))})
       (register!
        {:method "interaction.resolve"
         :description "Resolve a pending approval interaction."
         :params-schema
         {:type "object" :required ["id" "decision"]
          :properties
          {"id" {:type "string"}
           "decision" {:type "string"
                       :enum ["allow" "allow-session" "deny"]}}
          :additionalProperties false}
         :result-schema {:type "object"}
         :handler (fn [{:keys [id decision]}]
                    (resolve-approval! id decision))})
       (register!
        {:method "ui.prompt.resolve"
         :description
         "Resolve or cancel a non-approval UI prompt using its declared schema."
         :params-schema
         {:type "object" :required ["id"]
          :properties
          {"id" {:type "string"}
           ;; An empty schema deliberately permits any JSON value. The handler
           ;; applies the stronger kind/options/request schema constraints.
           "value" {}
           "cancelled" {:type "boolean"}}
          :additionalProperties false}
         :result-schema {:type "object"}
         :handler resolve-prompt!})
       (register!
        {:method "ui.shortcut.invoke"
         :description "Invoke one currently registered host UI shortcut."
         :params-schema
         {:type "object" :required ["shortcut"]
          :properties {"shortcut" {:type "string" :minLength 1}}
          :additionalProperties false}
         :result-schema {:type "object"}
         :handler
         (fn [{:keys [shortcut]}]
           (let [definition (get-in ((:registries extension-service))
                                    [:shortcuts shortcut])
                 handler (:handler definition)]
             (when-not (fn? handler)
               (throw (ex-info "UI shortcut is not registered"
                               {:shortcut shortcut})))
             (try
               (handler {:context ctx
                         :frontend :tui-ink
                         :shortcut shortcut})
               {:shortcut shortcut :invoked true}
               (catch Throwable error
                 (let [failure {:shortcut shortcut
                                :message (or (ex-message error) (str error))}]
                   (kernel/emit! ctx :ui/run-error failure)
                   {:shortcut shortcut :invoked false
                    :error {:message (:message failure)}})))))})
       (register!
        {:method "frontend.exit"
         :description "Exit the TUI frontend and optionally select a session."
         :params-schema
         {:type "object"
          :properties {"outcome" {:type "object"}}
          :additionalProperties false}
         :result-schema {:type "object"}
         :handler
         (fn [{:keys [outcome]}]
           (let [{:keys [exit?] outcome-atom :outcome :as run} @active-run]
             (when-not run
               (throw (ex-info "The TUI is not running" {})))
             (let [normalized (when (seq outcome)
                                (normalize-outcome outcome))]
               (reset! outcome-atom normalized)
               (reset! exit? true)
               {:exiting true :outcome normalized})))})
       (kernel/register-service! ctx :ui/extensions extension-service)
       (kernel/register-service! ctx :ui/prompt prompt-service)
       (kernel/register-service! ctx :interaction/remote interaction-service)
       (kernel/register-service!
        ctx :frontend/interactive
        {:run!
         #(run-process! ctx config registry store session active-run
                        pending (:snapshot extension-service))})
       (let [dispose-session
             ((:subscribe! session)
              (fn [event]
                (send! (live-envelope (:session-id store)
                                      (:type event) event))))]
         (kernel/track-effect! ctx dispose-session))
       (doseq [event live-events]
         (kernel/on!
          ctx event
          (fn [_ data]
            (send! (if (= :session/event event)
                     (durable-envelope (:session-id store) data)
                     (live-envelope (:session-id store) event data))))))
       (fn []
         (deny-pending! pending)
         ((:abort! session))
         (when-let [{:keys [process tasks]} @active-run]
           (let [timeout-ms (or (:shutdown-timeout-ms config) 1000)]
             (stop-process! process timeout-ms)
             (await-tasks! tasks timeout-ms))))))})
