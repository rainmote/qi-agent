(ns agent.plugins.trust
  "User-controlled canonical project trust store with parent inheritance."
  (:require [agent.kernel :as kernel]
            [agent.secure-files :as secure]
            [clojure.edn :as edn]
            [clojure.java.io :as io])
  (:import [java.nio.file CopyOption Files StandardCopyOption]))

(defn- canonical [path]
  (.toPath (.getCanonicalFile (io/file (str path)))))

(defn- read-store [path]
  (if-not (.isFile (io/file path))
    {:roots {}}
    (let [value (edn/read-string (slurp path))]
      (when-not (and (map? value) (map? (:roots value)))
        (throw (ex-info "Trust store must contain a :roots map"
                        {:path path})))
      value)))

(defn- write-store-atomically! [path store]
  (let [target (.toPath (.getAbsoluteFile (io/file path)))
        parent (or (.getParent target)
                   (.toPath (.getCanonicalFile (io/file "."))))]
    (Files/createDirectories parent
                             (make-array java.nio.file.attribute.FileAttribute
                                         0))
    (secure/protect-managed-parents! parent)
    (let [temporary (Files/createTempFile
                     parent ".bb-agent-trust-" ".edn"
                     (make-array java.nio.file.attribute.FileAttribute 0))]
      (try
        (secure/protect-file! temporary)
        (spit (str temporary) (str (pr-str store) "\n"))
        (try
          (Files/move temporary target
                      (into-array
                       CopyOption
                       [StandardCopyOption/ATOMIC_MOVE
                        StandardCopyOption/REPLACE_EXISTING]))
          (catch Throwable error
            (if (Files/exists temporary
                              (make-array java.nio.file.LinkOption 0))
              (Files/move temporary target
                          (into-array CopyOption
                                      [StandardCopyOption/REPLACE_EXISTING]))
              (throw error))))
        (finally
          (Files/deleteIfExists temporary))))
    (secure/protect-file! target)
    (str target)))

(defn- normalize-decision [decision]
  (cond
    (contains? #{:allow true} decision) :allow
    (contains? #{:deny false} decision) :deny
    :else (throw (ex-info "Trust decisions must be :allow/:deny or booleans"
                          {:decision decision}))))

(defn- inherited-decision [roots target]
  (->> roots
       (map (fn [[path decision]]
              [(canonical path) (normalize-decision decision)]))
       (filter (fn [[root _]] (.startsWith target root)))
       (sort-by (fn [[root _]] (.getNameCount root)) >)
       first))

(defn default-trust-file []
  (str (io/file (System/getProperty "user.home") ".bb-agent" "trust.edn")))

(defn decision-info
  "Return the effective decision and whether it came from an explicit stored
  root. Missing decisions remain safely denied, while frontends can distinguish
  first use from a decision the user already made."
  ([root] (decision-info root (default-trust-file)))
  ([root trust-file]
   (if-let [[matched-root decision]
            (inherited-decision (:roots (read-store trust-file))
                                (canonical root))]
     {:decision decision
      :explicit? true
      :matched-root (str matched-root)
      :trust-file trust-file}
     {:decision :deny
      :explicit? false
      :matched-root nil
      :trust-file trust-file})))

(defn decision-for
  ([root] (decision-for root (default-trust-file)))
  ([root trust-file]
   (:decision (decision-info root trust-file))))

(defn trusted-root?
  ([root] (= :allow (decision-for root)))
  ([root trust-file] (= :allow (decision-for root trust-file))))

(defn set-decision!
  "Persist an explicit allow/deny decision for one canonical project root."
  ([root decision]
   (set-decision! root decision (default-trust-file)))
  ([root decision trust-file]
   (let [decision (normalize-decision decision)
         root (str (canonical root))
         store (read-store trust-file)
         updated (assoc-in store [:roots root] decision)]
     (write-store-atomically! trust-file updated)
     {:root root :decision decision :trust-file trust-file})))

(def plugin
  {:id :security/project-trust
   :description "Canonical user trust store with nearest-parent inheritance."
   :provides #{:project/trust}
   :start
   (fn [ctx config]
     (let [root (or (:root config) ".")
           trust-file (or (:trust-file config) (default-trust-file))
           workspace-root (canonical root)
           explicit? (contains? config :trusted)
           explicit (:trusted config)]
       (when (and explicit? (not (boolean? explicit)))
         (throw (ex-info ":trusted compatibility override must be boolean"
                         {:trusted explicit})))
       (let [decision-info-fn
             (fn []
               (if explicit?
                 {:decision (if explicit :allow :deny)
                  :explicit? true
                  :matched-root (str workspace-root)
                  :trust-file trust-file
                  :source :profile-compatibility}
                 (assoc (decision-info workspace-root trust-file)
                        :source :user-store)))
             decision #(:decision (decision-info-fn))
             setter (when-not explicit?
                      (fn [new-decision]
                        (set-decision! workspace-root new-decision trust-file)))]
         (kernel/register-service!
          ctx :project/trust
          {:root (str workspace-root)
           :trust-file trust-file
           :decision decision
           :decision-info decision-info-fn
           :trusted? #(= :allow (decision))
           :set-decision! setter
           :source (if explicit? :profile-compatibility :user-store)})))
     nil)})
