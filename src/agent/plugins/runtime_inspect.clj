(ns agent.plugins.runtime-inspect
  "Read-only model tool for inspecting the current Agent Kernel topology."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(def ^:private supported-actions
  #{"summary" "plugins" "services" "tools" "commands" "hooks"})

(defn- find-named [entries field name]
  (some #(when (= name (get % field)) %) entries))

(defn- inspect-runtime [ctx {:keys [action name]}]
  (when-not (contains? supported-actions action)
    (throw (ex-info (str "Unsupported runtime inspection action: " action)
                    {:type :runtime-inspect/unsupported-action
                     :action action
                     :supported (sort supported-actions)})))
  (let [snapshot (kernel/runtime-snapshot ctx)]
    (case action
      "summary" snapshot
      "plugins" {:plugins (:plugins snapshot)}
      "tools" {:tools (:tools snapshot)}
      "commands" {:commands (:commands snapshot)}
      "hooks" {:hooks (:hooks snapshot)}
      "services"
      (if (str/blank? name)
        {:services (:services snapshot)}
        (if-let [service (find-named (:services snapshot) :key name)]
          {:service service}
          (throw (ex-info (str "Runtime service was not found: " name)
                          {:type :runtime-inspect/not-found
                           :kind :service
                           :name name})))))))

(def plugin
  {:id :runtime/inspect
   :description "Expose bounded, read-only Agent Kernel topology to Creator sessions."
   :start
   (fn [ctx _config]
     (kernel/register-tool!
      ctx
      {:name "runtime_inspect"
       :description (str "Inspect the current Agent runtime without mutating it. "
                         "Lists loaded plugins, model tools, registered service ownership, "
                         "commands, and hook counts. Service values and executable functions "
                         "are never returned.")
       :strict true
       :parameters {:type "object"
                    :additionalProperties false
                    :properties
                    {:action {:type "string"
                              :enum (vec (sort supported-actions))
                              :description "Runtime view to return."}
                     :name {:type "string"
                            :description "Exact service key for a services lookup, such as :agent/llm."}}
                    :required ["action"]}
       :execute (fn [arguments _execution]
                  (inspect-runtime ctx arguments))})
     nil)})
