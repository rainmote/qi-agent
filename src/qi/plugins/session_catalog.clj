(ns qi.plugins.session-catalog
  "Discover and index append-only session logs without opening them for writes."
  (:require [qi.kernel :as kernel]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.file FileVisitOption Files LinkOption Path]))

(defn- safe-events [file]
  (with-open [reader (io/reader file)]
    (->> (line-seq reader)
         (keep (fn [line]
                 (when-not (str/blank? line)
                   (try (json/parse-string line true)
                        (catch Throwable _ nil)))))
         doall)))

(defn- last-data [events type key]
  (some #(when (= type (:type %)) (get-in % [:data key]))
        (reverse events)))

(defn- describe [file]
  (let [events (safe-events file)
        start-id (some #(when (= "session/start" (:type %))
                          (get-in % [:data :session_id])) events)
        fork (some #(when (= "session/fork" (:type %)) %) (reverse events))]
    {:session-id (or (get-in fork [:data :session_id]) start-id)
     :parent-session-id (get-in fork [:data :parent_session_id])
     :path (.getAbsolutePath ^java.io.File file)
     :name (last-data events "session/name" :name)
     :label (last-data events "session/label" :label)
     :event-count (count events)
     :message-count (count (filter #(= "message" (:type %)) events))
     :updated-at (:at (last events))}))

(defn- jsonl-files [root]
  ;; No FOLLOW_LINKS option is supplied, and NOFOLLOW_LINKS is explicit for
  ;; regular-file checks, so catalog refresh cannot escape through a symlink.
  (with-open [paths (Files/walk (.toPath ^java.io.File root)
                                (make-array FileVisitOption 0))]
    (->> (iterator-seq (.iterator paths))
         (filter #(Files/isRegularFile
                   ^Path % (into-array LinkOption [LinkOption/NOFOLLOW_LINKS])))
         (remove #(Files/isSymbolicLink ^Path %))
         (map #(.toFile ^Path %))
         vec)))

(defn- scan [directory]
  (let [root (io/file directory)]
    (if-not (.isDirectory root)
      []
      (->> (jsonl-files root)
           (filter #(str/ends-with? (.getName ^java.io.File %) ".jsonl"))
           (map describe)
           (sort-by :updated-at #(compare %2 %1))
           vec))))

(def plugin
  {:id :session/catalog
   :description "Session JSONL discovery, metadata index, and parent catalog."
   :provides #{:session/catalog}
   :start
   (fn [ctx {:keys [directory]}]
     (let [directories (if directory
                         [directory]
                         [".qi-agent/sessions" ".bb-agent/sessions"])
           scan-all #(->> directories (mapcat scan)
                          (sort-by :updated-at (fn [left right]
                                                 (compare right left)))
                          vec)
           entries (atom (scan-all))
           refresh! #(reset! entries (scan-all))]
       (kernel/register-service!
        ctx :session/catalog
        {:directory (.getAbsolutePath (io/file (first directories)))
         :directories (mapv #(.getAbsolutePath (io/file %)) directories)
         :list (fn [] @entries)
         :refresh! refresh!
         :find (fn [session-id]
                 (some #(when (= session-id (:session-id %)) %) @entries))}))
     nil)})
