(ns qi.orchestration
  "Bounded session-ledger helpers for declarative orchestration."
  (:require [qi.kernel :as kernel]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn fail! [message data] (throw (ex-info message (assoc data :orchestration true))))
(defn text! [value label limit]
  (when-not (and (string? value) (not (str/blank? value)) (<= (count value) limit))
    (fail! (str label " must be nonblank text of at most " limit " characters") {}))
  value)
(defn identifier! [value]
  (when-not (and (string? value) (re-matches #"[A-Za-z0-9_-]{1,80}" value))
    (fail! "Identifier must contain 1-80 letters, digits, underscores or hyphens" {}))
  value)
(defn now [] (str (java.time.Instant/now)))
(defn id [prefix] (str prefix "-" (random-uuid)))
(defn revision! [value expected]
  (when-not (and (int? expected) (= (:revision value) expected))
    (fail! "Revision conflict; read the current state before retrying"
           {:expected expected :actual (:revision value) :conflict true})))
(defn bounded! [value]
  (when (> (count (json/generate-string value)) 524288)
    (fail! "Orchestration record exceeds the 512 KiB limit" {}))
  value)

(defn ledger [ctx key initial recover]
  (let [durable (kernel/require-service ctx :agent/durable-state)
        saved ((:get durable) key)
        state (atom (recover (or saved initial)))
        lock (Object.)
        save! (fn [next]
                (bounded! next)
                ((:put! durable) key next)
                (reset! state next)
                next)]
    (when (and saved (not= saved @state)) (save! @state))
    {:snapshot #(deref state)
     :mutate! (fn [f]
                (locking lock
                  (save! (-> (f @state)
                             (assoc :updated_at (now))
                             (assoc :revision (inc (or (:revision @state) 0)))))))}))

(defn graph! [nodes]
  (when-not (and (vector? nodes) (<= 1 (count nodes) 64))
    (fail! "A graph requires 1-64 nodes" {}))
  (let [ids (mapv :id nodes) known (set ids)]
    (doseq [node-id ids] (identifier! node-id))
    (when-not (= (count ids) (count known)) (fail! "Duplicate node id" {}))
    (doseq [{:keys [id depends_on]} nodes]
      (when-not (and (vector? (or depends_on []))
                     (= (count depends_on) (count (distinct depends_on)))
                     (every? known depends_on))
        (fail! "Dependencies must be distinct existing node ids" {:node_id id})))
    (let [edges (into {} (map (juxt :id #(set (:depends_on %))) nodes))]
      (loop [remaining edges done #{}]
        (when (seq remaining)
          (let [ready (set (for [[node deps] remaining :when (every? done deps)] node))]
            (when (empty? ready) (fail! "Dependency cycle is not allowed" {}))
            (recur (apply dissoc remaining ready) (into done ready)))))))
  nodes)

(defn register-rpcs! [ctx prefix actions parameters execute]
  (when-let [registry (kernel/service ctx :remote/registry)]
    (doseq [action actions]
      (kernel/track-effect!
       ctx
       ((:register! registry)
        {:method (str prefix "." action)
         :description (str prefix " " action)
         :blocking (= [prefix action] ["planning" "submit"])
         :params-schema (-> parameters
                            (update :properties dissoc :action "action")
                            (assoc :required []))
         :result-schema {:type "object"}
         :handler #(execute (assoc % :action action) {:orchestration/user-rpc true})}))))
  nil)
