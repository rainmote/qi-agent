(ns qi.plugins.runtime-lab
  "Creator-only lifecycle for audited built-ins and bounded EDN Blueprints."
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.runtime-blueprint :as blueprint]
            [clojure.string :as str]))

(def ^:private safe-catalog
  {'qi.plugins.math {:ns 'qi.plugins.math}})

(defn- allowed-specs [config]
  (let [requested (or (:allow config) [])]
    (when-not (and (vector? requested) (<= (count requested) 16))
      (throw (ex-info "Runtime lab :allow must be a vector with at most 16 entries"
                      {:type :runtime-lab/invalid-config})))
    (into (sorted-map)
          (map (fn [entry]
                 (let [namespace (:ns entry)]
                   (when-not (and (map? entry)
                                  (= #{:ns} (set (keys entry)))
                                  (contains? safe-catalog namespace))
                     (throw (ex-info "Runtime lab plugin is not in the audited safe catalog"
                                     {:type :runtime-lab/unsafe-plugin
                                      :entry entry})))
                   [(str namespace) (get safe-catalog namespace)])))
          requested)))

(defn- receipt [namespace plugin-id status]
  {:namespace namespace
   :plugin-id (str plugin-id)
   :status status})

(defn- status [allowed managed]
  {:plugins (mapv (fn [namespace]
                    {:namespace namespace
                     :status (if (contains? @managed namespace) "active" "inactive")})
                  (keys allowed))})

(defn- require-text! [arguments key]
  (let [value (get arguments key)]
    (when-not (and (string? value) (not (str/blank? value)))
      (throw (ex-info (str "Runtime plugin action requires `" (name key) "`")
                      {:type :runtime-lab/missing-argument
                       :argument key})))
    value))

(defn- package-summary [current next-package package]
  (cond-> (select-keys package [:package-id :kind :namespace :name :purpose
                                :tools])
    (= current (:package-id package)) (assoc :current true)
    (= next-package (:package-id package)) (assoc :next true)
    (:diagnostic package) (assoc :diagnostic (:diagnostic package))))

(defn- plugin-summary [[plugin-id definition]]
  {:plugin-id plugin-id
   :status (if (:active-plugin-id definition) "running" "stopped")
   :current-package-id (:current-package-id definition)
   :next-package-id (:next-package-id definition)
   :package-count (count (:packages definition))})

(defn- inspect-definitions [definitions {:keys [pluginId packageId]}]
  (if (str/blank? pluginId)
    {:plugins (->> (:plugins @definitions)
                   (map plugin-summary)
                   (sort-by :plugin-id)
                   vec)}
    (let [definition (get-in @definitions [:plugins pluginId])]
      (when-not definition
        (throw (ex-info (str "Runtime plugin was not found: " pluginId)
                        {:type :runtime-lab/plugin-not-found
                         :plugin-id pluginId})))
      (if (str/blank? packageId)
        (assoc (plugin-summary [pluginId definition])
               :packages (mapv #(package-summary
                                 (:current-package-id definition)
                                 (:next-package-id definition) %)
                               (:packages definition)))
        (let [package (some #(when (= packageId (:package-id %)) %)
                            (:packages definition))]
          (when-not package
            (throw (ex-info (str "Runtime package was not found: " packageId)
                            {:type :runtime-lab/package-not-found
                             :plugin-id pluginId
                             :package-id packageId})))
          (cond-> {:plugin-id pluginId
           :status (if (:active-plugin-id definition) "running" "stopped")
           :package (package-summary (:current-package-id definition)
                                     (:next-package-id definition)
                                     package)}
            (:source package) (assoc-in [:package :source] (:source package))))))))

