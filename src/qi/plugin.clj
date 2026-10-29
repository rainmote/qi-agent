(ns qi.plugin
  "EDN-driven namespace plugin loader."
  (:require [qi.kernel :as kernel]
            [qi.lifecycle :as lifecycle]
            [clojure.edn :as edn]
            [clojure.java.io :as io]))

(defn read-config [path]
  (let [file (io/file path)]
    (when-not (.isFile file)
      (throw (ex-info (str "Config file not found: " path) {:path path})))
    (edn/read-string (slurp file))))

(defn- canonical-plugin-namespace [namespace]
  (let [value (str namespace)]
    (if (.startsWith value "agent.plugins.")
      (symbol (str "qi.plugins." (subs value (count "agent.plugins."))))
      namespace)))

(defn resolve-plugin [{:keys [ns] :as spec}]
  (when-not (symbol? ns)
    (throw (ex-info "Plugin :ns must be an EDN symbol" {:spec spec})))
  (let [resolved-ns (canonical-plugin-namespace ns)]
    (require resolved-ns)
    (let [plugin-var (ns-resolve resolved-ns 'plugin)
        descriptor (some-> plugin-var deref)]
      (when-not (and (map? descriptor)
                     (keyword? (:id descriptor))
                     (fn? (:start descriptor)))
        (throw (ex-info (str resolved-ns " must expose a valid `plugin` map")
                        {:namespace resolved-ns})))
      (assoc descriptor :resolved-namespace resolved-ns))))

(defn- start-plugin! [ctx {:keys [config] :or {config {}} :as spec} descriptor & [resume-generation]]
  (let [{:keys [id requires provides start]} descriptor
        already-loaded (set (map :id (kernel/loaded-plugins ctx)))
        missing (seq (remove (set (keys (lifecycle/bindings @(:state ctx) requires))) requires))]
    (when (contains? already-loaded id)
      (throw (ex-info (str "Plugin already loaded: " id) {:plugin id})))
    (when missing
      (throw (ex-info (str "Plugin " id " is missing required services")
                      {:plugin id :missing (set missing)})))
    (let [plugin-ctx (kernel/begin-plugin!
                      ctx id {:requires (set requires)
                              :bindings (lifecycle/bindings @(:state ctx) requires)
                              :resume-generation resume-generation
                              :restart! #(start-plugin! ctx spec descriptor %)})]
      (try
        (kernel/with-plugin-call
         plugin-ctx
         (fn []
           (when-let [dispose (start plugin-ctx config)]
             (when-not (fn? dispose)
               (throw (ex-info "Plugin start must return nil or a disposer" {:plugin id})))
             (kernel/track-effect! plugin-ctx dispose))
           (let [missing-provides (seq (remove (kernel/service-keys plugin-ctx) provides))]
             (when missing-provides
               (throw (ex-info (str "Plugin " id " did not provide declared services")
                               {:plugin id :missing (set missing-provides)}))))
           (kernel/mark-loaded!
            plugin-ctx {:id id
                        :namespace (or (:resolved-namespace descriptor) (:ns spec))
                        :description (:description descriptor)})))
        (catch Throwable error
          (kernel/dispose-plugin! ctx id {:generation (:plugin/generation plugin-ctx)})
          (throw error))))))

(defn load-plugin! [ctx spec]
  (let [result (start-plugin! ctx spec (resolve-plugin spec))]
    (kernel/await-reconciliation! ctx)
    result))

(defn- core-namespace? [namespace]
  (let [value (str namespace)]
    (or (= "qi" value)
        (.startsWith value "qi.")
        (= "agent" value)
        (.startsWith value "agent."))))

(defn load-all!
  ([ctx plugin-specs] (load-all! ctx plugin-specs {}))
  ([ctx plugin-specs {:keys [allow-external-plugins]
                      :or {allow-external-plugins true}}]
  (doseq [spec plugin-specs]
    (when (and (not allow-external-plugins)
               (not (core-namespace? (:ns spec))))
      (throw (ex-info "Project plugin requires trust from the user trust store"
                      {:namespace (:ns spec)})))
    (load-plugin! ctx spec))
  ctx))

(defn boot!
  ([config] (boot! config {}))
  ([config options]
  (let [ctx (kernel/create-context)]
    (try
      (load-all! ctx (:plugins config) options)
      ctx
      (catch Throwable error
        (kernel/dispose-all! ctx)
        (throw error))))))
