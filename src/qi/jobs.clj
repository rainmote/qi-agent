(ns qi.jobs
  "Bounded, session-owned background jobs over an injected ExecutionWorld.

  This namespace never creates a process. The world owns sandboxing, timeout,
  process-tree cancellation and disk output limits. Job offsets count UTF-16
  characters in the combined stdout/stderr arrival stream."
  (:require [qi.cancellation :as cancellation]))

(def ^:private active-statuses #{:queued :running :cancelling})

(defn- active? [job] (contains? active-statuses (:status job)))

(defn- public-job [job]
  (-> (select-keys job [:job-id :command :cwd :status :created-at :started-at
                        :ended-at :exit-code :duration-ms :error :error-data
                        :full-output-path :source-call-id])
      (assoc :background true
             :output-chars (:next-offset job)
             :available-offset (:base-offset job)
             :output-discarded? (pos? (:base-offset job)))))

(defn- now [] (str (java.time.Instant/now)))

(defn- safe-notify! [notify! kind data]
  ;; Session storage or an observer failing must never strand a running job.
  (try (notify! kind data) (catch Throwable _)))

(defn create-manager
  "Create a bounded manager. notify! receives :job/started and :job/completed.
  Every public operation belongs to this one manager/session; IDs are not PIDs.
  close! cancels all active jobs and waits up to one shared shutdown deadline."
  [spawn! {:keys [max-running max-retained max-output-chars max-read-chars
                 max-wait-ms shutdown-wait-ms timeout-ms notify!]
          :or {max-running 4 max-retained 64 max-output-chars 200000
               max-read-chars 50000 max-wait-ms 30000 shutdown-wait-ms 3000
               timeout-ms 300000 notify! (fn [_ _])}}]
  (when-not (and (fn? spawn!)
                 (every? pos-int? [max-running max-retained max-output-chars
                                   max-read-chars max-wait-ms shutdown-wait-ms
                                   timeout-ms])
                 (>= max-retained max-running))
    (throw (ex-info "Invalid background job limits"
                    {:max-running max-running :max-retained max-retained})))
  (let [state (atom {:closed? false :jobs {} :order []})
        lock (Object.)]
    (letfn [(lookup [job-id]
              (or (get-in @state [:jobs job-id])
                  (throw (ex-info "Unknown or expired background job"
                                  {:job-id job-id}))))
            (append-output! [job-id {:keys [chunk]}]
              (when (and (string? chunk) (seq chunk))
                (locking lock
                  (when-let [job (get-in @state [:jobs job-id])]
                    (when (active? job)
                      (let [text (str (:output job) chunk)
                            next-offset (+ (:next-offset job) (count chunk))
                            drop-count (max 0 (- (count text) max-output-chars))]
                        (swap! state assoc-in [:jobs job-id]
                               (assoc job :output (subs text drop-count)
                                      :base-offset (+ (:base-offset job) drop-count)
                                      :next-offset next-offset))))))))
            (finish! [job-id result error]
              (let [error (or error
                              (when-not (integer? (:exit-code result))
                                (ex-info "ExecutionWorld returned no shell exit code" {})))
                    job
                    (locking lock
                      (when-let [job (get-in @state [:jobs job-id])]
                        (when (active? job)
                          (let [cancelled? (cancellation/cancelled? (:cancel-token job))
                                status (cond cancelled? :cancelled
                                             error :failed
                                             (zero? (or (:exit-code result) 0)) :completed
                                             :else :failed)
                                finished
                                (merge job (select-keys result [:exit-code :duration-ms
                                                                :full-output-path])
                                       {:status status :ended-at (now)}
                                       (when error
                                         {:error (subs (or (ex-message error) "Job failed")
                                                       0 (min 2000 (count (or (ex-message error)
                                                                             "Job failed"))))
                                          :error-data (select-keys (ex-data error)
                                                                  [:cancelled :timeout-ms
                                                                   :max-output-file-chars
                                                                   :stream])}))]
                            (swap! state assoc-in [:jobs job-id] finished)
                            finished))))]
                (when job
                  (safe-notify! notify! :job/completed (public-job job))
                  (deliver (:done job) (public-job job)))))
            (kill! [job-id]
              (let [job (locking lock
                          (let [job (lookup job-id)]
                            (when (active? job)
                              (swap! state assoc-in [:jobs job-id :status] :cancelling))
                            job))]
                (when (active? job) (cancellation/cancel! (:cancel-token job)))
                (public-job (lookup job-id))))
            (start! [args execution]
              (cancellation/throw-if-cancelled! (:cancel-token execution))
              (let [job-id (str (random-uuid))
                    token (cancellation/create-token)
                    done (promise)
                    job {:job-id job-id :status :queued :created-at (now)
                         :command (:command args) :cwd (or (:cwd args) ".")
                         :source-call-id (:call-id execution)
                         :output "" :base-offset 0 :next-offset 0
                         :cancel-token token :done done}]
                (locking lock
                  (when (:closed? @state)
                    (throw (ex-info "Background job manager is closed" {})))
                  (when (>= (count (filter active? (vals (:jobs @state)))) max-running)
                    (throw (ex-info "Background job concurrency limit reached"
                                    {:max-running max-running})))
                  ;; Only terminal records may expire; active jobs are never evicted.
                  (when (>= (count (:jobs @state)) max-retained)
                    (when-let [expired (first (filter #(not (active? (get-in @state [:jobs %])))
                                                     (:order @state)))]
                      (swap! state (fn [s] (-> s (update :jobs dissoc expired)
                                               (update :order #(vec (remove #{expired} %))))))))
                  (swap! state (fn [s] (-> s (assoc-in [:jobs job-id] job)
                                           (update :order conj job-id)))))
                ;; Register before launch. An already-cancelled parent cancels the
                ;; new token synchronously; the world checks it before spawning.
                (let [dispose-parent (cancellation/on-cancel!
                                      (:cancel-token execution)
                                      #(cancellation/cancel! token))]
                  (safe-notify! notify! :job/started (public-job job))
                  (try
                    (future
                      (try
                        (cancellation/throw-if-cancelled! token)
                        (locking lock
                          (when (= :queued (:status (lookup job-id)))
                            (swap! state update-in [:jobs job-id]
                                   assoc :status :running :started-at (now))))
                        (finish! job-id
                                 (spawn! (assoc args
                                                :timeout-ms (or (:timeout-ms args) timeout-ms)
                                                :cancel-token token
                                                :stream-output? true
                                                :on-update #(append-output! job-id %)))
                                 nil)
                        (catch Throwable error (finish! job-id nil error))
                        (finally (dispose-parent))))
                    (catch Throwable error
                      (dispose-parent)
                      (finish! job-id nil error)
                      (throw error))))
                ;; Return the reservation even if an immediately finishing job was
                ;; evicted by another caller before this start call returned.
                (public-job job)))
            (read-output [job-id offset limit wait-timed-out?]
              (let [job (lookup job-id)
                    start (max offset (:base-offset job))
                    end (min (:next-offset job) (+ start limit))]
                (merge (public-job job)
                       {:output (subs (:output job) (- start (:base-offset job))
                                      (- end (:base-offset job)))
                        :offset start :next-offset end :end-offset (:next-offset job)
                        :discarded-chars (max 0 (- (:base-offset job) offset))
                        :truncated (< end (:next-offset job))
                        :wait-timed-out wait-timed-out?})))
            (output! [{:keys [job-id offset limit wait-ms]
                       :or {offset 0 wait-ms 0}} execution]
              (let [limit (or limit max-read-chars)
                    token (:cancel-token execution)]
                (when-not (and (nat-int? offset) (pos-int? limit)
                               (<= limit max-read-chars) (nat-int? wait-ms)
                               (<= wait-ms max-wait-ms))
                  (throw (ex-info "Background output limits are out of range"
                                  {:max-read-chars max-read-chars :max-wait-ms max-wait-ms})))
                (cancellation/throw-if-cancelled! token)
                (let [ready (promise)
                      watch-id (str (random-uuid))
                      check! (fn []
                               (let [job (get-in @state [:jobs job-id])]
                                 (when (or (nil? job) (not (active? job))
                                           (> (:next-offset job) offset))
                                   (deliver ready true))))
                      dispose (cancellation/on-cancel! token #(deliver ready :cancelled))]
                  (try
                    (locking lock
                      (let [job (lookup job-id)]
                        (when (> offset (:next-offset job))
                          (throw (ex-info "Output offset exceeds available output"
                                          {:job-id job-id :end-offset (:next-offset job)})))
                        (when (pos? wait-ms)
                          (add-watch state watch-id (fn [_ _ _ _] (check!))))
                        (check!)))
                    (let [timed-out? (and (pos? wait-ms) (= ::timeout (deref ready wait-ms ::timeout)))]
                      (cancellation/throw-if-cancelled! token)
                      (read-output job-id offset limit (boolean timed-out?)))
                    (finally (remove-watch state watch-id) (dispose))))))
            (close! []
              (let [jobs (locking lock
                           (swap! state assoc :closed? true)
                           (vec (filter active? (vals (:jobs @state)))))
                    deadline (+ (System/nanoTime) (* shutdown-wait-ms 1000000))]
                (doseq [job jobs] (cancellation/cancel! (:cancel-token job)))
                (doseq [job jobs]
                  (deref (:done job) (max 0 (long (/ (- deadline (System/nanoTime)) 1000000))) nil))
                {:closed true
                 :remaining (count (filter active? (vals (:jobs @state))))}))]
      {:start! start! :kill! kill! :output output! :close! close!
       :limits {:max-running max-running :max-retained max-retained
                :max-output-chars max-output-chars :max-read-chars max-read-chars
                :max-wait-ms max-wait-ms :timeout-ms timeout-ms}
       :list #(let [snapshot @state]
                (mapv (fn [id] (public-job (get-in snapshot [:jobs id])))
                      (reverse (:order snapshot))))})))
