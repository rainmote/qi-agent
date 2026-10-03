(ns qi.install
  "Git-backed user-local installer for the Babashka and Ratatui application."
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [qi.env :as qenv]
            [qi.secure-files :as secure]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.file CopyOption Files StandardCopyOption]))

(def ^:private managed-marker "# Managed by qi-agent `bb install`.")
(def ^:private legacy-managed-marker "# Managed by dao `bb install`.")
(def ^:private default-repository "https://github.com/rainmote/qi-agent.git")

(def install-usage
  (str "Install qi-agent as a managed Git checkout.\n\n"
       "  bb install\n"
       "  bb install --install-dir PATH --bin-dir PATH\n"
       "  bb install --repository URL --branch NAME\n"
       "  bb install --reset-config\n\n"
       "Environment overrides:\n"
       "  QI_AGENT_HOME          User data root (default: ~/.qi-agent)\n"
       "  QI_AGENT_INSTALL_DIR   Git application checkout (default: ~/.qi-agent/app)\n"
       "  QI_AGENT_BIN_DIR       Launcher directory (default: ~/.local/bin)\n"
       "  QI_AGENT_REPOSITORY    Git repository (default: official GitHub repository)\n"
       "  QI_AGENT_UPDATE_BRANCH Git branch (default: main)\n"))

(def update-usage
  (str "Update an installed qi-agent Git checkout.\n\n"
       "  bb update\n"
       "  bb update --check\n"
       "  bb update --branch NAME\n\n"
       "The installed launcher exposes the same operation as `qi-agent upgrade`.\n"))

(defn- option-value [argument remaining]
  (or (second remaining)
      (throw (ex-info (str argument " requires a value") {:argument argument}))))

(defn- parse-args [args update?]
  (loop [remaining args
         options {}]
    (if-let [argument (first remaining)]
      (case argument
        "--install-dir"
        (recur (nnext remaining)
               (assoc options :install-dir (option-value argument remaining)))

        "--bin-dir"
        (recur (nnext remaining)
               (assoc options :bin-dir (option-value argument remaining)))

        "--data-dir"
        (recur (nnext remaining)
               (assoc options :data-dir (option-value argument remaining)))

        "--repository"
        (recur (nnext remaining)
               (assoc options :repository (option-value argument remaining)))

        "--branch"
        (recur (nnext remaining)
               (assoc options :branch (option-value argument remaining)))

        "--reset-config"
        (recur (next remaining) (assoc options :reset-config true))

        "--check"
        (if update?
          (recur (next remaining) (assoc options :check true))
          (throw (ex-info "--check is only valid for updates" {})))

        "--help" (assoc options :help true)
        "-h" (assoc options :help true)
        (throw (ex-info (str "Unknown " (if update? "update" "install")
                             " argument: " argument)
                        {})))
      options)))

(defn- absolute-path [path]
  (-> path fs/expand-home fs/absolutize fs/normalize str))

(defn- default-data-dir []
  (absolute-path (qenv/home)))

(defn- default-install-dir [data-dir]
  (absolute-path
   (or (qenv/get "QI_AGENT_INSTALL_DIR" "DAO_INSTALL_DIR")
       (fs/path data-dir "app"))))

(defn- default-bin-dir []
  (absolute-path
   (or (qenv/get "QI_AGENT_BIN_DIR" "DAO_BIN_DIR")
       (fs/path (System/getProperty "user.home") ".local" "bin"))))

(defn- default-branch []
  (or (qenv/get "QI_AGENT_UPDATE_BRANCH") "main"))

(defn- configured-repository []
  (or (qenv/get "QI_AGENT_REPOSITORY") default-repository))

(defn- require-source-root! [root]
  (doseq [path ["bb.edn" "agent.edn" "src" "plugins" "presets"
                "apps/tui-rs/Cargo.toml"]]
    (when-not (fs/exists? (fs/path root path))
      (throw (ex-info (str "Run bb install from the qi-agent repository root; missing "
                           path)
                      {:root root :missing path}))))
  root)

(defn- shell-quote [value]
  (str "'" (str/replace (str value) "'" "'\"'\"'") "'"))

