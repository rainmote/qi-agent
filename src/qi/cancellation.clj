(ns qi.cancellation
  "Small cooperative cancellation token with closeable-resource callbacks.")

(defn create-token []
  {:state (atom {:cancelled? false :callbacks {}})})

(defn cancelled? [token]
  (boolean (and token (:cancelled? @(:state token)))))

(defn throw-if-cancelled! [token]
  (when (cancelled? token)
    (throw (ex-info "Agent run was cancelled" {:cancelled true}))))

(defn on-cancel!
  "Register a callback and return an idempotent disposer."
  [token callback]
  (if-not token
    (constantly nil)
    (let [id (str (random-uuid))
          run-now? (locking (:state token)
                     (if (:cancelled? @(:state token))
                       true
                       (do (swap! (:state token)
                                  assoc-in [:callbacks id] callback)
                           false)))
          active? (atom (not run-now?))]
      (when run-now? (callback))
      (fn []
        (when (compare-and-set! active? true false)
          (swap! (:state token) update :callbacks dissoc id))))))

(defn cancel!
  "Cancel once and invoke all registered resource closers."
  [token]
  (when token
    (let [{:keys [changed callbacks]}
          (locking (:state token)
            (when-not (:cancelled? @(:state token))
              (let [callbacks (vals (:callbacks @(:state token)))]
                (reset! (:state token) {:cancelled? true :callbacks {}})
                {:changed true :callbacks callbacks})))]
      (doseq [callback callbacks]
        (try (callback) (catch Throwable _)))
      (boolean changed))))
