(ns qi.presets
  "Discovery and lifecycle management for system and user Agent presets."
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.channels Channels]
           [java.nio.charset StandardCharsets]
           [java.nio.file Files LinkOption OpenOption Path StandardCopyOption StandardOpenOption]
           [java.nio.file.attribute BasicFileAttributes FileAttribute]))

(def ^:private preset-id-pattern #"^[a-z0-9][a-z0-9-]*$")

(defn valid-preset-id? [value]
  (and (string? value)
       (<= (count value) 128)
       (boolean (re-matches preset-id-pattern value))))

(defn- canonical-file [path]
  (.getCanonicalFile (io/file path)))

(defn- contained? [root child]
  (let [root-path (.toPath (canonical-file root))
        child-path (.toPath (canonical-file child))]
    (.startsWith child-path root-path)))

(defn create-registry
  [{:keys [system-roots user-root]}]
  {:system-roots (mapv #(str (canonical-file %)) (or system-roots []))
   :user-root (when user-root (str (canonical-file user-root)))})

(def ^:private max-metadata-bytes 65536)
(def ^:private max-config-bytes 1048576)
(def ^:private no-follow-link-options (make-array LinkOption 0))

(defn- path-identity [path]
  (let [attributes (Files/readAttributes path BasicFileAttributes
                                         no-follow-link-options)]
    {:file-key (.fileKey attributes)
     :size (.size attributes)
     :modified (.lastModifiedTime attributes)
     :regular? (.isRegularFile attributes)
     :directory? (.isDirectory attributes)
     :symbolic-link? (.isSymbolicLink attributes)}))

(defn- read-bounded-text [file label max-bytes]
  (let [path (.toPath (io/file file))
        parent (.getParent path)
        parent-before (path-identity parent)
        file-before (path-identity path)
        bytes
        (with-open [channel (Files/newByteChannel
                             path
                             (into-array OpenOption
                                         [StandardOpenOption/READ
                                          LinkOption/NOFOLLOW_LINKS]))
                    input (Channels/newInputStream channel)]
          (.readNBytes input (inc max-bytes)))
        file-after (path-identity path)
        parent-after (path-identity parent)]
    (when (or (not= parent-before parent-after)
              (not= file-before file-after)
              (not (:directory? parent-after))
              (not (:regular? file-after)))
      (throw (ex-info (str label " changed while it was being read")
                      {:type :preset-concurrent-modification
                       :path (str file)})))
    (when (> (alength bytes) max-bytes)
      (throw (ex-info (str label " is too large")
                      {:path (str file) :limit max-bytes})))
    (String. bytes StandardCharsets/UTF_8)))

(defn- read-bounded-edn [file label max-bytes]
  (edn/read-string (read-bounded-text file label max-bytes)))

(defn- read-metadata [file]
  (let [value (read-bounded-edn file "preset.edn" max-metadata-bytes)]
    (when-not (map? value)
      (throw (ex-info "preset.edn must contain a map" {:path (str file)})))
    (when (and (contains? value :name)
               (not (and (string? (:name value))
                         (not (str/blank? (:name value))))))
      (throw (ex-info "preset.edn :name must be a non-blank string"
                      {:path (str file)})))
    (when (and (contains? value :description)
               (not (string? (:description value))))
      (throw (ex-info "preset.edn :description must be a string"
                      {:path (str file)})))
    (when (and (contains? value :order)
               (not (integer? (:order value))))
      (throw (ex-info "preset.edn :order must be an integer"
                      {:path (str file)})))
    value))

(defn- read-config-file [file]
  (let [config (read-bounded-edn file "agent.edn" max-config-bytes)]
    (when-not (and (map? config) (vector? (:plugins config)))
      (throw (ex-info "agent.edn must contain a map with a :plugins vector"
                      {:path (str file)})))
    config))

(defn- ensure-preset-file! [file label]
  (let [path (.toPath (io/file file))
        options (make-array LinkOption 0)]
    (when-not (Files/exists path options)
      (throw (ex-info (str label " is missing") {:path (str file)})))
    (when-not (and (Files/isRegularFile path options)
                   (not (Files/isSymbolicLink path)))
      (throw (ex-info (str label " must be a regular non-symbolic-link file")
                      {:path (str file)})))))

(defn- discover-one [root trust directory]
  (let [id (.getName ^java.io.File directory)
        metadata-file (io/file directory "preset.edn")
        config-file (io/file directory "agent.edn")]
    (when (and (valid-preset-id? id)
               (.isDirectory ^java.io.File directory)
               (not (Files/isSymbolicLink (.toPath ^java.io.File directory)))
               (contained? root directory))
      (try
        (ensure-preset-file! metadata-file "preset.edn")
        (ensure-preset-file! config-file "agent.edn")
        (let [metadata (read-metadata metadata-file)
              _ (read-config-file config-file)]
          (merge
           {:id id
            :trust trust
            :directory (str (canonical-file directory))
            :config-path (str (canonical-file config-file))}
           (select-keys metadata [:name :description :order])))
        (catch Throwable error
          {:id id
           :name id
           :trust trust
           :directory (str (canonical-file directory))
           :config-path (str (.getAbsoluteFile config-file))
           :broken (ex-message error)})))))

(defn- root-presets [root trust]
  (let [directory (canonical-file root)]
    (if-not (.isDirectory directory)
      []
      (->> (or (.listFiles directory) (make-array java.io.File 0))
           (keep #(discover-one directory trust %))
           (sort-by (juxt #(or (:order %) Long/MAX_VALUE)
                          #(str/lower-case (or (:name %) (:id %)))))
           vec))))

(defn list-presets [registry]
  (let [system (mapcat #(root-presets % :system) (:system-roots registry))
        user (if-let [root (:user-root registry)]
               (root-presets root :user)
               [])]
    (->> (concat system user)
         (reduce (fn [{:keys [seen rows] :as acc} preset]
                   (if (contains? seen (:id preset))
                     acc
                     {:seen (conj seen (:id preset))
                      :rows (conj rows preset)}))
                 {:seen #{} :rows []})
         :rows)))

(defn resolve-preset [registry id]
  (when-not (valid-preset-id? id)
    (throw (ex-info "Invalid preset id"
                    {:type :invalid-preset-id :id id})))
  (let [preset (some #(when (= id (:id %)) %) (list-presets registry))]
    (when-not preset
      (throw (ex-info (str "Unknown preset: " id)
                      {:type :unknown-preset
                       :id id
                       :available (mapv :id (list-presets registry))})))
    (when-let [reason (:broken preset)]
      (throw (ex-info (str "Preset is broken: " id ": " reason)
                      {:type :broken-preset :id id :reason reason})))
    preset))

(defn read-preset [registry id]
  (let [preset (resolve-preset registry id)]
    (read-config-file (:config-path preset))))

(defn read-preset-source
  "Read the editable source and metadata for a known healthy preset."
  [registry id]
  (let [preset (resolve-preset registry id)
        directory (io/file (:directory preset))]
    {:id id
     :trust (:trust preset)
     :metadata (select-keys (read-metadata (io/file directory "preset.edn"))
                            [:name :description :order])
     :config (read-bounded-text (io/file directory "agent.edn")
                                "agent.edn" max-config-bytes)}))

(def ^:private max-copy-entries 512)
(def ^:private max-copy-depth 16)
(def ^:private max-copy-file-bytes (* 4 1024 1024))
(def ^:private max-copy-total-bytes (* 16 1024 1024))
(def ^:private no-link-options (make-array LinkOption 0))
(def ^:private no-file-attributes (make-array FileAttribute 0))

(defn- walked-paths [root]
  (with-open [stream (Files/walk root (make-array java.nio.file.FileVisitOption 0))]
    (vec (iterator-seq (.iterator stream)))))

(defn- bounded-copy-paths [root]
  (with-open [stream (Files/walk root (inc max-copy-depth)
                                (make-array java.nio.file.FileVisitOption 0))]
    (->> (iterator-seq (.iterator stream))
         (take (inc max-copy-entries))
         vec)))

(defn- copy-limit-error [message limit]
  (ex-info message {:type :preset-copy-limit :limit limit}))

(defn- copy-file-bounded! [source destination total-bytes]
  (Files/createDirectories (.getParent destination) no-file-attributes)
  (with-open [channel (Files/newByteChannel
                       source
                       (into-array OpenOption
                                   [StandardOpenOption/READ
                                    LinkOption/NOFOLLOW_LINKS]))
              input (Channels/newInputStream channel)
              output (Files/newOutputStream
                      destination
                      (into-array OpenOption
                                  [StandardOpenOption/CREATE_NEW
                                   StandardOpenOption/WRITE]))]
    (let [buffer (byte-array 8192)]
      (loop [file-bytes 0]
        (let [read-count (.read input buffer)]
          (when-not (= -1 read-count)
            (let [next-file-bytes (+ file-bytes read-count)
                  next-total-bytes (+ @total-bytes read-count)]
              (when (> next-file-bytes max-copy-file-bytes)
                (throw (copy-limit-error "Preset contains an oversized file"
                                         max-copy-file-bytes)))
              (when (> next-total-bytes max-copy-total-bytes)
                (throw (copy-limit-error "Preset copy is too large"
                                         max-copy-total-bytes)))
              (.write output buffer 0 read-count)
              (reset! total-bytes next-total-bytes)
              (recur next-file-bytes))))))))

(defn- copy-tree! [source target]
  (let [paths (bounded-copy-paths source)
        total-bytes (atom 0)]
    (when (> (count paths) max-copy-entries)
      (throw (copy-limit-error "Preset contains too many entries"
                               max-copy-entries)))
    (doseq [path paths]
      (let [relative (.relativize ^Path source ^Path path)
            destination (.resolve ^Path target ^Path relative)
            depth (.getNameCount relative)]
        (when (> depth max-copy-depth)
          (throw (copy-limit-error "Preset directory nesting is too deep"
                                   max-copy-depth)))
        (cond
          (Files/isSymbolicLink path)
          (throw (ex-info "Preset copies cannot contain symbolic links"
                          {:type :preset-symbolic-link :path (str path)}))

          (Files/isDirectory path no-link-options)
          (Files/createDirectories destination no-file-attributes)

          (Files/isRegularFile path no-link-options)
          (copy-file-bounded! path destination total-bytes)

          :else
          (throw (ex-info "Preset copies may contain only regular files and directories"
                          {:type :preset-special-file :path (str path)})))))
    (doseq [path (walked-paths target)]
      (when (Files/isSymbolicLink path)
        (throw (ex-info "Preset copies cannot contain symbolic links"
                        {:type :preset-symbolic-link :path (str path)}))))))

(defn- delete-tree! [directory]
  (let [root (.toPath (io/file directory))]
    (when (Files/exists root no-link-options)
      (doseq [path (reverse (walked-paths root))]
        (Files/deleteIfExists path))))
  true)

(defn- move-directory! [source target]
  (try
    (Files/move source target
                (into-array StandardCopyOption
                            [StandardCopyOption/ATOMIC_MOVE]))
    (catch Throwable error
      (if (and (Files/exists source no-link-options)
               (not (Files/exists target no-link-options)))
        (Files/move source target (make-array StandardCopyOption 0))
        (throw error)))))

(defn copy-preset!
  ([registry from id] (copy-preset! registry from id nil))
  ([registry from id name]
   (when-not (valid-preset-id? id)
     (throw (ex-info "Invalid preset id"
                     {:type :invalid-preset-id :id id})))
   (when-not (:user-root registry)
     (throw (ex-info "Preset registry has no writable user root"
                     {:type :missing-user-preset-root})))
   (when (some #(= id (:id %)) (list-presets registry))
     (throw (ex-info (str "Preset already exists: " id)
                     {:type :preset-exists :id id})))
   (let [source (resolve-preset registry from)
         user-root (canonical-file (:user-root registry))
         _ (.mkdirs user-root)
         target (io/file user-root id)
         target-path (canonical-file target)
         temporary (io/file user-root (str ".copy-" (random-uuid)))
         metadata (read-metadata (io/file (:directory source) "preset.edn"))
         copied-metadata (cond-> (select-keys metadata [:description])
                           (and (string? name) (not (str/blank? name)))
                           (assoc :name name))]
     (try
       (copy-tree! (.toPath (io/file (:directory source))) (.toPath temporary))
       (spit (io/file temporary "preset.edn")
             (str (pr-str copied-metadata) "\n"))
       ;; Validate the completed private staging tree before the atomic publish.
       (read-metadata (io/file temporary "preset.edn"))
       (read-config-file (io/file temporary "agent.edn"))
       (move-directory! (.toPath temporary) (.toPath target))
       (merge copied-metadata
              {:id id
               :trust :user
               :directory (str target-path)
               :config-path (str (io/file target-path "agent.edn"))})
       (catch Throwable error
         (delete-tree! temporary)
         (throw error))))))

(defn delete-preset! [registry id]
  (when-not (valid-preset-id? id)
    (throw (ex-info "Invalid preset id"
                    {:type :invalid-preset-id :id id})))
  (let [preset (some #(when (= id (:id %)) %) (list-presets registry))]
    (when-not preset
      (throw (ex-info (str "Unknown preset: " id)
                      {:type :unknown-preset :id id})))
    (when (= :system (:trust preset))
      (throw (ex-info "System presets are read-only"
                      {:type :system-preset-read-only :id id})))
    (when-not (and (:user-root registry)
                   (contained? (:user-root registry) (:directory preset)))
      (throw (ex-info "User preset escaped its configured root"
                      {:type :preset-path-escape :id id})))
    (let [user-root (canonical-file (:user-root registry))
          quarantine (io/file user-root (str ".delete-" (random-uuid)))]
      ;; Detach one top-level entry first so recursive deletion never follows a
      ;; public pathname that another process can replace concurrently.
      (move-directory! (.toPath (io/file (:directory preset)))
                       (.toPath quarantine))
      (delete-tree! quarantine))))

(defn- core-plugin-namespace? [namespace]
  (let [value (str namespace)]
    (and (symbol? namespace)
         (or (= "qi" value)
             (.startsWith value "qi.")
             ;; Existing profiles remain valid during the rename window.
             (= "agent" value)
             (.startsWith value "agent.")))))

(defn- validate-structure! [config id]
  (loop [specs (:plugins config)
         seen #{}
         services #{}
         plugin-ids []]
    (if (seq specs)
      (let [spec (first specs)]
        (when-not (map? spec)
          (throw (ex-info "Plugin spec must be a map" {:spec spec})))
        (when (and (contains? spec :config) (not (map? (:config spec))))
          (throw (ex-info "Plugin :config must be a map"
                          {:namespace (:ns spec)})))
        (when-not (core-plugin-namespace? (:ns spec))
          (throw (ex-info "Preset contains a non-core plugin namespace"
                          {:namespace (:ns spec)})))
        (let [{:keys [id requires provides]} (plugin/resolve-plugin spec)
              missing (seq (remove services (or requires #{})))]
          (when (contains? seen id)
            (throw (ex-info (str "Plugin already declared: " id)
                            {:plugin id})))
          (when missing
            (throw (ex-info (str "Plugin " id " is missing required services")
                            {:plugin id :missing (set missing)})))
          (recur (next specs)
                 (conj seen id)
                 (into services (or provides #{}))
                 (conj plugin-ids id))))
      {:valid true
       :mode :structural
       :id id
       :plugins plugin-ids
       :services (->> services (sort-by str) vec)
       :tools []})))

(defn- atomic-write! [file content]
  (let [target (.toPath (io/file file))
        parent (.getParent target)
        temporary (Files/createTempFile parent ".preset-write-" ".tmp"
                                        no-file-attributes)
        bytes (.getBytes ^String content StandardCharsets/UTF_8)]
    (try
      (Files/write temporary bytes
                   (into-array OpenOption
                               [StandardOpenOption/WRITE
                                StandardOpenOption/TRUNCATE_EXISTING]))
      (try
        (Files/move temporary target
                    (into-array StandardCopyOption
                                [StandardCopyOption/ATOMIC_MOVE
                                 StandardCopyOption/REPLACE_EXISTING]))
        (catch Throwable error
          (if (and (Files/exists temporary no-link-options)
                   (Files/exists parent no-link-options))
            (Files/move temporary target
                        (into-array StandardCopyOption
                                    [StandardCopyOption/REPLACE_EXISTING]))
            (throw error))))
      (finally
        (Files/deleteIfExists temporary)))))

(defn update-preset!
  "Atomically replace a user preset's EDN config and/or display metadata.

  The complete candidate is parsed and structurally validated before any file
  is replaced. System presets are immutable."
  [registry id {:keys [config] :as updates}]
  (locking registry
    (let [preset (resolve-preset registry id)]
      (when-not (= :user (:trust preset))
        (throw (ex-info "System presets are read-only"
                        {:type :system-preset-read-only :id id})))
      (when-not (and (:user-root registry)
                     (contained? (:user-root registry) (:directory preset)))
        (throw (ex-info "User preset escaped its configured root"
                        {:type :preset-path-escape :id id})))
      (let [directory (io/file (:directory preset))
            config-file (io/file directory "agent.edn")
            metadata-file (io/file directory "preset.edn")
            current-config (read-bounded-text config-file "agent.edn"
                                              max-config-bytes)
            candidate-config (if (contains? updates :config)
                               config current-config)
            _ (when-not (string? candidate-config)
                (throw (ex-info "Preset config must be an EDN string"
                                {:type :invalid-preset-config :id id})))
            config-bytes (.getBytes ^String candidate-config
                                    StandardCharsets/UTF_8)
            _ (when (> (alength config-bytes) max-config-bytes)
                (throw (ex-info "agent.edn is too large"
                                {:type :invalid-preset-config
                                 :id id :limit max-config-bytes})))
            parsed-config (try
                            (edn/read-string candidate-config)
                            (catch Throwable error
                              (throw (ex-info
                                      (str "Preset validation failed: "
                                           (ex-message error))
                                      {:type :preset-validation-failed :id id}
                                      error))))
            _ (when-not (and (map? parsed-config)
                             (vector? (:plugins parsed-config)))
                (throw (ex-info
                        "Preset validation failed: agent.edn must contain a map with a :plugins vector"
                        {:type :preset-validation-failed :id id})))
            validation (try
                         (validate-structure! parsed-config id)
                         (catch Throwable error
                           (throw (ex-info
                                   (str "Preset validation failed: "
                                        (ex-message error))
                                   {:type :preset-validation-failed
                                    :id id
                                    :cause-data (ex-data error)}
                                   error))))
            metadata (read-metadata metadata-file)
            metadata (cond-> metadata
                       (contains? updates :name) (assoc :name (:name updates))
                       (contains? updates :description)
                       (assoc :description (:description updates)))
            _ (when (or (and (contains? updates :name)
                             (not (and (string? (:name updates))
                                       (not (str/blank? (:name updates))))))
                        (and (contains? updates :description)
                             (not (string? (:description updates)))))
                (throw (ex-info "Preset metadata is invalid"
                                {:type :invalid-preset-metadata :id id})))
            metadata-source (str (pr-str metadata) "\n")]
        ;; Validate both complete candidates before publishing either one.
        (when (> (alength (.getBytes metadata-source StandardCharsets/UTF_8))
                 max-metadata-bytes)
          (throw (ex-info "preset.edn is too large"
                          {:type :invalid-preset-metadata
                           :id id :limit max-metadata-bytes})))
        (when (contains? updates :config)
          (atomic-write! config-file (if (str/ends-with? candidate-config "\n")
                                       candidate-config
                                       (str candidate-config "\n"))))
        (when (or (contains? updates :name)
                  (contains? updates :description))
          (atomic-write! metadata-file metadata-source))
        {:id id
         :trust :user
         :metadata (select-keys metadata [:name :description])
         :validation validation}))))

(defn materialize-preset
  "Return a validated, self-contained EDN snapshot for a trusted host runtime."
  [registry id]
  (let [preset (resolve-preset registry id)
        config (read-config-file (:config-path preset))
        validation (try
                     (validate-structure! config id)
                     (catch Throwable error
                       (throw (ex-info
                               (str "Preset validation failed: " (ex-message error))
                               {:type :preset-validation-failed
                                :id id
                                :cause-data (ex-data error)}
                               error))))]
    {:id id
     :source-config-path (:config-path preset)
     :config (pr-str config)
     :validation validation}))

(defn- validate-mount! [config id]
  (let [ctx (atom nil)]
    (try
      (reset! ctx (plugin/boot! config {:allow-external-plugins false}))
      {:valid true
       :mode :mount
       :id id
       :plugins (mapv :id (kernel/loaded-plugins @ctx))
       :services (->> (kernel/service-keys @ctx) (sort-by str) vec)
       :tools (mapv :name (kernel/tools @ctx))}
      (finally
        (when @ctx (kernel/dispose-all! @ctx))))))

(defn validate-preset!
  "Validate structurally by default. `{:mount? true}` starts plugins and is
  reserved for trusted host callers because plugin startup may have side effects."
  ([registry id] (validate-preset! registry id {}))
  ([registry id {:keys [mount?] :or {mount? false}}]
   (let [config (read-preset registry id)]
     (try
       (let [structural-result (validate-structure! config id)]
         (if mount?
           (validate-mount! config id)
           structural-result))
       (catch Throwable error
         (throw (ex-info (str "Preset validation failed: " (ex-message error))
                         {:type :preset-validation-failed
                          :id id
                          :cause-data (ex-data error)}
                         error)))))))
