(ns qi.plugins.plugin-manager
  "Approved persistent distribution of data-only Blueprint/UI packages."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.env :as env]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin-package :as package]
            [qi.runtime-blueprint :as blueprint]
            [qi.secure-files :as secure]
            [qi.schema :as schema])
  (:import [java.nio.channels FileChannel]
           [java.nio.file CopyOption Files StandardCopyOption StandardOpenOption]))

(def actions ["list" "inspect" "install" "enable" "disable" "remove" "rollback"])
(def arguments-schema
  {:type "object" :additionalProperties false
   :properties {:action {:type "string" :enum actions}
                :id {:type "string" :maxLength 64}
                :source {:type "string" :maxLength 4096}
                :sha256 {:type "string" :pattern "^[a-f0-9]{64}$"}
                :commit {:type "string" :maxLength 64}
                :path {:type "string" :maxLength 1024}}
   :required ["action"]})
(defn- digest! [value]
  (when-not (and (string? value) (re-matches #"[a-f0-9]{64}" value))
    (package/fail! "Invalid stored package digest" {})) value)
(defn- bundle-file [directory digest]
  (io/file directory "objects" (str (digest! digest) ".edn")))
(defn- read-index [directory]
  (let [file (io/file directory "registry.edn")]
    (package/assert-no-symlinks! file)
    (if-not (.exists file) {:format 1 :packages {}}
      (let [result (package/read-edn (String. ^bytes (package/local-bundle file) "UTF-8"))]
        (when-not (and (= 1 (:format result)) (map? (:packages result)))
          (package/fail! "Plugin registry is invalid" {}))
        (doseq [[id entry] (:packages result)]
          (package/id! id) (digest! (:current entry))
          (when (:previous entry) (digest! (:previous entry)))
          (when-not (and (boolean? (:enabled entry)) (map? (:versions entry))
                         (contains? (:versions entry) (:current entry)))
            (package/fail! "Plugin registry entry is invalid" {}))
          (doseq [[digest metadata] (:versions entry)]
            (digest! digest) (package/version! (:version metadata))))
        result))))
(defn- write-atomic! [file bytes]
  (package/assert-no-symlinks! file)
  (let [parent (.getParentFile (io/file file))]
    (secure/protect-directory! parent)
    (let [temp (Files/createTempFile (.toPath parent) ".package-" ".partial"
                                    (make-array java.nio.file.attribute.FileAttribute 0))]
      (try
        (secure/protect-file! temp)
        (with-open [output (io/output-stream (.toFile temp))] (.write output ^bytes bytes))
        (Files/move temp (.toPath (io/file file))
                    (into-array CopyOption [StandardCopyOption/ATOMIC_MOVE StandardCopyOption/REPLACE_EXISTING]))
        (finally (Files/deleteIfExists temp))))))
(defn- persist! [directory index]
  (let [bytes (.getBytes (pr-str index) "UTF-8")]
    (when (> (alength bytes) package/max-bundle-bytes)
      (package/fail! "Plugin registry size limit reached" {}))
    (write-atomic! (io/file directory "registry.edn") bytes)))
(defn- stored-bundle [directory id digest]
  (let [result (package/parse-bundle (package/local-bundle (bundle-file directory digest)))]
    (when-not (and (= id (get-in result [:manifest :id])) (= digest (:sha256 result)))
      (package/fail! "Stored package identity or integrity check failed" {:id id}))
    result))
(defn- system-packages [directories]
  (reduce
   (fn [result directory]
     (package/assert-no-symlinks! directory)
     (reduce (fn [result file]
               (if-not (str/ends-with? (.getName file) ".edn") result
                 (let [bundle (package/parse-bundle (package/local-bundle file))
                       id (get-in bundle [:manifest :id])]
                   (when (contains? result id) (package/fail! "Duplicate system package id" {:id id}))
                   (assoc result id bundle))))
             result (sort-by #(.getName %) (filter #(.isFile %) (.listFiles (io/file directory))))))
   {} directories))
(defn- owner [id] (keyword "package" id))
(defn- stop! [ctx active id]
  (when (contains? @active id)
    (kernel/dispose-plugin! ctx (owner id))
    (swap! active dissoc id)))
(defn- start! [ctx active id bundle prior-state]
  (let [compiled (:compiled bundle)
        state (or prior-state (atom (:initial-state compiled)))]
    (when compiled (blueprint/install! ctx (owner id) compiled state))
    (swap! active assoc id {:bundle bundle :state state})))
(defn- with-transition! [ctx active id bundle enabled persist]
  (let [previous (get @active id)]
    (stop! ctx active id)
    (try
      (when enabled (start! ctx active id bundle (:state previous)))
      (persist)
      (catch Throwable error
        (stop! ctx active id)
        (when previous
          (try (start! ctx active id (:bundle previous) (:state previous))
               (catch Throwable rollback-error
                 (throw (ex-info "Plugin update failed and runtime restoration also failed"
                                 {:type :plugin-package/rollback-failed
                                  :original-error (ex-message error)
                                  :rollback-error (ex-message rollback-error)})))))
        (throw error)))))
(defn- dependencies! [active bundle]
  (doseq [{:keys [id version]} (get-in bundle [:manifest :requires])]
    (when-not (= version (get-in @active [id :bundle :manifest :version]))
      (package/fail! "Package dependency must be enabled at the exact required version"
                     {:dependency id :version version}))))
(defn- dependents! [ctx-active id next-version]
  (doseq [[other {:keys [bundle]}] @ctx-active
          dep (get-in bundle [:manifest :requires])]
    (when (and (not= id (get-in bundle [:manifest :id])) (= id (:id dep)) (not= next-version (:version dep)))
      (package/fail! "An enabled package requires this exact version; disable the dependent first"
                     {:dependent (get-in bundle [:manifest :id]) :dependency id :version (:version dep)}))))
(defn- require-trust! [ctx]
  (let [trust (kernel/service ctx :project/trust)]
    (when-not (and trust ((:trusted? trust)))
      (throw (ex-info "Plugin management requires a trusted workspace"
                      {:type :plugin-package/trust-required})))))
(defn- plan-gate! [ctx action]
  (when-let [planning (kernel/service ctx :planning/runtime)]
    (when-not ((:permitted? planning) "plugin_manage" action)
      (package/fail! "Plan mode does not permit plugin mutations before approved execution" {}))))
(defn- authorize! [ctx arguments execution]
  (require-trust! ctx)
  (let [approve (kernel/service ctx :approval/request)
        target {:provider "plugin-packages" :path (or (:source arguments) (:id arguments))
                :command (pr-str (select-keys arguments [:action :id :source :sha256 :commit :path :expected-current]))}
        decision (when approve (approve {:tool "plugin_manage" :arguments arguments :target target
                                         :cancel-token (:cancel-token execution)
                                         :call-id (:call-id execution)}))]
    (when-not (= :allow decision)
      (throw (ex-info "Plugin mutation was not approved"
                      {:type :plugin-package/approval-required}))))
  true)
(defn- summary [id entry bundle system? active]
  (merge (select-keys (:manifest bundle) [:id :name :description :version :requires])
         {:id id :sha256 (:sha256 bundle) :scope (if system? "system" "user")
          :read-only system? :enabled (boolean (:enabled entry))
          :active (= (:sha256 bundle) (get-in @active [id :bundle :sha256]))
          :restart-required (if (:enabled entry)
                              (not= (:sha256 bundle) (get-in @active [id :bundle :sha256]))
                              (contains? @active id))
          :tools (mapv :name (get-in bundle [:compiled :tools]))
          :ui-slots (count (get-in bundle [:manifest :ui]))
          :previous (:previous entry)
          :versions (mapv (fn [[digest metadata]] (assoc metadata :sha256 digest))
                          (sort-by (comp :version val) (:versions entry)))
          :impact {:runtime "current-session" :persistence "future-sessions"
                   :other-sessions "restart-required"}}))

(defn create-manager
  "Build a manager; user-dir/system-dirs are host configuration, never tool arguments."
  [ctx {:keys [user-dir system-dirs] :or {system-dirs []}}]
  (when-not (and (vector? system-dirs) (every? string? system-dirs))
    (package/fail! ":system-dirs must be a vector of paths" {}))
  (let [directory (or user-dir (str (io/file (env/home) "plugin-packages")))
        _ (package/assert-no-symlinks! directory)
        systems (system-packages system-dirs)
        active (atom {})
        disposed? (atom false)
        startup-errors (atom {})
        lock (Object.)
        inventory (fn []
                    (let [index (read-index directory)]
                      (concat
                       (for [[id bundle] systems]
                         (summary id {:enabled true} bundle true active))
                       (for [[id entry] (:packages index)]
                         (summary id entry (stored-bundle directory id (:current entry)) false active)))))
        inspect (fn [{:keys [id]}]
                  (package/id! id)
                  (or (some #(when (= id (:id %)) %) (inventory))
                      (package/fail! "Plugin package was not found" {:id id})))
        mutate
        (fn [{:keys [action id] :as arguments} prepared]
          (let [index (read-index directory)
                candidate prepared
                id (or (get-in candidate [:manifest :id]) (package/id! id))
                _ (when (and (:id arguments) (not= (:id arguments) id))
                    (package/fail! "Requested id does not match bundle id" {}))
                _ (when (contains? systems id) (package/fail! "System packages are read-only" {:id id}))
                entry (get-in index [:packages id])
                _ (when (and (contains? arguments :expected-current)
                             (not= (:expected-current arguments) (:current entry)))
                    (package/fail! "Package changed while awaiting approval; inspect and retry" {:id id}))
                ;; Keep persisted and running versions separately: another
                ;; session can update a dependency while this one still uses it.
                dependent-state (atom (into {}
                                       (concat
                                        (for [[other item] (:packages index) :when (:enabled item)]
                                          [[other :saved] {:bundle (stored-bundle directory other (:current item))}])
                                        (for [[other item] systems] [[other :system] {:bundle item}])
                                        (for [[other item] @active] [[other :active] item]))))]
            (when (and (not= "install" action) (nil? entry))
              (package/fail! "Plugin package was not found" {:id id}))
            (case action
              "install"
              (let [digest (:sha256 candidate) version (get-in candidate [:manifest :version])
                    conflict (some (fn [[other metadata]]
                                     (and (= version (:version metadata)) (not= digest other)))
                                   (:versions entry))
                    _ (when (and (nil? entry) (>= (count (:packages index)) 64))
                        (package/fail! "Installed package limit reached" {}))
                    _ (when (and (not (contains? (:versions entry) digest))
                                 (>= (count (:versions entry)) 16))
                        (package/fail! "Package version history limit reached" {}))
                    _ (when conflict (package/fail! "Package versions are immutable; use a new version" {}))
                    _ (dependents! dependent-state id version)
                    _ (when (:enabled entry) (dependencies! active candidate))
                    next-entry (-> (or entry {:enabled false :versions {}})
                                   (assoc :current digest)
                                   (cond-> (and (:current entry) (not= digest (:current entry)))
                                     (assoc :previous (:current entry)))
                                   (assoc-in [:versions digest] {:version version :source (:source candidate)}))
                    next-index (assoc-in index [:packages id] next-entry)
                    file (bundle-file directory digest)]
                (when-not (.exists file) (write-atomic! file (:bytes candidate)))
                ;; Re-read the object even for an existing digest to reject local corruption.
                (stored-bundle directory id digest)
                (with-transition! ctx active id candidate (:enabled next-entry)
                                  #(persist! directory next-index))
                (summary id next-entry candidate false active))
              "rollback"
              (let [digest (or (:previous entry) (package/fail! "No previous package version is available" {}))
                    bundle (stored-bundle directory id digest)
                    next-entry (assoc entry :current digest :previous (:current entry))]
                (dependents! dependent-state id (get-in bundle [:manifest :version]))
                (when (:enabled entry) (dependencies! active bundle))
                (with-transition! ctx active id bundle (:enabled entry)
                                  #(persist! directory (assoc-in index [:packages id] next-entry)))
                (summary id next-entry bundle false active))
              ("enable" "disable" "remove")
              (let [bundle (stored-bundle directory id (:current entry))
                    enabled (= action "enable")
                    next-entry (assoc entry :enabled enabled)
                    next-index (if (= action "remove") (update index :packages dissoc id)
                                   (assoc-in index [:packages id] next-entry))]
                (if enabled (dependencies! active bundle) (dependents! dependent-state id nil))
                (with-transition! ctx active id bundle enabled #(persist! directory next-index))
                (if (= action "remove")
                  {:id id :removed true :restart-required false
                   :retained-objects true
                   :impact {:runtime "current-session" :persistence "future-sessions"
                            :other-sessions "restart-required"}}
                  (summary id next-entry bundle false active)))
              (package/fail! "Unsupported plugin action" {:action action}))))
        execute
        (fn [{:keys [action] :as arguments} execution]
          (schema/validate! arguments-schema arguments)
          (case action
            "list" {:plugins (vec (sort-by :id (inventory))) :diagnostics @startup-errors}
            "inspect" (inspect arguments)
            (do
              (when-not (some #{action} actions) (package/fail! "Unsupported plugin action" {}))
              (when @disposed? (package/fail! "Plugin manager is stopping" {}))
              (cancellation/throw-if-cancelled! (:cancel-token execution))
              (require-trust! ctx)
              (plan-gate! ctx action)
              (let [candidate (when (= "install" action) (package/read-source arguments))
                    _ (when (and candidate (:id arguments)
                                 (not= (:id arguments) (get-in candidate [:manifest :id])))
                        (package/fail! "Requested id does not match bundle id" {}))
                    arguments (if candidate
                                (assoc arguments :source (if (= "local" (get-in candidate [:source :kind]))
                                                           (.getCanonicalPath (io/file (:source arguments)))
                                                           (:source arguments))
                                       :sha256 (:sha256 candidate) :id (get-in candidate [:manifest :id]))
                                arguments)
                    arguments (cond-> arguments
                                (:id arguments) (assoc :expected-current
                                                       (get-in (read-index directory) [:packages (:id arguments) :current])))]
                (cancellation/throw-if-cancelled! (:cancel-token execution))
                (authorize! ctx arguments execution)
              (locking lock
                (when @disposed? (package/fail! "Plugin manager is stopping" {}))
                (cancellation/throw-if-cancelled! (:cancel-token execution))
                (plan-gate! ctx action)
                (package/assert-no-symlinks! directory)
                (secure/protect-directory! directory)
                (let [lock-file (io/file directory ".lock")]
                  (package/assert-no-symlinks! lock-file)
                  (secure/ensure-owner-file! lock-file)
                  (with-open [channel (FileChannel/open (.toPath lock-file)
                                                        (into-array StandardOpenOption [StandardOpenOption/WRITE]))]
                    (let [_ (.lock channel)
                          result (mutate arguments candidate)]
                      ;; Closing the channel releases its lock on both JVM and Babashka.
                      (kernel/emit! ctx :plugins/changed {:action action :id (:id result)})
                      result))))))))
        slots (fn []
                {:slots (vec (mapcat (fn [[id {:keys [bundle]}]]
                                      (map #(assoc % :package-id id :version (get-in bundle [:manifest :version]))
                                           (get-in bundle [:manifest :ui])))
                                    (sort-by key @active)))})]
    (when (and (kernel/service ctx :project/trust)
               ((:trusted? (kernel/service ctx :project/trust))))
      (let [index (read-index directory)
            pending (merge systems (into {} (for [[id entry] (:packages index) :when (:enabled entry)]
                                               [id (stored-bundle directory id (:current entry))])))]
        (when (some (set (keys systems)) (keys (:packages index)))
          (package/fail! "User package shadows a read-only system package" {}))
        (loop [pending pending]
          (when (seq pending)
            (let [ready (filter (fn [[_ bundle]]
                                  (every? #(= (:version %) (get-in @active [(:id %) :bundle :manifest :version]))
                                          (get-in bundle [:manifest :requires]))) pending)]
              (if (empty? ready)
                (swap! startup-errors merge (into {} (map (fn [[id _]] [id "Missing, disabled or cyclic dependency"]) pending)))
                (do
                  (doseq [[id bundle] ready]
                    (try (start! ctx active id bundle nil)
                         (catch Throwable error (swap! startup-errors assoc id (ex-message error)))))
                  (recur (apply dissoc pending (map first ready))))))))))
    {:list! #(execute {:action "list"} {}) :inspect! inspect :execute! execute :slots! slots
     :dispose! #(locking lock
                  (reset! disposed? true)
                  (doseq [id (keys @active)] (stop! ctx active id)))}))

(def plugin
  {:id :runtime/plugin-manager
   :description "Approved immutable Blueprint and declarative UI package lifecycle."
   :provides #{:plugins/manager}
   :start (fn [ctx config]
            (let [manager (create-manager ctx config)]
              (kernel/track-effect! ctx (:dispose! manager))
              (kernel/register-service! ctx :plugins/manager (dissoc manager :dispose!))
              (kernel/register-tool! ctx
                {:name "plugin_manage"
                 :description (str "List/inspect or install/enable/disable/remove/rollback pinned data-only plugin bundles. "
                                   "Mutations always check workspace trust and resolved-target approval. HTTPS and Git sources "
                                   "require SHA-256; Git also requires a full commit and relative EDN path. No install scripts, "
                                   "arbitrary code or HTML run. New packages install disabled. Changes affect this session "
                                   "and future sessions; other active sessions require restart.")
                 :strict false :execution-mode :sequential :parameters arguments-schema
                 :execute (:execute! manager)})
              nil))})