(defn launcher-script
  "Create a launcher without changing cwd, so tools target the caller's repo."
  [install-dir data-dir bin-dir]
  (let [standard-data-dir
        (absolute-path (fs/path (System/getProperty "user.home") ".qi-agent"))]
    (str "#!/bin/sh\n"
         managed-marker "\n"
         "set -eu\n"
         "INSTALL_DIR=" (shell-quote install-dir) "\n"
         "QI_AGENT_HOME=" (shell-quote data-dir) "\n"
         "BIN_DIR=" (shell-quote bin-dir) "\n"
         ;; Avoid making the default path look like a user-supplied override to
         ;; legacy data discovery. A genuinely custom home must be inherited by
         ;; the daemon and its Babashka workers.
         (when (not= (absolute-path data-dir) standard-data-dir)
           "export QI_AGENT_HOME\n")
         "if [ \"${1:-}\" = \"upgrade\" ]; then\n"
         "  shift\n"
         "  exec bb --config \"$INSTALL_DIR/bb.edn\" update "
         "--install-dir \"$INSTALL_DIR\" --bin-dir \"$BIN_DIR\" "
         "--data-dir \"$QI_AGENT_HOME\" \"$@\"\n"
         "fi\n"
         "exec \"$INSTALL_DIR/apps/tui-rs/target/release/qi-agent\" "
         "--repository-root \"$INSTALL_DIR\" "
         "--config \"$QI_AGENT_HOME/agent.edn\" \"$@\"\n")))

(defn path-entry?
  "Return true when a normalized directory is already present in PATH."
  [path-value directory]
  (let [target (absolute-path directory)]
    (boolean
     (some #(= target (absolute-path %))
           (remove str/blank?
                   (str/split (or path-value "")
                              (re-pattern
                               (java.util.regex.Pattern/quote
                                java.io.File/pathSeparator))))))))

(defn- managed-launcher? [path]
  (and (fs/regular-file? path)
       (let [source (slurp (str path))]
         (or (str/includes? source managed-marker)
             (str/includes? source legacy-managed-marker)))))

(defn- assert-launcher-safe! [launcher]
  (when (and (fs/exists? launcher)
             (not (managed-launcher? launcher)))
    (throw (ex-info (str "Refusing to replace unmanaged executable: " launcher)
                    {:launcher (str launcher)}))))

(defn- git-output [directory & arguments]
  (-> (apply process/shell
             {:dir (str directory) :out :string :err :string}
             "git" arguments)
      :out
      str/trim))

(defn- command-result [directory command]
  @(process/process command
                    {:dir (str directory) :out :string :err :string}))

(defn- validate-branch! [branch]
  (let [result (command-result "." ["git" "check-ref-format" "--branch" branch])]
    (when-not (zero? (:exit result))
      (throw (ex-info (str "Invalid Git branch: " branch)
                      {:branch branch :stderr (str/trim (:err result))}))))
  branch)

(defn- assert-safe-layout! [source-root install-dir data-dir]
  (let [source-path (fs/path source-root)
        install-path (fs/path install-dir)
        data-path (fs/path data-dir)]
    (when (= install-path (.getRoot install-path))
      (throw (ex-info "Install directory cannot be the filesystem root"
                      {:install-dir install-dir})))
    (when (= data-path (.getRoot data-path))
      (throw (ex-info "User data directory cannot be the filesystem root"
                      {:data-dir data-dir})))
    (when (and (not= source-path install-path)
               (or (.startsWith install-path source-path)
                   (.startsWith source-path install-path)))
      (throw (ex-info "Install directory and source repository must not overlap"
                      {:source source-root :install-dir install-dir})))
    (when (.startsWith data-path install-path)
      (throw (ex-info "User data directory must not be inside the Git checkout"
                      {:data-dir data-dir :install-dir install-dir}))))
  true)

