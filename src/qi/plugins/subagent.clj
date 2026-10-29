(ns qi.plugins.subagent
  "Provider-neutral subagent registry and run lifecycle."
  (:require [qi.kernel :as kernel]
            [qi.generation :as generation]
            [qi.run-outcome :as outcome]
            [qi.secure-files :as secure]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(defn- provider-id [value]
  (cond
    (keyword? value) value
    (and (string? value) (not (str/blank? value))) (keyword value)
    :else value))

(defn- public-provider [provider]
  (dissoc provider :start :restore))

(defn- public-job [job]
  (-> job
      (assoc :resident (boolean (:handle job)))
      (dissoc :handle :completion :parent-context)
      (update :provider provider-id)))

(defn- record-run! [ctx store phase result]
  (when-let [append! (:append! store)]
    (let [event (append! (str "subagent/run/" (name phase))
                         (select-keys result [:id :run-id :root-run-id :execution-run-id :provider :depth
                                              :status :stop-reason :reason :error :usage :steps :verification]))]
      (kernel/emit! ctx :session/event event)
      (when (= :end phase)
        (generation/record-provider! ctx
          (assoc result :root-run-id (or (:root-run-id result) (:root-run-id generation/*run*)))
          (:status result))))))

(defn- roster-path [ctx]
  (let [store (kernel/service ctx :session/store)
        session-file (some-> (:path store) io/file .getCanonicalFile)
        sessions-dir (some-> session-file .getParentFile)
        metadata-dir (some-> sessions-dir .getParentFile)]
    (when (and metadata-dir
               (contains? #{".qi-agent" ".bb-agent"} (.getName metadata-dir)))
      (str (io/file metadata-dir "artifacts" (:session-id store)
                    "children.edn")))))

(defn- load-roster [path]
  (if-not (and path (.isFile (io/file path)))
    {:children [] :tombstones []}
    (try
      (let [value (edn/read-string (slurp path))]
        (if (map? value) value {:children [] :tombstones []}))
      (catch Throwable _ {:children [] :tombstones []}))))

(defn- write-roster! [path jobs tombstones]
  (when path
    (let [target (io/file path)
          parent (.getParentFile target)]
      (.mkdirs parent)
      (secure/protect-managed-parents! parent)
      (let [temporary (java.io.File/createTempFile ".children-" ".edn" parent)]
        (try
          (secure/protect-file! temporary)
          (spit temporary
                (str (pr-str {:version 1
                              :children (mapv public-job (vals jobs))
                              :tombstones (vec tombstones)})
                     "\n"))
          (java.nio.file.Files/move
           (.toPath temporary) (.toPath target)
           (into-array java.nio.file.CopyOption
                       [java.nio.file.StandardCopyOption/REPLACE_EXISTING]))
          (secure/protect-file! target)
          (finally
            (when (.exists temporary) (.delete temporary))))))))

(defn- requested-capabilities [request]
  (cond-> []
    (:output-schema request) (conj :output-schema)
    (:persona request) (conj :persona)
    (:tool-filter request) (conj :tool-filter)))

(defn- validate-request! [provider request]
  (when (str/blank? (:prompt request))
    (throw (ex-info "Subagent prompt must not be blank" {})))
  (doseq [capability (requested-capabilities request)]
    (when-not (true? (get-in provider [:capabilities capability]))
      (throw (ex-info "Subagent provider does not support requested capability"
                      {:provider (:id provider)
                       :capability capability}))))
  (let [parent-depth (or (:parent-depth request) 0)
        next-depth (inc parent-depth)
        provider-limit (get-in provider [:capabilities :max-depth])
        requested-limit (:max-depth request)
        limit (cond
                (and provider-limit requested-limit)
                (min provider-limit requested-limit)

                provider-limit provider-limit
                requested-limit requested-limit
                :else nil)]
    (when-not (and (int? parent-depth) (not (neg? parent-depth)))
      (throw (ex-info "Subagent parent depth must be a non-negative integer"
                      {:parent-depth parent-depth})))
    (when (and limit (> next-depth limit))
      (throw (ex-info "Subagent delegation depth limit exceeded"
                      {:provider (:id provider)
                       :depth next-depth
                       :max-depth limit})))
    (assoc request :depth next-depth :max-depth limit)))

(def plugin
  {:id :subagent/runtime
   :description "Named subagent provider registry with bounded run lifecycle."
   :provides #{:subagents/runtime}
   :start
   (fn [ctx _]
     (let [providers (atom {})
           path (roster-path ctx)
           loaded (load-roster path)
           tombstones (atom (vec (:tombstones loaded)))
           jobs
           (atom
            (into {}
                  (map (fn [job]
                         (let [completion (promise)
                               interrupted? (= :running (:status job))
                               result (when (or interrupted? (:result job))
                                        (outcome/normalize
                                         (if interrupted?
                                           {:status :uncertain :reason :restored
                                            :run-id (:run-id job)}
                                           (:result job))))
                               status (cond
                                        interrupted? :uncertain
                                        (and result (contains? #{:completed :failed :cancelled :uncertain}
                                                               (:status job))) (:status result)
                                        :else (:status job))
                               restored (assoc job
                                               :provider (provider-id (:provider job))
                                               :status status
                                               :result result
                                               :handle nil
                                               :completion completion)]
                           (deliver completion
                                    (or (:result restored)
                                        {:id (:id restored) :status status}))
                           [(:id restored) restored])))
                  (:children loaded)))
           store (kernel/service ctx :session/store)
           persist! #(locking jobs (write-roster! path @jobs @tombstones))
           complete!
           (fn [agent-id provider depth run-id completion result]
             (let [completed-at (System/currentTimeMillis)
                   completed (cond-> (assoc (outcome/normalize result)
                                    :id agent-id
                                    :agent_id agent-id
                                    :run-id run-id
                                    :provider provider
                                    :depth depth)
                               (:run-id result) (assoc :execution-run-id (:run-id result)))
                   [before _]
                   (swap-vals! jobs
                               (fn [current]
                                 (if (and (identical? completion
                                                      (get-in current [agent-id :completion]))
                                          (= :running (get-in current [agent-id :status])))
                                   (update current agent-id assoc
                                           :status (:status completed)
                                           :completed-at completed-at
                                           :result completed)
                                   current)))
                   current-run? (and (identical? completion
                                                (get-in before [agent-id :completion]))
                                     (= :running (get-in before [agent-id :status])))]
               (when current-run?
                 (persist!)
                 (record-run! ctx store :end completed))
               ;; A retained child's next run may start before this watcher is
               ;; scheduled. Resolve old waiters without overwriting the new run.
               (when (or current-run?
                         (not (identical? completion (get-in before [agent-id :completion]))))
                 (deliver completion completed))
               (when current-run?
                 (kernel/emit! ctx :subagent/end completed))))
           watch!
           (fn [agent-id provider depth run-id completion result]
             (future
               (let [value
                     (try
                       @result
                       (catch Throwable error
                         {:output ""
                          :stop-reason :error
                          :error (ex-message error)
                          :details (ex-data error)}))]
                 (complete! agent-id provider depth run-id completion value))))
           register!
           (fn [{:keys [id start restore capabilities] :as provider}]
             (let [id (provider-id id)
                   provider (assoc provider :id id)]
               (when-not (and (keyword? id) (fn? start) (map? capabilities))
                 (throw (ex-info
                         "Subagent provider requires keyword :id, :start, and capabilities"
                         {:provider (dissoc provider :start)})))
               (when (contains? @providers id)
                 (throw (ex-info "Subagent provider is already registered"
                                 {:provider id})))
               (swap! providers assoc id provider)
               (kernel/emit! ctx :subagent/provider-added
                             (public-provider provider))
               (when (fn? restore)
                 (doseq [[agent-id job] @jobs
                         :when (and (= id (:provider job))
                                    (nil? (:handle job))
                                    (not (contains? #{:stopped :deleted :inactive}
                                                    (:status job))))]
                   (try
                     (let [handle (restore (public-job job))]
                       (swap! jobs update agent-id
                              #(assoc % :handle handle
                                      :session-id (or (:session-id handle)
                                                      (:session-id %)))))
                     (catch Throwable error
                       (swap! jobs update agent-id
                              #(assoc % :status :failed
                                      :error (ex-message error))))))
                 (persist!))
               (let [active? (atom true)]
                 (fn []
                   (when (compare-and-set! active? true false)
                     (swap! providers dissoc id)
                     (kernel/emit! ctx :subagent/provider-removed
                                   {:provider id}))))))
           start!
           (fn [request]
             (let [provider-id (provider-id (:provider request))
                   provider (get @providers provider-id)]
               (when-not provider
                 (throw (ex-info "Subagent provider is not registered"
                                 {:provider provider-id
                                  :available (set (keys @providers))})))
               (let [request (validate-request! provider request)
                     agent-id (or (:agent-id request) (:id request)
                                  (str "agent-" (random-uuid)))
                     started-at (System/currentTimeMillis)
                     run-id (str (random-uuid))
                     root-run-id (:root-run-id generation/*run*)
                     _ (generation/record-provider! ctx {:id agent-id :run-id run-id :root-run-id root-run-id :provider provider-id} :started)
                     handle ((:start provider)
                             (assoc request :id agent-id
                                            :agent-id agent-id
                                            :provider provider-id))]
                 (when-not (and (map? handle)
                                (instance? clojure.lang.IDeref (:result handle))
                                (fn? (:cancel! handle))
                                (fn? (:dispose! handle)))
                   (throw (ex-info "Subagent provider returned an invalid handle"
                                   {:provider provider-id :agent-id agent-id})))
                 (let [completion (promise)
                       job {:id agent-id
                            :agent_id agent-id
                            :run-id run-id :root-run-id root-run-id
                            :label (or (:label request) (:prompt request))
                            :provider provider-id
                            :depth (:depth request)
                            :status :running
                            :started-at started-at
                            :session-id (:session-id handle)
                            :session-path (:session-path handle)
                            :handle handle
                            :completion completion}]
                   (when (contains? @jobs agent-id)
                     ((:dispose! handle))
                     (throw (ex-info "Subagent agent id is already retained"
                                     {:agent-id agent-id})))
                   (swap! jobs assoc agent-id job)
                   (persist!)
                   (record-run! ctx store :start job)
                   (kernel/emit! ctx :subagent/start (public-job job))
                   (watch! agent-id provider-id (:depth request) run-id
                           completion (:result handle))
                   (public-job job)))))
           wait!
           (fn [agent-id & [timeout-ms]]
             (let [job (get @jobs agent-id)]
               (when-not job
                 (throw (ex-info "Subagent run was not found"
                                 {:agent-id agent-id})))
               (let [result (if (some? timeout-ms)
                              (deref (:completion job) timeout-ms ::timeout)
                              @(:completion job))]
                 (if (= ::timeout result)
                   {:id agent-id :agent_id agent-id :status (:status job)}
                   result))))
           hydrate!
           (fn [agent-id]
             (locking jobs
               (let [job (get @jobs agent-id)]
                 (when-not job
                   (throw (ex-info "Subagent was not found"
                                   {:agent-id agent-id})))
                 (when (contains? #{:stopped :deleted} (:status job))
                   (throw (ex-info "Subagent is not currently routable"
                                   {:agent-id agent-id :status (:status job)})))
                 (if (:handle job)
                   job
                   (let [provider (get @providers (:provider job))
                         restore (:restore provider)]
                     (when-not (fn? restore)
                       (throw (ex-info "Subagent cannot be hydrated"
                                       {:agent-id agent-id
                                        :provider (:provider job)})))
                     (let [handle (restore
                                   (-> (public-job job)
                                       (assoc :status
                                              (or (:passive-status job)
                                                  (:status job) :uncertain))))]
                       (swap! jobs update agent-id
                              #(-> %
                                   (assoc :handle handle
                                          :status (or (:passive-status %)
                                                      (:status %) :uncertain)
                                          :session-id (or (:session-id handle)
                                                          (:session-id %))
                                          :hydrated-at
                                          (System/currentTimeMillis))
                                   (dissoc :passive-status :passivated-at)))
                       (persist!)
                       (let [hydrated (get @jobs agent-id)]
                         (kernel/emit! ctx :subagent/hydrated
                                       (public-job hydrated))
                         hydrated)))))))
           interrupt!
           (fn [agent-id]
             (if-let [job (get @jobs agent-id)]
               (if (= :running (:status job))
                 (boolean ((get-in job [:handle :cancel!])))
                 false)
               (throw (ex-info "Subagent run was not found"
                               {:agent-id agent-id}))))
           dispatch-message!
           (fn [job message record-sent?]
             (let [agent-id (:id job)
                   message! (get-in job [:handle :message!])]
               (when-not (fn? message!)
                 (throw (ex-info "Subagent is not currently routable"
                                 {:agent-id agent-id :status (:status job)})))
               (let [{:keys [result queued duplicate] :as accepted} (message! message)
                     receipt (dissoc accepted :result :task)]
                 ;; An inbox replay does not admit work. In particular, it must
                 ;; not move an already terminal job back to :running.
                 (if (true? duplicate)
                   (merge {:id agent-id :agent_id agent-id :run_id (:run-id job)
                           :accepted true} receipt)
                   (let [completion (when-not queued (promise))
                         run-id (if queued (:run-id job) (str (random-uuid)))]
                     (when (and (not queued)
                                (not (instance? clojure.lang.IDeref result)))
                       (throw (ex-info "Subagent message did not return a run result"
                                       {:agent-id agent-id})))
                     ;; Queued work belongs to the existing watcher. It may
                     ;; already have finished while message! returned its ack.
                     (let [tracked
                           (when completion
                             (get (swap! jobs
                                    (fn [current]
                                      (let [live (get current agent-id)]
                                        ;; Stop/delete can retire the handle
                                        ;; while the provider accepts a message.
                                        (if (and live
                                                 (identical? (:handle job) (:handle live))
                                                 (not (contains? #{:stopped :deleted :inactive}
                                                                 (:status live))))
                                          (assoc current agent-id
                                                 (assoc live :status :running :run-id run-id
                                                        :updated-at (System/currentTimeMillis)
                                                        :completion completion))
                                          current))))
                                  agent-id))
                           watching? (and completion (identical? completion (:completion tracked)))
                           receipt-run-id (if (or queued watching?) run-id (:run-id tracked))]
                       (when (and store record-sent?)
                         ((:append! store) "agent/message/sent"
                          {:to agent-id :message message :run_id receipt-run-id}))
                       (when watching?
                         (persist!)
                         (record-run! ctx store :start tracked)
                         (watch! agent-id (:provider job) (:depth job) run-id
                                 completion result))
                       (merge {:id agent-id :agent_id agent-id :run_id receipt-run-id
                               :accepted true} receipt)))))))
           send!
           (fn [agent-id message]
             (dispatch-message! (hydrate! agent-id) message true))
           invoke!
           (fn [agent-id method params]
             (let [job (hydrate! agent-id)
                   invoke (get-in job [:handle :invoke!])]
               (if (and (= method "agent.message.receive")
                        (fn? (get-in job [:handle :message!])))
                 ;; Daemon-routed delivery needs the same completion watcher
                 ;; as send!, but the daemon records the sender separately.
                 (dispatch-message! job params false)
                 (do
                   (when-not (fn? invoke)
                     (throw (ex-info "Subagent is not currently routable"
                                     {:agent-id agent-id :status (:status job)})))
                   (invoke method params)))))
           passivate!
           (fn [agent-id]
             (locking jobs
               (when-let [job (get @jobs agent-id)]
                 (when (= :running (:status job))
                   (throw (ex-info "Running subagent cannot be passivated"
                                   {:agent-id agent-id})))
                 (when-let [dispose! (get-in job [:handle :dispose!])]
                   (dispose!)
                   (swap! jobs update agent-id
                          #(-> %
                               (assoc :passive-status (:status %)
                                      :status :inactive
                                      :handle nil
                                      :passivated-at
                                      (System/currentTimeMillis))))
                   (persist!)
                   (kernel/emit! ctx :subagent/passivated
                                 (public-job (get @jobs agent-id)))
                   true))))
           stop!
           (fn [agent-id]
             (let [[before after]
                   (swap-vals! jobs
                               (fn [current]
                                 (if-let [job (get current agent-id)]
                                   (assoc current agent-id
                                          (cond-> (assoc job :status :stopped :handle nil
                                                         :stopped-at (System/currentTimeMillis))
                                            (= :running (:status job))
                                            (assoc :result (outcome/normalize
                                                            {:id agent-id :run-id (:run-id job)
                                                             :status :cancelled :reason :stopped}))))
                                   current)))
                   job (get before agent-id)
                   terminal (when (= :running (:status job)) (get-in after [agent-id :result]))]
               (when job
                 (when terminal
                   (record-run! ctx store :end terminal)
                   (deliver (:completion job) terminal))
                 (try ((get-in job [:handle :dispose!])) (catch Throwable _))
                 (persist!)
                 true)))
           delete!
           (fn [agent-id]
             (when-let [job (get @jobs agent-id)]
               (try ((get-in job [:handle :dispose!])) (catch Throwable _))
               (let [tombstone {:agent_id agent-id
                                :session_id (:session-id job)
                                :deleted_at (System/currentTimeMillis)}]
                 (swap! tombstones conj tombstone)
                 (swap! jobs dissoc agent-id)
                 (persist!)
                 tombstone)))
           runtime
           {:register! register!
            :providers #(->> @providers vals (map public-provider)
                             (sort-by (comp str :id)) vec)
            :provider #(some-> (get @providers (provider-id %))
                               public-provider)
            :start! start!
            :jobs #(->> @jobs vals (map public-job)
                        (sort-by :started-at) vec)
            :job #(some-> (get @jobs %) public-job)
            :wait! wait!
            :interrupt! interrupt!
            :invoke! invoke!
            :send! send!
            :hydrate! hydrate!
            :passivate! passivate!
            :stop! stop!
            :delete! delete!
            :release! delete!
            :tombstones #(vec @tombstones)}]
       (kernel/register-service! ctx :subagents/runtime runtime)
       (fn []
         (doseq [agent-id (keys @jobs)]
           (when-let [job (get @jobs agent-id)]
             (try ((get-in job [:handle :cancel!])) (catch Throwable _)))
           (when-let [dispose! (get-in @jobs [agent-id :handle :dispose!])]
             (try (dispose!) (catch Throwable _)))))))})
