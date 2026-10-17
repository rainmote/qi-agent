(ns memory-recall
  "Deterministic representation control; not an LLM recall benchmark."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [qi.context-summary :as summary]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin])
  (:import [java.time Instant]))

(defn active-records [events]
  (let [{:keys [active]}
        (reduce
         (fn [{:keys [seen active]} {:keys [id at scope key supersedes] :as event}]
           (when-not (and (string? id) (not (str/blank? id)) (not (contains? seen id))
                          (contains? #{"project" "user" "ephemeral"} scope)
                          (string? key) (contains? event :value))
             (throw (ex-info "Invalid constraint provenance" {:event-id id})))
           (Instant/parse at)
           (let [slot (keyword (str scope ":" key))
                 current (get active slot)]
             (when (or (and supersedes (not= supersedes (:id current)))
                       (and current (nil? supersedes)))
               (throw (ex-info "Replacement must supersede the active constraint in the same scope" {:event-id id})))
             {:seen (conj seen id)
              :active (assoc active slot (assoc event :source-event id :review "fixture-only"))}))
         {:seen #{} :active (sorted-map)} events)]
    (vec (vals active))))

(defn- values-by-key [records]
  (into (sorted-map) (map (fn [{:keys [scope key value]}]
                          [(keyword (str scope ":" key)) value]) records)))

(defn- render-layer [scope records]
  (str "# " scope " constraint proposals (fixture-only)\n\n"
       "Source annotations are explicit experiment input; no automatic promotion.\n\n"
       (str/join "\n" (map json/generate-string records)) "\n"))

(defn- read-records [text]
  (->> (str/split-lines text)
       (filter #(str/starts-with? % "{"))
       (mapv #(json/parse-string % true))))

(defn- boot [root session-id trusted?]
  (plugin/boot!
   {:plugins [{:ns 'qi.plugins.session :config {:ephemeral true :session-id session-id}}
              {:ns 'qi.plugins.trust :config {:root (str root) :trusted trusted?}}
              {:ns 'qi.plugins.resources
               :config {:root (str root) :user-dir (str (fs/path root "user"))
                        :project-dir (str (fs/path root ".qi-agent"))
                        :skills {:enabled false}}}
              {:ns 'qi.plugins.durable-state :config {:root (str root)}}]}))

(defn- layered-readback [records]
  (let [root (fs/create-temp-dir {:prefix "qi-memory-control-"})]
    (try
      (doseq [[scope directory] [["user" "user"] ["project" ".qi-agent"]]]
        (fs/create-dirs (fs/path root directory))
        (spit (str (fs/path root directory "AGENTS.md"))
              (render-layer scope (filterv #(= scope (:scope %)) records))))
      (let [ctx (boot root "memory-control" true)]
        (try
          (let [store (kernel/require-service ctx :agent/durable-state)
                ephemeral (filterv #(= "ephemeral" (:scope %)) records)
                _ ((:put! store) :experiment/ephemeral ephemeral)
                contexts ((:contexts (kernel/require-service ctx :resources/catalog)))
                readback (vec (concat (mapcat #(read-records (:content %)) contexts)
                                      ((:get store) :experiment/ephemeral)))
                untrusted (boot root "other-session" false)]
            (try
              {:records readback
               :project-hidden-when-untrusted
               (not-any? #(= :project (:scope %))
                         ((:contexts (kernel/require-service untrusted :resources/catalog))))
               :ephemeral-hidden-in-other-session
               (nil? ((:get (kernel/require-service untrusted :agent/durable-state))
                      :experiment/ephemeral))}
              (finally (kernel/dispose-all! untrusted))))
          (finally (kernel/dispose-all! ctx))))
      (finally (fs/delete-tree root)))))

(defn run-experiment [fixture]
  (when-not (and (= 1 (:schema_version fixture)) (= "dev" (:split fixture))
                 (= 20 (count (:cases fixture))))
    (throw (ex-info "Expected exactly twenty frozen development histories" {})))
  (let [rows
        (mapv
         (fn [{:keys [id history annotations expected]}]
           (let [source (summary/source history)
                 records (active-records annotations)
                 ;; Both arms use exactly the same explicit reference annotations.
                 ;; A perfect deterministic summarizer is a control, not a model.
                 checkpoint (json/generate-string (values-by-key records))
                 replacement (summary/replacement checkpoint [])
                 restored (json/parse-string
                           (subs (:content (first replacement))
                                 (count "Previous conversation summary:\n")) true)
                 layered (layered-readback records)
                 actual (values-by-key (:records layered))]
             {:id id :source-chars (count source) :source-sha256 (summary/sha256 source)
              :checkpoint {:constraint-match (= expected restored)
                           :chars (count checkpoint) :values restored}
              :layered {:constraint-match (= expected actual)
                        :chars (reduce + (map #(count (render-layer % (filterv (fn [r] (= % (:scope r))) records)))
                                              ["user" "project" "ephemeral"]))
                        :values actual :records (:records layered)}
              :project-hidden-when-untrusted (:project-hidden-when-untrusted layered)
              :ephemeral-hidden-in-other-session (:ephemeral-hidden-in-other-session layered)}))
         (:cases fixture))]
    {:schema_version 1 :experiment "memory-representation-control-v1"
     :split "dev" :model_calls 0 :model_semantic_recall nil :cost_usd nil
     :cases rows :case_count (count rows)
     :checkpoint_matches (count (filter #(get-in % [:checkpoint :constraint-match]) rows))
     :layered_matches (count (filter #(get-in % [:layered :constraint-match]) rows))
     :production_memory_enabled false
     :decision "Keep existing checkpoint/resources; no semantic evidence supports adding production layered memory."}))

(when (= *file* (System/getProperty "babashka.file"))
  (let [file (or (first *command-line-args*) "evals/experiments/memory-cases.json")
        fixture (json/parse-string (slurp file) true)]
    (println (json/generate-string (assoc (run-experiment fixture)
                                         :fixture_sha256 (summary/sha256 (slurp file)))))))
