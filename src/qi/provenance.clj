(ns qi.provenance
  "Minimal evidence labels for an actual entry, never inferred for historical logs."
  (:require [babashka.process :as process]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.context-summary :as summary]
            [qi.env :as env]))

(def kinds #{"production" "fixture" "ci" "unclassified"})

(defn- git [root args]
  (try
    (let [child (process/process (into ["git" "-C" (str root)] args)
                                 {:out :string :err :string})]
      (let [result (deref child 1000 ::timeout)]
        (if (= result ::timeout)
          (do (process/destroy-tree child) nil)
          result)))
    (catch Throwable _ nil)))

(defn source-facts [root]
  (let [head (git root ["rev-parse" "HEAD"])
        revision (some-> (:out head) str/trim)
        tracked (git root ["diff-index" "--quiet" "HEAD" "--"])
        untracked (git root ["ls-files" "--others" "--exclude-standard" "--" "src" "plugins"])
        known? (and (= 0 (:exit head)) (re-matches #"[a-f0-9]{40}" (or revision ""))
                    (contains? #{0 1} (:exit tracked)) (= 0 (:exit untracked)))
        clean? (and known? (= 0 (:exit tracked)) (str/blank? (:out untracked)))]
    {:source_sha (when clean? revision)
     :source_status (cond clean? "clean" known? "dirty" :else "unavailable")}))

(defn source-root []
  (try
    (let [resource (io/resource "qi/cli.clj")]
      (when (= "file" (.getProtocol resource))
        (-> resource .toURI io/file .getParentFile .getParentFile .getParentFile)))
    (catch Throwable _ nil)))

(defn for-entry [config entry-options]
  (let [requested (env/get "QI_AGENT_SAMPLE_KIND")
        _ (when (and requested (not (contains? kinds requested)))
            (throw (ex-info "QI_AGENT_SAMPLE_KIND must be production, fixture, ci or unclassified" {})))
        ci? (contains? #{"1" "true"} (some-> (env/get "CI") str/lower-case))
        mock? (some #(= 'qi.plugins.mock (:ns %)) (:plugins config))
        kind (cond ci? "ci" mock? "fixture" requested requested :else "production")]
    (merge {:sample_kind kind
            :profile_sha256 (summary/sha256 (pr-str {:profile config :entry_options entry-options}))}
           (if-let [root (source-root)]
             (source-facts root)
             {:source_sha nil :source_status "unavailable"}))))

(defn sanitized [value]
  (let [value (merge {:sample_kind "unclassified" :source_sha nil :profile_sha256 nil}
                     (select-keys value [:sample_kind :source_sha :source_status :profile_sha256]))]
    (when-not (and (contains? kinds (:sample_kind value))
                   (or (nil? (:source_status value))
                       (contains? #{"clean" "dirty" "unavailable"} (:source_status value)))
                   (every? (fn [[key size]] (or (nil? (get value key))
                                               (and (string? (get value key))
                                                    (re-matches (re-pattern (str "[a-f0-9]{" size "}"))
                                                                (get value key)))))
                           [[:source_sha 40] [:profile_sha256 64]]))
      (throw (ex-info "Invalid session provenance" {})))
    value))
