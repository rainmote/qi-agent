(ns qi.plugins.presets
  "Preset roster, authoring, and safe-by-default validation service."
  (:require [qi.kernel :as kernel]
            [qi.env :as qenv]
            [qi.presets :as presets]
            [clojure.java.io :as io]))

(defn- source-repository-root []
  (when-let [resource (io/resource "qi/presets.clj")]
    (when (= "file" (.getProtocol resource))
      (some-> resource io/file .getCanonicalFile
              .getParentFile .getParentFile .getParentFile str))))

(defn- default-system-root []
  (str (io/file (or (qenv/get "QI_AGENT_REPOSITORY_ROOT" "DAO_REPOSITORY_ROOT")
                    (source-repository-root)
                    (System/getProperty "user.dir"))
                "presets")))

(defn- default-user-root []
  (let [canonical (io/file (qenv/home) "presets")
        legacy (io/file (System/getProperty "user.home")
                        ".dao" "agent-presets")]
    (str (if (or (qenv/get "QI_AGENT_HOME")
                 (.isDirectory canonical)
                 (not (.isDirectory legacy)))
           canonical
           legacy))))

(def plugin
  {:id :agent/presets
   :description "System and user Agent preset discovery, authoring, and validation."
   :provides #{:agent/presets}
   :start
   (fn [ctx {:keys [system-roots user-root]}]
     (let [registry (presets/create-registry
                     {:system-roots (or system-roots [(default-system-root)])
                      :user-root (or user-root (default-user-root))})]
       (kernel/register-service!
        ctx :agent/presets
        {:roots registry
         :list #(presets/list-presets registry)
         :resolve #(presets/resolve-preset registry %)
         :read #(presets/read-preset registry %)
         :read-source #(presets/read-preset-source registry %)
         :copy! (fn
                  ([from id] (presets/copy-preset! registry from id))
                  ([from id name]
                   (presets/copy-preset! registry from id name)))
         :update! #(presets/update-preset! registry %1 %2)
         :delete! #(presets/delete-preset! registry %)
         :validate! (fn
                      ([id] (presets/validate-preset! registry id))
                      ([id options]
                       (presets/validate-preset! registry id options)))}))
     nil)})