(defn- next-plugin-id [definitions prefix]
  (when-not (and (string? prefix) (re-matches #"[a-z][a-z0-9-]{2,15}" prefix))
    (throw (ex-info "Runtime plugin idPrefix must contain 3-16 lowercase letters, digits, or hyphens"
                    {:type :runtime-lab/invalid-id-prefix
                     :id-prefix prefix})))
  (loop [index 1]
    (let [candidate (str prefix "-" index)]
      (if (contains? (:plugins @definitions) candidate)
        (recur (inc index))
        candidate))))

(defn- define-package! [allowed blueprints lifecycle definitions arguments]
  (let [namespace (:namespace arguments)
        source (:source arguments)
        source? (and (string? source) (not (str/blank? source)))
        namespace? (and (string? namespace) (not (str/blank? namespace)))]
    (when (= source? namespace?)
      (throw (ex-info "Runtime package define requires exactly one of `namespace` or `source`"
                      {:type :runtime-lab/ambiguous-package-source})))
    (when (and source? (not (:enabled blueprints)))
      (throw (ex-info "Runtime EDN Blueprints are disabled by the host profile"
                      {:type :runtime-lab/blueprints-disabled})))
    (let [spec (when namespace? (get allowed namespace))
          _ (when (and namespace? (nil? spec))
              (throw (ex-info (str "Plugin is not allowlisted: " namespace)
                              {:type :runtime-lab/not-allowlisted
                               :namespace namespace})))
          compiled (when source?
                     (blueprint/parse-blueprint source (:limits blueprints)))
          existing-id (when-not (str/blank? (:pluginId arguments))
                        (:pluginId arguments))
          plugin-id (if (str/blank? existing-id)
                      (next-plugin-id definitions
                                      (require-text! arguments :idPrefix))
                      existing-id)
          existing (get-in @definitions [:plugins plugin-id])
          _ (when (and existing-id (nil? existing))
              (throw (ex-info (str "Runtime plugin was not found: " plugin-id)
                              {:type :runtime-lab/plugin-not-found
                               :plugin-id plugin-id})))
          _ (when (and (nil? existing-id) existing)
              (throw (ex-info (str "Runtime plugin already exists: " plugin-id)
                              {:type :runtime-lab/plugin-exists
                               :plugin-id plugin-id})))
          _ (when (and (nil? existing-id)
                       (>= (count (get @definitions :plugins))
                           (:max-definitions lifecycle)))
              (throw (ex-info "Runtime plugin definition limit reached"
                              {:type :runtime-lab/definition-limit
                               :max-definitions (:max-definitions lifecycle)})))
          _ (when (>= (count (:packages existing))
                      (:max-packages-per-definition lifecycle))
              (throw (ex-info "Runtime package history limit reached"
                              {:type :runtime-lab/package-limit
                               :plugin-id plugin-id
                               :max-packages-per-definition
                               (:max-packages-per-definition lifecycle)})))
          index (inc (count (:packages existing)))
          package-id (str "pkg-" index)
          package (cond-> {:package-id package-id
                   :kind (if source? "blueprint" "builtin")
                   :name (require-text! arguments :name)
                   :purpose (require-text! arguments :purpose)
                   :spec spec}
                    namespace? (assoc :namespace namespace)
                    source? (assoc :source source
                                   :blueprint compiled
                                   :tools (mapv :name (:tools compiled))))]
      (swap! definitions update-in [:plugins plugin-id]
             (fn [value]
               (-> (or value {:packages []})
                   (update :packages conj package))))
      (-> package
          (assoc :plugin-id plugin-id :status "defined")
          (dissoc :spec :blueprint :source)))))

(defn- find-package! [definitions plugin-id package-id]
  (let [definition (get-in @definitions [:plugins plugin-id])]
    (when-not definition
      (throw (ex-info (str "Runtime plugin was not found: " plugin-id)
                      {:type :runtime-lab/plugin-not-found
                       :plugin-id plugin-id})))
    (or (some #(when (= package-id (:package-id %)) %) (:packages definition))
        (throw (ex-info (str "Runtime package was not found: " package-id)
                        {:type :runtime-lab/package-not-found
                         :plugin-id plugin-id
                         :package-id package-id})))))

(defn- mark-diagnostic! [definitions plugin-id package-id error]
  (swap! definitions update-in [:plugins plugin-id :packages]
         (fn [packages]
           (mapv #(if (= package-id (:package-id %))
                    (assoc % :diagnostic {:message (ex-message error)
                                          :type (some-> error ex-data :type str)})
                    %)
                 packages))))

(defn- load-package! [ctx definitions plugin-id package]
  (if-let [spec (:spec package)]
    (plugin/load-plugin! ctx spec)
    (let [state (or (get-in @definitions [:plugins plugin-id :state])
                    (atom (get-in package [:blueprint :initial-state])))
          owner (keyword "runtime.blueprint"
                         (str plugin-id "." (:package-id package)))]
      (swap! definitions update-in [:plugins plugin-id]
             #(if (:state %) % (assoc % :state state)))
      (blueprint/install! ctx owner (:blueprint package) state))))

(defn- run-package! [ctx definitions action {:keys [pluginId packageId]}]
  (let [plugin-id (require-text! {:pluginId pluginId} :pluginId)
        package-id (require-text! {:packageId packageId} :packageId)
        package (find-package! definitions plugin-id package-id)
        definition (get-in @definitions [:plugins plugin-id])
        current (:current-package-id definition)
        active-id (:active-plugin-id definition)]
    (when (and (= action "update") (nil? current))
      (throw (ex-info "Runtime plugin update requires a successfully run current package"
                      {:type :runtime-lab/update-without-current
                       :plugin-id plugin-id})))
    (when (and (= action "update") (= current package-id))
      (throw (ex-info "Runtime plugin update requires a different package"
                      {:type :runtime-lab/update-same-package
                       :plugin-id plugin-id :package-id package-id})))
    (when active-id (kernel/dispose-plugin! ctx active-id))
    (swap! definitions assoc-in [:plugins plugin-id :active-plugin-id] nil)
    (swap! definitions assoc-in [:plugins plugin-id :next-package-id] package-id)
    (try
      (let [loaded (load-package! ctx definitions plugin-id package)
            loaded-id (:id loaded)]
        (swap! definitions update-in [:plugins plugin-id]
               #(assoc % :active-plugin-id loaded-id
                         :current-package-id package-id
                         :next-package-id nil))
        {:plugin-id plugin-id
         :package-id package-id
         :plugin-run-id (str (random-uuid))
         :status "running"
         :current-package-id package-id})
      (catch Throwable error
        (mark-diagnostic! definitions plugin-id package-id error)
        ;; A failed update must not silently advance the current pointer. Best
        ;; effort restores the previously active package and records failure.
        (when (and active-id current (not= current package-id))
          (when-let [previous (some #(when (= current (:package-id %)) %)
                                    (:packages definition))]
            (try
              (let [restored (load-package! ctx definitions plugin-id previous)]
                (swap! definitions assoc-in
                       [:plugins plugin-id :active-plugin-id] (:id restored)))
              (catch Throwable _ nil))))
        (throw error)))))

(defn- stop-package! [ctx definitions plugin-id]
  (let [plugin-id (require-text! {:pluginId plugin-id} :pluginId)
        definition (get-in @definitions [:plugins plugin-id])]
    (when-not definition
      (throw (ex-info (str "Runtime plugin was not found: " plugin-id)
                      {:type :runtime-lab/plugin-not-found
                       :plugin-id plugin-id})))
    (when-let [active-id (:active-plugin-id definition)]
      (kernel/dispose-plugin! ctx active-id))
    (swap! definitions assoc-in [:plugins plugin-id :active-plugin-id] nil)
    {:plugin-id plugin-id :status "stopped"}))

(defn- undefine-package! [ctx definitions plugin-id]
  (let [result (stop-package! ctx definitions plugin-id)]
    (swap! definitions update :plugins dissoc plugin-id)
    (assoc result :status "undefined")))

(defn- execute! [ctx allowed blueprints lifecycle managed definitions
                 {:keys [action namespace pluginId] :as arguments}]
  (case action
    "status" (status allowed managed)
    "inspect" (inspect-definitions definitions arguments)
    "define" (define-package! allowed blueprints lifecycle definitions arguments)
    "run" (run-package! ctx definitions "run" arguments)
    "update" (run-package! ctx definitions "update" arguments)
    "stop" (stop-package! ctx definitions pluginId)
    "undefine" (undefine-package! ctx definitions pluginId)
    "activate"
    (let [spec (get allowed namespace)]
      (when-not spec
        (throw (ex-info (str "Plugin is not allowlisted: " namespace)
                        {:type :runtime-lab/not-allowlisted
                         :namespace namespace})))
      (if-let [plugin-id (get @managed namespace)]
        (receipt namespace plugin-id "active")
        (let [loaded (plugin/load-plugin! ctx spec)
              plugin-id (:id loaded)]
          (swap! managed assoc namespace plugin-id)
          (receipt namespace plugin-id "active"))))
    "deactivate"
    (do
      (when-not (contains? allowed namespace)
        (throw (ex-info (str "Plugin is not allowlisted: " namespace)
                        {:type :runtime-lab/not-allowlisted
                         :namespace namespace})))
      (if-let [plugin-id (get @managed namespace)]
        (do
          (kernel/dispose-plugin! ctx plugin-id)
          (swap! managed dissoc namespace)
          (receipt namespace plugin-id "inactive"))
        (receipt namespace (:id (plugin/resolve-plugin (get allowed namespace))) "inactive")))
    (throw (ex-info (str "Unsupported runtime plugin action: " action)
                    {:type :runtime-lab/unsupported-action
                     :action action}))))

(def plugin
  {:id :runtime/lab
   :description "Run reversible audited built-ins and bounded EDN Blueprint tools."
   :start
   (fn [ctx config]
     (let [allowed (allowed-specs config)
           blueprint-config (or (:blueprints config) {})
           _ (when-not (map? blueprint-config)
               (throw (ex-info "Runtime lab :blueprints must be a map"
                               {:type :runtime-lab/invalid-config})))
           _ (when-not (boolean? (get blueprint-config :enabled false))
               (throw (ex-info "Runtime lab :blueprints :enabled must be boolean"
                               {:type :runtime-lab/invalid-config})))
           max-definitions (get config :max-definitions 16)
           max-packages (get config :max-packages-per-definition 16)
           _ (when-not (and (pos-int? max-definitions)
                            (pos-int? max-packages))
               (throw (ex-info "Runtime lab lifecycle limits must be positive integers"
                               {:type :runtime-lab/invalid-config
                                :max-definitions max-definitions
                                :max-packages-per-definition max-packages})))
           unknown-blueprint-keys
           (seq (remove (conj (set (keys blueprint/default-limits)) :enabled)
                        (keys blueprint-config)))
           _ (when unknown-blueprint-keys
               (throw (ex-info "Runtime lab :blueprints contains unsupported keys"
                               {:type :runtime-lab/invalid-config
                                :keys (vec (sort unknown-blueprint-keys))})))
           blueprints {:enabled (get blueprint-config :enabled false)
                       :limits (blueprint/normalize-limits
                                (dissoc blueprint-config :enabled))}
           lifecycle {:max-definitions max-definitions
                      :max-packages-per-definition max-packages}
           managed (atom {})
           definitions (atom {:plugins {}})
           namespaces (vec (keys allowed))]
       (kernel/register-tool!
        ctx
        {:name "runtime_plugin"
         :description (str "Define immutable versions of audited built-ins or bounded Clojure EDN "
                           "Blueprints; inspect, "
                           "run, update, stop, or remove them. Legacy activate/deactivate/status actions "
                           "remain available. Blueprints compile a pure data DSL into reversible tools "
                           "with bounded state; symbols, Vars, Java interop, filesystem, network, eval, "
                           "and load-string are unavailable.")
         :execution-mode :sequential
         :strict false
         :parameters {:type "object"
                      :additionalProperties false
                      :properties
                      {:action {:type "string"
                                :enum ["inspect" "define" "run" "update" "stop"
                                       "undefine" "activate" "deactivate" "status"]}
                       :namespace {:type "string"
                                   :enum namespaces
                                   :description "Audited built-in namespace; mutually exclusive with source."}
                       :source {:type "string"
                                :maxLength (get-in blueprints
                                                   [:limits :max-source-chars])
                                :description "Complete bounded EDN Blueprint; mutually exclusive with namespace."}
                       :idPrefix {:type "string"
                                  :minLength 3
                                  :maxLength 16
                                  :description "Semantic id prefix for a new definition."}
                       :pluginId {:type "string"
                                  :maxLength 64
                                  :description "Existing runtime plugin id."}
                       :packageId {:type "string"
                                   :maxLength 32
                                   :description "Immutable package version id."}
                       :name {:type "string" :maxLength 120
                              :description "Short package name."}
                       :purpose {:type "string" :maxLength 500
                                 :description "One-sentence package purpose."}}
                      :required ["action"]}
         :execute (fn [arguments _execution]
                    (execute! ctx allowed blueprints lifecycle managed definitions
                              arguments))})
       (kernel/track-effect!
        ctx
        (fn []
          (doseq [plugin-id (keep :active-plugin-id
                                  (vals (:plugins @definitions)))]
            (kernel/dispose-plugin! ctx plugin-id))
          (doseq [plugin-id (reverse (vals @managed))]
            (kernel/dispose-plugin! ctx plugin-id))
          (reset! managed {})
          (reset! definitions {:plugins {}})))
       nil))})
