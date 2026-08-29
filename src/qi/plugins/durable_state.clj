(ns qi.plugins.durable-state
  "Small, session-scoped durable state stored outside the REPL heap."
  (:refer-clojure :exclude [get])
  (:require [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.secure-files :as secure]
            [clojure.edn :as edn]
            [clojure.java.io :as io])
  (:import [java.nio.file CopyOption Files StandardCopyOption]))

(defn- read-state [path]
  (if-not (.isFile (io/file path))
    {}
    (let [value (edn/read-string (slurp path))]
      (when-not (map? value)
        (throw (ex-info "Durable agent state must be an EDN map" {:path path})))
      value)))

(defn- write-state! [path value]
  (let [target (.getCanonicalFile (io/file path))
        parent (.getParentFile target)]
    (when-not (or (.isDirectory parent) (.mkdirs parent))
      (throw (ex-info "Could not create durable state directory"
                      {:path (str parent)})))
    (secure/protect-managed-parents! parent)
    (let [temporary (java.io.File/createTempFile ".state-" ".edn" parent)]
      (try
        (secure/protect-file! temporary)
        (spit temporary (str (pr-str value) "\n"))
        (try
          (Files/move (.toPath temporary) (.toPath target)
                      (into-array CopyOption
                                  [StandardCopyOption/ATOMIC_MOVE
                                   StandardCopyOption/REPLACE_EXISTING]))
          (catch Throwable error
            (if (.exists temporary)
              (Files/move (.toPath temporary) (.toPath target)
                          (into-array CopyOption
                                      [StandardCopyOption/REPLACE_EXISTING]))
              (throw error))))
        (finally
          (when (.exists temporary) (.delete temporary)))))
    (secure/protect-file! target)
    value))

(def plugin
  {:id :agent/durable-state
   :description "Session-scoped durable EDN state for worker and REPL recovery."
   :provides #{:agent/durable-state}
   :requires #{:session/store}
   :start
   (fn [ctx {:keys [root agent-id]
             :or {root "."}}]
     (let [store (kernel/require-service ctx :session/store)
           session-id (:session-id store)
           agent-id (or agent-id (qenv/get "QI_AGENT_ID" "DAO_AGENT_ID")
                        session-id)
           path (str (io/file root ".qi-agent" "artifacts" session-id
                              "agents" agent-id "state.edn"))
           lock (Object.)
           state (atom (read-state path))
           persist! (fn [next]
                      (locking lock
                        (let [value (if (fn? next) (next @state) next)]
                          (when-not (map? value)
                            (throw (ex-info "Durable state must remain a map" {})))
                          (write-state! path value)
                          (reset! state value))))
           service {:path path
                    :snapshot #(deref state)
                    :get #(clojure.core/get @state %)
                    :put! (fn [key value]
                            (persist! #(assoc % key value))
                            value)
                    :delete! (fn [key]
                               (let [present? (contains? @state key)]
                                 (persist! #(dissoc % key))
                                 present?))}]
       (kernel/register-service! ctx :agent/durable-state service)
       nil))})