(defn- copy-private-file-atomically! [source target]
  (let [target (.toPath (.getAbsoluteFile (io/file (str target))))
        parent (.getParent target)]
    (secure/protect-directory! parent)
    (when (Files/isSymbolicLink target)
      (throw (ex-info "Refusing to replace a symbolic-link user profile"
                      {:path (str target)})))
    (let [temporary (Files/createTempFile
                     parent ".qi-agent-profile-" ".edn"
                     (make-array java.nio.file.attribute.FileAttribute 0))]
      (try
        (Files/copy (.toPath (.getAbsoluteFile (io/file (str source))))
                    temporary
                    (into-array CopyOption [StandardCopyOption/REPLACE_EXISTING]))
        (secure/protect-file! temporary)
        (try
          (Files/move temporary target
                      (into-array CopyOption
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

(defn- ensure-user-profile!
  "Create the external user profile once, or migrate the legacy in-app profile."
  [data-dir install-path template-path reset-config]
  (let [profile (fs/path data-dir "agent.edn")
        legacy (fs/path install-path "agent.edn")]
    (secure/protect-directory! data-dir)
    (cond
      reset-config
      (do (copy-private-file-atomically! template-path profile) :reset)

      (fs/exists? profile)
      (do (secure/protect-file! profile) :preserved)

      (fs/regular-file? legacy)
      (do (copy-private-file-atomically! legacy profile) :migrated)

      :else
      (do (copy-private-file-atomically! template-path profile) :created))))

(defn- prune-build-stage! [stage]
  (let [target (fs/path stage "apps/tui-rs/target")
        release (fs/path target "release")
        binary (fs/path release "qi-agent")
        retained (fs/path stage (str ".qi-agent-release-" (random-uuid)))]
    (when-not (fs/regular-file? binary)
      (throw (ex-info "Release build did not produce the qi-agent executable"
                      {:binary (str binary)})))
    (fs/move binary retained)
    (fs/delete-tree target)
    (fs/create-dirs release)
    (fs/move retained binary)
    binary))

(defn- build-stage! [stage]
  (println "Building Rust/Ratatui TUI...")
  (process/shell {:dir (str stage)}
                 "cargo" "build" "--release" "--locked" "--bins"
                 "--manifest-path" "apps/tui-rs/Cargo.toml")
  (prune-build-stage! stage))

(defn- validate-stage! [stage]
  (process/shell
   {:dir (str stage) :out :string :err :string}
   "bb" "-cp" (str "src" java.io.File/pathSeparator "plugins")
   "-e" "(require 'qi.cli)"))

(defn- activate-stage! [stage install-dir]
  (let [install-path (fs/path install-dir)
        parent (.getParent install-path)
        backup (fs/path parent (str ".qi-agent-backup-" (random-uuid)))]
    (when (fs/exists? install-path)
      (fs/move install-path backup {:atomic-move true}))
    (try
      (fs/move stage install-path {:atomic-move true})
      (catch Throwable error
        (when (and (fs/exists? backup) (not (fs/exists? install-path)))
          (fs/move backup install-path {:atomic-move true}))
        (throw error)))
    ;; Cleanup is not part of activation. If it fails, the new application is
    ;; already active and reporting the whole update as failed would be false.
    (when (fs/exists? backup)
      (try
        (fs/delete-tree backup)
        (catch Throwable error
          (binding [*out* *err*]
            (println "Warning: qì agent updated, but the old application backup"
                     "could not be removed:" (str backup))
            (println "  cleanup error:" (or (ex-message error) (str error)))))))))

(defn- install-launcher! [launcher install-dir data-dir bin-dir]
  (let [temporary (fs/path (.getParent (fs/path launcher))
                           (str ".qi-agent-launcher-" (random-uuid)))]
    (spit (str temporary) (launcher-script install-dir data-dir bin-dir))
    (when-not (.setExecutable (io/file (str temporary)) true false)
      (throw (ex-info "Could not mark qì agent launcher executable"
                      {:launcher (str temporary)})))
    (fs/move temporary launcher {:replace-existing true :atomic-move true})))

(defn- legacy-managed-install? [install-path]
  (every? #(fs/exists? (fs/path install-path %))
          ["bb.edn" "agent.edn" "src/qi/install.clj"
           "apps/tui-rs/target/release/qi-agent"]))

(defn- require-commands! []
  (doseq [command ["bb" "cargo" "git"]]
    (when-not (fs/which command)
      (throw (ex-info (str "Required command is unavailable: " command)
                      {:command command})))))

(defn- create-stage! [install-path]
  (fs/create-temp-dir {:dir (.getParent (fs/path install-path))
                       :prefix ".qi-agent-install-"}))

(defn- clone-repository! [repository branch stage]
  (process/shell {:dir (str (.getParent (fs/path stage)))}
                 "git" "clone" "--quiet" "--depth" "1" "--single-branch"
                 "--branch" branch "--" repository (str stage))
  (process/shell {:dir (str stage)} "git" "config" "qi-agent.managed" "true")
  stage)

(defn- checkout-update-stage! [install-path repository branch target stage]
  (process/shell {:dir (str (.getParent (fs/path stage)))}
                 "git" "clone" "--quiet" "--no-hardlinks" "--no-checkout"
                 "--" install-path (str stage))
  (process/shell {:dir (str stage)} "git" "remote" "set-url" "origin" repository)
  (process/shell {:dir (str stage)} "git" "fetch" "--quiet" "origin" branch)
  (process/shell {:dir (str stage)} "git" "checkout" "--quiet" "-B" branch target)
  (process/shell {:dir (str stage)} "git" "branch" "--set-upstream-to"
                 (str "origin/" branch) branch)
  (process/shell {:dir (str stage)} "git" "config" "qi-agent.managed" "true")
  stage)

(defn- resolved-layout [{:keys [install-dir bin-dir data-dir]}]
  (let [data-dir (absolute-path (or data-dir (default-data-dir)))]
    {:data-dir data-dir
     :install-dir (absolute-path (or install-dir (default-install-dir data-dir)))
     :bin-dir (absolute-path (or bin-dir (default-bin-dir)))}))

(declare update!)

(defn install!
  [{:keys [source-root repository branch reset-config build-fn validate-fn]
    :or {source-root (System/getProperty "user.dir")}
    :as options}]
  (let [source-root (require-source-root! (absolute-path source-root))
        {:keys [data-dir install-dir bin-dir]} (resolved-layout options)
        clone-repository (or repository (configured-repository))
        branch (validate-branch! (or branch (default-branch)))
        build-fn (or build-fn build-stage!)
        validate-fn (or validate-fn validate-stage!)
        launcher (fs/path bin-dir "qi-agent")
        legacy-launcher (fs/path bin-dir "dao")
        install-path (fs/path install-dir)]
    (assert-safe-layout! source-root install-dir data-dir)
    (require-commands!)
    (fs/create-dirs (.getParent install-path))
    (fs/create-dirs bin-dir)
    (doseq [path [launcher legacy-launcher]]
      (assert-launcher-safe! path))
    (if (fs/directory? (fs/path install-path ".git"))
      (update! (cond-> (assoc options
                              :install-dir install-dir :bin-dir bin-dir
                              :data-dir data-dir :branch branch
                              :build-fn build-fn :validate-fn validate-fn)
                 (nil? repository) (dissoc :repository)))
      (do
        (when (and (fs/exists? install-path)
                   (not (legacy-managed-install? install-path)))
          (throw (ex-info "Install directory exists and is not managed by qi-agent"
                          {:install-dir install-dir})))
        (let [stage (create-stage! install-path)]
          (try
            (clone-repository! clone-repository branch stage)
            (build-fn stage)
            (validate-fn stage)
            (let [profile-action
                  (ensure-user-profile! data-dir install-path
                                        (fs/path stage "agent.edn") reset-config)]
              (activate-stage! stage install-dir)
              (install-launcher! launcher install-dir data-dir bin-dir)
              (install-launcher! legacy-launcher install-dir data-dir bin-dir)
              (println)
              (println "Installed qì agent from Git:")
              (println "  application:" install-dir)
              (println "  data:       " data-dir)
              (println "  profile:    " (str (fs/path data-dir "agent.edn"))
                       (str "(" (name profile-action) ")"))
              (println "  branch:     " branch)
              (println "  command:    " (str launcher))
              (println "  alias:      " (str legacy-launcher)))
            (finally
              (when (fs/exists? stage) (fs/delete-tree stage)))))))
    (if (path-entry? (System/getenv "PATH") bin-dir)
      (println "  ready:       run `qi-agent` from any workspace")
      (do
        (println "  PATH action required:")
        (println (str "    export PATH=\"" bin-dir ":$PATH\""))))
    {:install-dir install-dir
     :data-dir data-dir
     :launcher (str launcher)
     :legacy-launcher (str legacy-launcher)}))

(defn update!
  [{:keys [repository branch reset-config check build-fn validate-fn]
    :as options}]
  (let [{:keys [data-dir install-dir bin-dir]} (resolved-layout options)
        install-path (fs/path install-dir)
        launcher (fs/path bin-dir "qi-agent")
        legacy-launcher (fs/path bin-dir "dao")
        build-fn (or build-fn build-stage!)
        validate-fn (or validate-fn validate-stage!)]
    (assert-safe-layout! install-dir install-dir data-dir)
    (require-commands!)
    (when-not (fs/directory? (fs/path install-path ".git"))
      (throw (ex-info "Installed application is not a Git checkout; run `bb install` once to migrate"
                      {:install-dir install-dir})))
    (doseq [path [launcher legacy-launcher]]
      (assert-launcher-safe! path))
    (let [dirty (git-output install-path "status" "--porcelain"
                            "--untracked-files=all")]
      (when-not (str/blank? dirty)
        (throw (ex-info
                "Installed Git checkout has local changes; update refused so they are not lost"
                {:install-dir install-dir :changes (str/split-lines dirty)}))))
    (let [repository (or repository
                         (qenv/get "QI_AGENT_REPOSITORY")
                         (git-output install-path "remote" "get-url" "origin"))
          branch (validate-branch!
                  (or branch
                      (qenv/get "QI_AGENT_UPDATE_BRANCH")
                      (let [value (git-output install-path "branch" "--show-current")]
                        (when-not (str/blank? value) value))
                      (default-branch)))
          current (git-output install-path "rev-parse" "HEAD")]
      (process/shell {:dir (str install-path)}
                     "git" "fetch" "--quiet" repository branch)
      (let [target (git-output install-path "rev-parse" "FETCH_HEAD")
            binary (fs/path install-path "apps/tui-rs/target/release/qi-agent")
            same? (= current target)]
        (when check
          (println (if same? "qì agent is up to date." "A qì agent update is available."))
          (println "  branch: " branch)
          (println "  current:" current)
          (println "  latest: " target))
        (if check
          {:updated false :available (not same?) :current current :target target}
          (if (and same? (fs/regular-file? binary))
            (let [profile-action
                  (ensure-user-profile! data-dir install-path
                                        (fs/path install-path "agent.edn") reset-config)]
              (fs/create-dirs bin-dir)
              (install-launcher! launcher install-dir data-dir bin-dir)
              (install-launcher! legacy-launcher install-dir data-dir bin-dir)
              (println "qì agent is already up to date:" (subs current 0 12))
              {:updated false :current current :target target
               :profile-action profile-action})
            (let [stage (create-stage! install-path)]
              (try
                (checkout-update-stage! install-path repository branch target stage)
                (build-fn stage)
                (validate-fn stage)
                (let [profile-action
                      (ensure-user-profile! data-dir install-path
                                            (fs/path stage "agent.edn") reset-config)]
                  (activate-stage! stage install-dir)
                  (fs/create-dirs bin-dir)
                  (install-launcher! launcher install-dir data-dir bin-dir)
                  (install-launcher! legacy-launcher install-dir data-dir bin-dir)
                  (println "Updated qì agent:")
                  (println "  branch: " branch)
                  (println "  previous:" current)
                  (println "  current: " target)
                  (println "  data:    " data-dir "(unchanged)")
                  {:updated true :previous current :current target
                   :profile-action profile-action})
                (finally
                  (when (fs/exists? stage) (fs/delete-tree stage)))))))))))

(defn- run-entrypoint [args update?]
  (try
    (let [{:keys [help] :as options} (parse-args args update?)]
      (if help
        (println (if update? update-usage install-usage))
        ((if update? update! install!) options)))
    (catch Throwable error
      (binding [*out* *err*]
        (println (str (if update? "Update" "Install") " failed:")
                 (or (ex-message error) (str error))))
      (System/exit 1))))

(defn entrypoint [& args]
  (run-entrypoint args false))

(defn update-entrypoint [& args]
  (run-entrypoint args true))
