(ns agent.plugins.session
  "Recoverable append-only JSONL sessions with checkpoints and safe forks."
  (:require [agent.kernel :as kernel]
            [agent.secure-files :as secure]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.io FileOutputStream]
           [java.nio.charset StandardCharsets]
           [java.nio.file CopyOption Files StandardCopyOption]
           [java.time Instant]))

(defn- valid-event? [event]
  (and (map? event)
       (or (string? (:type event)) (keyword? (:type event)))
       (map? (:data event))))

(defn- load-events [path]
  (if-not (and path (.isFile (io/file path)))
    {:events [] :diagnostics []}
    (with-open [reader (io/reader path)]
      (reduce
       (fn [{:keys [events diagnostics]} [line-number line]]
         (if (str/blank? line)
           {:events events :diagnostics diagnostics}
           (try
             (let [event (json/parse-string line true)]
               (if (valid-event? event)
                 {:events (conj events event) :diagnostics diagnostics}
                 {:events events
                  :diagnostics
                  (conj diagnostics
                        {:line line-number :reason "Invalid event shape"})}))
             (catch Throwable error
               {:events events
                :diagnostics
                (conj diagnostics
                      {:line line-number
                       :reason (str "Invalid JSON: " (ex-message error))})}))))
       {:events [] :diagnostics []}
       (map-indexed (fn [index line] [(inc index) line])
                    (line-seq reader))))))

(defn- ensure-parent! [path]
  (when-let [parent (.getParentFile (io/file path))]
    (when-not (or (.isDirectory parent) (.mkdirs parent))
      (throw (ex-info "Could not create session directory"
                      {:path (str parent)})))
    (secure/protect-managed-parents! parent)))

(defn- migrate-session-permissions! [path]
  (let [target (io/file path)
        parent (.getParentFile target)]
    (ensure-parent! path)
    (when (and parent (secure/managed-state-root parent))
      (doseq [file (or (.listFiles parent) (make-array java.io.File 0))
              :when (and (.isFile file)
                         (or (str/ends-with? (.getName file) ".jsonl")
                             (str/ends-with? (.getName file) ".writer.lock")))]
        (secure/protect-file! file)))
    (secure/ensure-owner-file! target)))

(defn- ensure-line-boundary! [path]
  (let [target (io/file path)]
    (when (and (.isFile target) (pos? (.length target)))
      (with-open [file (java.io.RandomAccessFile. target "r")]
        (.seek file (dec (.length file)))
        (when-not (= 10 (.read file))
          (with-open [output (FileOutputStream. target true)]
            (.write output (.getBytes "\n" StandardCharsets/UTF_8))
            (.flush output)
            (.force (.getChannel output) true)))))))

(defn- append-json-line! [output item fsync?]
  (when output
    (.write output
            (.getBytes (str (json/generate-string item) "\n")
                       StandardCharsets/UTF_8))
    (.flush output)
    (when fsync? (.force (.getChannel output) true))))

(defn- event [type data parent-id sequence]
  (cond-> {:id (str (random-uuid))
           :seq sequence
           :at (str (Instant/now))
           :type type
           :data data}
    parent-id (assoc :parent_id parent-id)))

(defn- normalize-sequences [events]
  (mapv (fn [index item] (assoc item :seq (inc index)))
        (range)
        events))

