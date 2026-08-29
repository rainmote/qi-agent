(ns agent.plugins.resources
  "Trusted contexts, prompts, and OMP-style progressive skill discovery."
  (:require [agent.kernel :as kernel]
            [babashka.fs :as fs]
            [clj-yaml.core :as yaml]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.net URI]
           [java.nio.file FileSystems Files LinkOption Path]))

(def ^:private skill-name-pattern #"[A-Za-z0-9][A-Za-z0-9._-]*")

(defn- source-repository-root []
  (when-let [resource (io/resource "agent/plugins/resources.clj")]
    (when (= "file" (.getProtocol resource))
      (some-> resource io/file .getCanonicalFile
              .getParentFile .getParentFile .getParentFile .getParentFile str))))

(defn- regular-paths [directory]
  (let [root (.toPath (io/file directory))]
    (if-not (Files/isDirectory root (make-array LinkOption 0))
      []
      (with-open [paths (Files/walk root
                                    (make-array java.nio.file.FileVisitOption 0))]
        (->> (iterator-seq (.iterator paths))
             (filter #(Files/isRegularFile % (make-array LinkOption 0)))
             (remove #(Files/isSymbolicLink %))
             vec)))))

(defn- markdown-files [directory]
  (->> (regular-paths directory)
       (filter #(str/ends-with? (str/lower-case (str %)) ".md"))))

(defn- split-frontmatter [text path]
  (if-not (re-find #"\A---[ \t]*\r?\n" text)
    {:metadata {} :body text}
    (if-let [[_ source body]
             (re-matches #"(?s)\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\z)(.*)\z"
                         text)]
      (let [metadata (try
                       (or (yaml/parse-string source) {})
                       (catch Throwable error
                         (throw (ex-info "Invalid SKILL.md YAML frontmatter"
                                         {:path path}
                                         error))))]
        (when-not (map? metadata)
          (throw (ex-info "SKILL.md frontmatter must be a YAML mapping"
                          {:path path})))
        {:metadata (into {} metadata) :body body})
      (throw (ex-info "SKILL.md frontmatter is missing its closing delimiter"
                      {:path path})))))

(defn- optional-string! [metadata key path]
  (when-let [value (get metadata key)]
    (when-not (string? value)
      (throw (ex-info "SKILL.md frontmatter field must be a string"
                      {:path path :field key :value value})))
    value))

(defn- optional-boolean! [metadata keys path]
  (when-let [[key value] (some #(when (contains? metadata %)
                                  [% (get metadata %)])
                               keys)]
    (when-not (instance? Boolean value)
      (throw (ex-info "SKILL.md frontmatter field must be a boolean"
                      {:path path :field key :value value})))
    value))

(defn- skill-globs! [metadata path]
  (when-let [value (:globs metadata)]
    (when-not (and (sequential? value) (every? string? value))
      (throw (ex-info "SKILL.md globs must be a YAML string array"
                      {:path path :field :globs :value value})))
    (vec value)))

(defn- skill-entry [scope path require-description?]
  (let [canonical (.toRealPath ^Path path (make-array LinkOption 0))
        text (slurp (str canonical))
        {:keys [metadata body]} (split-frontmatter text (str canonical))
        fallback (str (.getFileName (.getParent canonical)))
        name (or (optional-string! metadata :name (str canonical)) fallback)
        description (optional-string! metadata :description (str canonical))
        always-apply (optional-boolean! metadata [:alwaysApply :always-apply]
                                        (str canonical))
        hide (optional-boolean! metadata [:hide] (str canonical))
        disable-model-invocation
        (optional-boolean! metadata
                           [:disableModelInvocation
                            :disable-model-invocation]
                           (str canonical))]
    (when-not (re-matches skill-name-pattern name)
      (throw (ex-info "Invalid skill name"
                      {:path (str canonical) :name name
                       :expected (str skill-name-pattern)})))
    (when (and require-description? (str/blank? description))
      (throw (ex-info "SKILL.md requires a non-blank description"
                      {:path (str canonical) :name name})))
    {:name name
     :description (or description (str "Skill from " fallback))
     :scope scope
     :path (str canonical)
     :base-dir (str (.getParent canonical))
     :metadata metadata
     :globs (skill-globs! metadata (str canonical))
     :always-apply (boolean always-apply)
     :hide (boolean hide)
     :disable-model-invocation (boolean disable-model-invocation)
     :body body}))

(defn- context-entry [scope path]
  {:scope scope
   :name (str (.getFileName path))
   :path (str path)
   :content (slurp (str path))})

(defn- named-entry [scope directory name]
  (let [file (io/file directory name)]
    (when (.isFile file)
      (context-entry scope (.toPath file)))))

(defn- skills-from [scope directory require-description?]
  (for [path (markdown-files directory)
        :when (= "SKILL.md" (str (.getFileName path)))]
    (skill-entry scope path require-description?)))

(defn- scope-resources
  [scope base project-root? {:keys [skills-enabled? require-description?]}]
  (let [base-file (io/file base)
        root-file (when project-root? (.getParentFile base-file))
        ;; Repository-root resources are broad defaults. A .bb-agent entry is
        ;; more explicit and therefore comes later for SYSTEM selection.
        directories (cond-> [] root-file (conj root-file) true (conj base-file))
        contexts (keep #(named-entry scope % "AGENTS.md") directories)
        system-prompts (keep #(named-entry scope % "SYSTEM.md") directories)
        append-system-prompts
        (keep #(named-entry scope % "APPEND_SYSTEM.md") directories)
        prompts (for [path (markdown-files (io/file base-file "prompts"))]
                  {:name (str (.getFileName path))
                   :scope scope :path (str path)})
        skills (when skills-enabled?
                 (skills-from scope (io/file base-file "skills")
                              require-description?))]
    {:contexts (vec contexts)
     :system-prompts (vec system-prompts)
     :append-system-prompts (vec append-system-prompts)
     :prompts (vec prompts)
     :skills (vec skills)}))

(defn- wildcard-matcher [pattern]
  (try
    (.getPathMatcher (FileSystems/getDefault) (str "glob:" pattern))
    (catch Throwable error
      (throw (ex-info "Invalid skill filter glob" {:pattern pattern} error)))))

(defn- matches-any? [patterns value]
  (boolean
   (some #(.matches (wildcard-matcher %) (fs/path value)) patterns)))

(defn- filter-skills [skills {:keys [include ignore]}]
  (filterv
   (fn [{:keys [name]}]
     (and (or (empty? include) (matches-any? include name))
          (not (matches-any? ignore name))))
   skills))

(defn- dedupe-skills [skills]
  (reduce
   (fn [{:keys [by-name paths] :as result} skill]
     (cond
       (contains? paths (:path skill)) result

       (contains? by-name (:name skill))
       (-> result
           (update :paths conj (:path skill))
           (update :warnings conj
                   {:type :skill/name-collision
                    :name (:name skill)
                    :selected (:path (get by-name (:name skill)))
                    :ignored (:path skill)}))

       :else
       (-> result
           (update :skills conj skill)
           (assoc-in [:by-name (:name skill)] skill)
           (update :paths conj (:path skill)))))
   {:skills [] :by-name {} :paths #{} :warnings []}
   skills))

(defn- model-visible? [skill]
  (not (or (:hide skill) (:disable-model-invocation skill))))

(defn- empty-scope []
  {:contexts [] :system-prompts [] :append-system-prompts []
   :prompts [] :skills []})

(defn- skills-from-directories [scope directories require-description?]
  (mapcat #(skills-from scope % require-description?) directories))

(defn- discover [user-dir project-dir trusted? skill-options]
  (let [{:keys [enabled enable-user enable-project custom-directories
                bundled-directories
                enable-agents-user agents-user-directories
                require-description]} skill-options
        user (scope-resources :user user-dir false
                              {:skills-enabled? (and enabled enable-user)
                               :require-description? require-description})
        project (if trusted?
                  (scope-resources
                   :project project-dir true
                   {:skills-enabled? (and enabled enable-project)
                    :require-description? require-description})
                  (empty-scope))
        custom (if (and enabled trusted?)
                 (skills-from-directories :custom custom-directories
                                          require-description)
                 [])
        bundled (if enabled
                  (skills-from-directories :bundled bundled-directories
                                           require-description)
                  [])
        agents-user
        (if (and enabled enable-agents-user)
          (skills-from-directories :agents-user agents-user-directories
                                   require-description)
          [])
        ;; Explicit custom sources win, then project .bb-agent, user
        ;; .bb-agent, and finally the cross-agent user directory. The first
        ;; skill with a name wins and collisions remain observable.
        selected (dedupe-skills
                  (filter-skills
                   (vec (concat bundled custom (:skills project) (:skills user)
                                agents-user))
                   skill-options))
        skills (vec (sort-by :name (:skills selected)))
        system-prompts (vec (concat (:system-prompts user)
                                    (:system-prompts project)))
        append-system-prompts
        (vec (concat (:append-system-prompts user)
                     (:append-system-prompts project)))]
    {:contexts (vec (concat (:contexts user) (:contexts project)))
     :system-prompts system-prompts
     :append-system-prompts append-system-prompts
     :system-prompt (last system-prompts)
     :append-system-prompt (last append-system-prompts)
     :prompts (vec (concat (:prompts user) (:prompts project)))
     :skills skills
     :skills-by-name (into {} (map (juxt :name identity) skills))
     :model-skills (filterv model-visible? skills)
     :skill-warnings (:warnings selected)
     :project-trusted trusted?}))

(defn- catalog-prompt [{:keys [contexts model-skills]}]
  (str
   (when (seq contexts)
     (str "\n\nLoaded context files:\n"
          (str/join "\n\n"
                    (map #(str "# " (:name %) " (" (name (:scope %)) ")\n"
                               (:content %))
                         contexts))))
   (when (seq model-skills)
     (str "\n\nAvailable skills (read skill://<name> before following one):\n"
          (str/join "\n"
                    (map #(str "- " (:name %) ": " (:description %)
                               " [" (name (:scope %)) "]")
                         model-skills))))))

(defn- parse-skill-uri [value]
  (when (and (string? value) (str/starts-with? value "skill://"))
    (let [uri (try (URI. value)
                   (catch Throwable error
                     (throw (ex-info "Invalid skill URL" {:url value} error))))
          ;; URI#getHost rejects valid skill identifiers such as underscores;
          ;; authority is safe here because the name grammar excludes URL
          ;; userinfo, ports, escapes, and path separators.
          skill-name (.getRawAuthority uri)
          path (or (.getPath uri) "")]
      (when (or (str/blank? skill-name)
                (not (re-matches skill-name-pattern skill-name))
                (.getRawQuery uri) (.getRawFragment uri)
                (.getUserInfo uri) (not= -1 (.getPort uri)))
        (throw (ex-info "Invalid skill URL" {:url value})))
      {:name skill-name
       :relative-path (str/replace-first path #"^/" "")})))

(defn- inside-skill-path [skill relative-path]
  (let [base (.toRealPath (fs/path (:base-dir skill))
                          (make-array LinkOption 0))
        requested (if (str/blank? relative-path)
                    (.getFileName (fs/path (:path skill)))
                    relative-path)
        lexical (.normalize (.resolve base (str requested)))]
    (when (or (.isAbsolute (fs/path (str requested)))
              (not (.startsWith lexical base)))
      (throw (ex-info "Skill resource path escapes its skill directory"
                      {:skill (:name skill) :path relative-path})))
    (let [target (try
                   (.toRealPath lexical (make-array LinkOption 0))
                   (catch java.nio.file.NoSuchFileException _
                     (throw (ex-info "Skill resource was not found"
                                     {:skill (:name skill)
                                      :path relative-path}))))]
      (when-not (.startsWith target base)
        (throw (ex-info "Skill resource resolves outside its skill directory"
                        {:skill (:name skill) :path relative-path})))
      (when-not (Files/isRegularFile target (make-array LinkOption 0))
        (throw (ex-info "Skill resource is not a regular file"
                        {:skill (:name skill) :path relative-path})))
      target)))

(defn- logical-lines [text]
  (if (empty? text)
    []
    (let [lines (str/split text #"\r?\n" -1)]
      (if (empty? (peek lines)) (pop (vec lines)) (vec lines)))))

(defn- fit-whole-lines [lines max-chars]
  (loop [remaining lines fitted [] characters 0]
    (if-let [line (first remaining)]
      (let [separator (if (empty? fitted) 0 1)
            required (+ separator (count line))]
        (cond
          (<= (+ characters required) max-chars)
          (recur (next remaining) (conj fitted line)
                 (+ characters required))

          (empty? fitted)
          {:lines [(subs line 0 (min max-chars (count line)))]
           :character-truncated? true :first-line-exceeds-limit? true}

          :else {:lines fitted :character-truncated? true}))
      {:lines fitted :character-truncated? false})))

(defn- read-resource-lines [display-path target offset limit max-chars]
  (let [text (slurp (str target))
        lines (logical-lines text)
        total-lines (count lines)
        start (min total-lines (max 0 offset))
        requested-end (min total-lines (+ start (max 1 limit)))
        fitted (fit-whole-lines (subvec lines start requested-end) max-chars)
        output-lines (:lines fitted)
        character-truncated? (:character-truncated? fitted)
        end (+ start (count output-lines))
        more-lines? (< end total-lines)]
    {:path display-path
     :content (str/join "\n" output-lines)
     :offset start
     :line-count (count output-lines)
     :total-lines total-lines
     :truncated (or more-lines? character-truncated?)
     :truncated-by (cond character-truncated? :characters
                         more-lines? :lines
                         :else nil)
     :first-line-exceeds-limit
     (boolean (:first-line-exceeds-limit? fitted))
     :max-chars max-chars
     :size (count text)}))

(defn- public-skill [skill]
  (dissoc skill :body))

(defn- public-catalog [catalog]
  (-> catalog
      (update :skills #(mapv public-skill %))
      (update :model-skills #(mapv public-skill %))
      (dissoc :skills-by-name)))

(def plugin
  {:id :resources/catalog
   :description "Contexts, prompts, OMP-style skills, and atomic reload."
   :requires #{:project/trust}
   :provides #{:resources/catalog}
   :start
   (fn [ctx {:keys [root user-dir project-dir skills]
             :or {root "."}}]
     (let [workspace (fs/real-path root)
           user-home (System/getProperty "user.home")
           user-root (or user-dir
                         (str (io/file user-home ".bb-agent")))
           project-root (or project-dir (str (fs/path workspace ".bb-agent")))
           resolve-custom
           (fn [path]
             (let [file (io/file path)]
               (str (if (.isAbsolute file)
                      file
                      (io/file (str workspace) path)))))
           repository-root (or (System/getenv "DAO_REPOSITORY_ROOT")
                               (source-repository-root)
                               (System/getProperty "user.dir"))
           resolve-bundled
           (fn [path]
             (let [file (io/file path)]
               (str (if (.isAbsolute file)
                      file
                      (io/file repository-root path)))))
           skill-options
           (merge {:enabled true :enable-user true :enable-project true
                   :enable-agents-user true
                   ;; An explicit user-dir means the caller requested an
                   ;; isolated user resource root. In the normal profile this
                   ;; defaults to the cross-agent global skills directory.
                   :agents-user-directories
                   (if user-dir [] [(str (io/file user-home ".agents" "skills"))])
                   :custom-directories [] :bundled-directories []
                   :include [] :ignore []
                   :require-description true :enable-commands true}
                  skills)
           _ (doseq [key [:include :ignore :custom-directories
                          :bundled-directories
                          :agents-user-directories]]
               (when-not (and (sequential? (get skill-options key))
                              (every? string? (get skill-options key)))
                 (throw (ex-info "Skill option must be a string array"
                                 {:option key
                                  :value (get skill-options key)}))))
           _ (doseq [key [:enabled :enable-user :enable-project
                          :enable-agents-user
                          :require-description :enable-commands]]
               (when-not (instance? Boolean (get skill-options key))
                 (throw (ex-info "Skill option must be a boolean"
                                 {:option key
                                  :value (get skill-options key)}))))
           skill-options
           (-> skill-options
               (update :custom-directories #(mapv resolve-custom %))
               (update :bundled-directories #(mapv resolve-bundled %))
               (update :agents-user-directories #(mapv resolve-custom %)))
           trust (kernel/require-service ctx :project/trust)
           scan! #(assoc (discover user-root project-root ((:trusted? trust))
                                   skill-options)
                         :workspace (str workspace))
           state (atom (scan!))
           reload! (fn []
                     (let [candidate (scan!)]
                       ;; Parse and validate the entire candidate before the
                       ;; visible catalog switches.
                       (reset! state candidate)
                       (public-catalog candidate)))
           find-skill #(get (:skills-by-name @state) %)
           load-skill
           (fn [name]
             (if-let [skill (find-skill name)]
               (let [target (inside-skill-path skill "")]
                 (-> (public-skill skill)
                     (assoc :content (slurp (str target)))))
               (throw (ex-info "Skill was not found" {:name name}))))
           resolve-resource
           (fn [url]
             (let [{:keys [name relative-path]}
                   (or (parse-skill-uri url)
                       (throw (ex-info "Expected a skill:// URL" {:url url})))
                   skill (or (find-skill name)
                             (throw (ex-info "Skill was not found"
                                             {:name name :url url})))
                   target (inside-skill-path skill relative-path)]
               {:skill name
                :path (str target)
                :url (if (str/blank? relative-path)
                       (str "skill://" name)
                       (str "skill://" name "/" relative-path))
                :content-type (if (str/ends-with?
                                   (str/lower-case (str target)) ".md")
                                "text/markdown" "text/plain")}))
           read-resource
           (fn [{:keys [path offset limit max-chars]
                 :or {offset 0 limit 2000 max-chars 50000}}]
             (let [{target :path display-path :url}
                   (resolve-resource path)]
               (read-resource-lines display-path target offset limit
                                    max-chars)))
           render-invocation
           (fn [name argument]
             (when-not (:enable-commands skill-options)
               (throw (ex-info "Skill commands are disabled" {:name name})))
             (if-let [skill (find-skill name)]
               (str "# Skill: " name "\n\n"
                    "Source: skill://" name "\n"
                    "Base directory: skill://" name "/\n\n"
                    (:body skill)
                    (when-not (str/blank? argument)
                      (str "\n\n# User Arguments\n\n" argument)))
               (throw (ex-info "Skill was not found" {:name name}))))
           service
           {:snapshot (fn [] (public-catalog @state))
            :prompt-snapshot (fn [] @state)
            :reload! reload!
            :skills (fn [] (mapv public-skill (:skills @state)))
            :model-skills (fn [] (mapv public-skill (:model-skills @state)))
            :skill-commands
            (fn []
              (if (:enable-commands skill-options)
                (mapv #(select-keys % [:name :description]) (:skills @state))
                []))
            :skill-commands-enabled? #(boolean (:enable-commands skill-options))
            :prompts (fn [] (:prompts @state))
            :contexts (fn [] (:contexts @state))
            :load-skill load-skill
            :skill-uri? #(boolean (parse-skill-uri %))
            :resolve-skill-resource resolve-resource
            :read-skill-resource read-resource
            :render-skill-invocation render-invocation
            :render-prompt #(catalog-prompt @state)}]
       (kernel/register-service! ctx :resources/catalog service)
       (when (:enabled skill-options)
         (kernel/register-tool!
          ctx
          {:name "load_skill"
           :description (str "Load a discovered skill's SKILL.md. Prefer read "
                             "with skill://<name> when available.")
           :parameters {:type "object"
                        :required ["name"]
                        :properties {"name" {:type "string"}}
                        :additionalProperties false}
           :execute (fn [{:keys [name]} _] (load-skill name))
           :render (fn [_ value] (:content value))})))
     nil)})
