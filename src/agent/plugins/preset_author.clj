(ns agent.plugins.preset-author
  "Creator-only tools for safely authoring user Agent presets."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(defn- public-preset [preset]
  (cond-> (select-keys preset [:id :name :description :order :trust])
    (:broken preset) (assoc :broken true)))

(defn- required-string! [arguments key]
  (let [value (get arguments key)]
    (when-not (and (string? value) (not (str/blank? value)))
      (throw (ex-info (str "preset action requires `" (name key) "`")
                      {:type :preset-author/missing-argument
                       :argument key})))
    value))

(defn- inspect! [service {:keys [action id]}]
  (case action
    "list" {:presets (mapv public-preset ((:list service)))}
    "read" ((:read-source service) (required-string! {:id id} :id))
    "validate" ((:validate! service) (required-string! {:id id} :id))
    (throw (ex-info (str "Unsupported preset inspection action: " action)
                    {:type :preset-author/unsupported-action
                     :action action}))))

(defn- author! [service {:keys [action from id name description config] :as arguments}]
  (case action
    "copy"
    (let [source (required-string! {:from from} :from)
          target (required-string! {:id id} :id)]
      (public-preset
       (if (contains? arguments :name)
         ((:copy! service) source target name)
         ((:copy! service) source target))))

    "update"
    (let [target (required-string! {:id id} :id)
          updates (cond-> {}
                    (contains? arguments :config) (assoc :config config)
                    (contains? arguments :name) (assoc :name name)
                    (contains? arguments :description)
                    (assoc :description description))]
      (when (empty? updates)
        (throw (ex-info "preset update requires config, name, or description"
                        {:type :preset-author/missing-update :id target})))
      ((:update! service) target updates))

    "delete"
    {:id (required-string! {:id id} :id)
     :deleted ((:delete! service) id)}

    (throw (ex-info (str "Unsupported preset authoring action: " action)
                    {:type :preset-author/unsupported-action
                     :action action}))))

(defn- guide []
  {:workflow
   ["Inspect the roster and read a healthy source preset."
    "Copy an existing preset into a new user-owned id; prefer standard as the base."
    "Update the copied preset with a complete agent.edn EDN string and display metadata."
    "The update is parsed and structurally validated before atomic publication."
    "Validate once more, then start a new Session with that preset id; existing Sessions keep their immutable snapshot."]
   :boundaries
   ["System presets are read-only; always copy before changing one."
    "A preset is per-Session composition. Shared registries, credentials, persistence, sandbox and approval policy belong to the host profile."
    "Only core agent.* plugin namespaces are accepted in user presets. Arbitrary source, eval and load-string are not accepted."
    "Use runtime_inspect for live topology. Temporary runtime experiments, including bounded EDN Blueprints, do not persist into a preset."]})

(def plugin
  {:id :agent/preset-author
   :description "Safe Creator workflow for inspecting and authoring user Agent presets."
   :requires #{:agent/presets}
   :start
   (fn [ctx _config]
     (let [service (kernel/require-service ctx :agent/presets)]
       (kernel/register-tool!
        ctx
        {:name "preset_guide"
         :description "Read the required workflow and safety boundaries before creating or changing an Agent preset."
         :strict true
         :parameters {:type "object" :properties {} :additionalProperties false}
         :execute (fn [_ _] (guide))})
       (kernel/register-tool!
        ctx
        {:name "preset_inspect"
         :description "List Agent presets, read one preset's exact EDN source, or structurally validate it."
         :strict true
         :parameters {:type "object"
                      :additionalProperties false
                      :properties
                      {:action {:type "string" :enum ["list" "read" "validate"]}
                       :id {:type "string"
                            :description "Preset id required by read and validate."}}
                      :required ["action"]}
         :execute (fn [arguments _execution]
                    (inspect! service arguments))})
       (kernel/register-tool!
        ctx
        {:name "preset_author"
         :description (str "Copy, atomically update, or delete a user Agent preset. "
                           "System presets cannot be changed. Updates accept a complete "
                           "agent.edn EDN string and validate it before publication.")
         :strict true
         :execution-mode :sequential
         :approval-target (fn [{:keys [action id from]}]
                            {:provider :agent-presets
                             :path id
                             :command action
                             :source from})
         :parameters {:type "object"
                      :additionalProperties false
                      :properties
                      {:action {:type "string" :enum ["copy" "update" "delete"]}
                       :from {:type "string" :description "Source preset id for copy."}
                       :id {:type "string" :description "Target user preset id."}
                       :name {:type "string" :description "Optional non-blank display name."}
                       :description {:type "string" :description "Optional display description."}
                       :config {:type "string"
                                :description "Complete agent.edn EDN source for update."}}
                      :required ["action" "id"]}
         :execute (fn [arguments _execution]
                    (author! service arguments))}))
     nil)})