(defn- message-event? [item]
  (contains? #{"message" :message} (:type item)))

(defn- effective-messages [events]
  (reduce
   (fn [messages item]
     (cond
       (contains? #{"message" :message} (:type item))
       (conj messages (get-in item [:data :message]))

       (contains? #{"session/clear" :session/clear} (:type item))
       []

       (contains? #{"session/compaction" :session/compaction} (:type item))
       (vec (get-in item [:data :replacement_messages]))

       :else messages))
   [] events))

(defn- message-summary [message]
  (let [role (:role message)
        content (:content message)
        tool-names (->> (:tool_calls message)
                        (keep #(get-in % [:function :name]))
                        (str/join ", "))]
    (str role ": "
         (cond
           (and (string? content) (not (str/blank? content))) content
           (seq content) (pr-str content)
           (not (str/blank? tool-names)) (str "called tools " tool-names)
           :else "[no text]"))))

(defn- deterministic-summary [messages max-chars]
  (let [text (str/join "\n" (map message-summary messages))]
    (str (subs text 0 (min max-chars (count text)))
         (when (> (count text) max-chars) "\n[summary truncated]"))))

(defn- write-events-atomically! [destination events]
  (ensure-parent! destination)
  (let [target (.getCanonicalFile (io/file destination))
        parent (or (.getParentFile target) (.getCanonicalFile (io/file ".")))
        temporary (java.io.File/createTempFile ".bb-agent-fork-" ".jsonl"
                                                parent)]
    (try
      (secure/protect-file! temporary)
      (with-open [writer (io/writer temporary)]
        (doseq [item events]
          (.write writer (str (json/generate-string item) "\n")))
        (.flush writer))
      (try
        (Files/move (.toPath temporary) (.toPath target)
                    (into-array CopyOption [StandardCopyOption/ATOMIC_MOVE]))
        (catch Throwable error
          (if (.exists temporary)
            (Files/move (.toPath temporary) (.toPath target)
                        (make-array CopyOption 0))
            (throw error))))
      (finally
        (when (.exists temporary) (.delete temporary))))
    (secure/protect-file! target)
    (str target)))

(def plugin
  {:id :session/append-only
   :description "Recoverable append-only session log with resume/fork/compaction."
   :provides #{:session/store}
   :start
   (fn [ctx {:keys [path retain-messages max-summary-chars fsync?]
             :or {retain-messages 12 max-summary-chars 8000 fsync? true}}]
     (when-not (and (pos-int? retain-messages) (pos-int? max-summary-chars))
       (throw (ex-info "Session compaction limits must be positive integers"
                       {:retain-messages retain-messages
                        :max-summary-chars max-summary-chars})))
     (when path
       (migrate-session-permissions! path)
       (ensure-line-boundary! path))
     (let [{loaded-events :events loaded-diagnostics :diagnostics}
           (load-events path)
           loaded-events (normalize-sequences loaded-events)
           events (atom loaded-events)
           diagnostics (atom loaded-diagnostics)
           output (when path (FileOutputStream. (io/file path) true))
           listeners (atom {})
           lock (Object.)
           session-id (or (some #(when (= "session/fork" (:type %))
                                   (get-in % [:data :session_id]))
                                (reverse loaded-events))
                          (some #(when (= "session/start" (:type %))
                                   (get-in % [:data :session_id]))
                                loaded-events)
                          (str (random-uuid)))
           notify! (fn [item]
                     (doseq [listener (vals @listeners)]
                       (try (listener item) (catch Throwable _)))
                     item)
           append! (fn
                     ([type data]
                      (locking lock
                        (let [parent-id (:id (last @events))
                              item (event type data parent-id
                                          (inc (count @events)))]
                          (when path
                            (append-json-line! output item fsync?))
                          (swap! events conj item)
                          (notify! item))))
                     ([type data parent-id]
                      (locking lock
                        (let [item (event type data parent-id
                                          (inc (count @events)))]
                          (when path
                            (append-json-line! output item fsync?))
                          (swap! events conj item)
                          (notify! item)))))
           messages #(effective-messages @events)
           compact-body!
           (fn [{:keys [summary retain]
                 :or {retain retain-messages}}]
              (when-not (pos-int? retain)
                (throw (ex-info ":retain must be a positive integer"
                                {:retain retain})))
              (let [current (messages)
                    dropped-count (max 0 (- (count current) retain))]
                (if (zero? dropped-count)
                  {:compacted false :message-count (count current)}
                  (let [dropped (take dropped-count current)
                        kept (take-last retain current)
                        summary-text (if (str/blank? summary)
                                       (deterministic-summary
                                        dropped max-summary-chars)
                                       summary)
                        replacement
                        (vec (cons {:role "system"
                                    :content
                                    (str "Previous conversation summary:\n"
                                         summary-text)}
                                   kept))
                        item (append!
                              "session/compaction"
                              {:original_message_count (count current)
                               :retained_message_count retain
                               :replacement_messages replacement})]
                    {:compacted true
                     :event-id (:id item)
                     :message-count (count replacement)}))))
           compact! (fn
                      ([] (compact-body! {}))
                      ([options] (compact-body! options)))
           checkpoint!
           (fn [replacement metadata]
             (when-not (and (vector? replacement) (seq replacement))
               (throw (ex-info "Checkpoint replacement must be a non-empty vector"
                               {:replacement replacement})))
             (let [item (append! "session/compaction"
                                 (merge {:original_message_count
                                         (count (messages))
                                         :retained_message_count
                                         (count replacement)
                                         :replacement_messages replacement}
                                        metadata))]
               {:compacted true
                :event-id (:id item)
                :message-count (count replacement)}))
           fork!
           (fn [destination]
             (when (str/blank? destination)
               (throw (ex-info "Fork destination must not be blank" {})))
             (let [target (.getCanonicalFile (io/file destination))
                   source (some-> path io/file .getCanonicalFile)]
               (when (and source (= source target))
                 (throw (ex-info "Fork destination must differ from source"
                                 {:path (str target)})))
               (when (.exists target)
                 (throw (ex-info "Refusing to overwrite fork destination"
                                 {:path (str target)})))
               (let [fork-session-id (str (random-uuid))
                     fork-event
                     (event "session/fork"
                            {:session_id fork-session-id
                             :parent_session_id session-id
                             :parent_path (some-> source str)}
                            (:id (last @events))
                            (inc (count @events)))]
                 {:path (write-events-atomically!
                         target (conj (vec @events) fork-event))
                  :session-id fork-session-id
                  :event-count (inc (count @events))})))
           label-value (fn []
                         (some #(when (= "session/label" (:type %))
                                  (get-in % [:data :label]))
                               (reverse @events)))
           name-value (fn []
                        (some #(when (= "session/name" (:type %))
                                 (get-in % [:data :name]))
                              (reverse @events)))
           tree (fn []
                  (loop [remaining @events previous nil result []]
                    (if-let [item (first remaining)]
                      (recur (next remaining) (:id item)
                             (conj result
                                   {:id (:id item)
                                    :parent-id (or (:parent_id item) previous)
                                    :type (:type item)
                                    :at (:at item)
                                    :role (get-in item [:data :message :role])}))
                      result)))
           checkout-body!
           (fn [event-id {:keys [summary]}]
              (let [index (first (keep-indexed
                                  #(when (= event-id (:id %2)) %1)
                                  @events))]
                (when-not index
                  (throw (ex-info "Session tree entry was not found"
                                  {:event-id event-id})))
                (let [replayed (effective-messages
                                (subvec (vec @events) 0 (inc index)))
                      replacement (if (str/blank? summary)
                                    replayed
                                    [{:role "system"
                                      :content (str "Branch summary:\n" summary)}])
                      item (append! "session/compaction"
                                    {:original_message_count (count (messages))
                                     :retained_message_count
                                     (count replacement)
                                     :replacement_messages replacement
                                     :checkout_event_id event-id}
                                    event-id)]
                  {:event-id (:id item)
                   :parent-id event-id
                   :message-count (count replacement)})))
           checkout! (fn
                       ([event-id] (checkout-body! event-id {}))
                       ([event-id options]
                        (checkout-body! event-id options)))
           store {:append! append!
                  :events (fn [] (vec @events))
                  :events-after (fn [cursor]
                                  (let [cursor (or cursor 0)]
                                    (->> @events
                                         (filter #(> (:seq %) cursor))
                                         vec)))
                  :subscribe!
                  (fn [listener]
                    (when-not (fn? listener)
                      (throw (ex-info "Session listener must be a function" {})))
                    (let [id (str (random-uuid))]
                      (swap! listeners assoc id listener)
                      (fn [] (swap! listeners dissoc id))))
                  :messages messages
                  :diagnostics (fn [] (vec @diagnostics))
                  :session-id session-id
                  :path (some-> path io/file .getAbsolutePath)
                  :compact! compact!
                  :checkpoint! checkpoint!
                  :fork! fork!
                  :tree tree
                  :active-leaf (fn [] (:id (last @events)))
                  :label (fn [] (label-value))
                  :name (fn [] (name-value))
                  :label! (fn [label]
                            (append! "session/label" {:label label}))
                  :name! (fn [name]
                           (append! "session/name" {:name name}))
                  :checkout! checkout!
                  :clear! (fn []
                            (append! "session/clear" {})
                            nil)}]
       (when-not (some #(= "session/start" (:type %)) loaded-events)
         (append! "session/start" {:session_id session-id}))
       (kernel/register-service! ctx :session/store store)
       (fn []
         (when output
           (try (.flush output) (catch Throwable _))
           (try (.force (.getChannel output) true) (catch Throwable _))
           (try (.close output) (catch Throwable _))))))})
