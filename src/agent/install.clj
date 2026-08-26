(ns agent.install
  "User-local installer for the Babashka and Ratatui application."
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(def ^:private managed-marker "# Managed by dao `bb install`.")

(def usage
  (str "Install dao for use from any workspace.\n\n"
       "  bb install\n"
       "  bb install --install-dir PATH --bin-dir PATH\n\n"
       "Environment overrides:\n"
       "  DAO_INSTALL_DIR   Application files (default: ~/.local/share/dao)\n"
       "  DAO_BIN_DIR       Launcher directory (default: ~/.local/bin)\n"))

(defn- parse-args [args]
  (loop [remaining args
         options {}]
    (if-let [argument (first remaining)]
      (case argument
        "--install-dir"
        (if-let [path (second remaining)]
          (recur (nnext remaining) (assoc options :install-dir path))
          (throw (ex-info "--install-dir requires a path" {})))

        "--bin-dir"
        (if-let [path (second remaining)]
          (recur (nnext remaining) (assoc options :bin-dir path))
          (throw (ex-info "--bin-dir requires a path" {})))

        "--help" (assoc options :help true)
        "-h" (assoc options :help true)
        (throw (ex-info (str "Unknown install argument: " argument) {})))
      options)))

(defn- absolute-path [path]
  (-> path fs/expand-home fs/absolutize fs/normalize str))

(defn- default-install-dir []
  (absolute-path
   (or (System/getenv "DAO_INSTALL_DIR")
       (str (or (System/getenv "XDG_DATA_HOME")
                (fs/path (System/getProperty "user.home") ".local" "share"))
            (java.io.File/separator) "dao"))))

(defn- default-bin-dir []
  (absolute-path
   (or (System/getenv "DAO_BIN_DIR")
       (fs/path (System/getProperty "user.home") ".local" "bin"))))

(defn- require-source-root! [root]
  (doseq [path ["bb.edn" "agent.edn" "src" "plugins"
                "apps/tui-rs/Cargo.toml"]]
    (when-not (fs/exists? (fs/path root path))
      (throw (ex-info (str "Run bb install from the dao repository root; missing "
                           path)
                      {:root root :missing path}))))
  root)

(defn- shell-quote [value]
  (str "'" (str/replace (str value) "'" "'\"'\"'") "'"))

(defn launcher-script
  "Create a launcher without changing cwd, so tools target the caller's repo."
  [install-dir]
  (str "#!/bin/sh\n"
       managed-marker "\n"
       "set -eu\n"
       "INSTALL_DIR=" (shell-quote install-dir) "\n"
       "exec \"$INSTALL_DIR/apps/tui-rs/target/release/dao\" "
       "--repository-root \"$INSTALL_DIR\" "
       "--config \"$INSTALL_DIR/agent.edn\" \"$@\"\n"))

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
       (str/includes? (slurp (str path)) managed-marker)))

(defn- assert-launcher-safe! [launcher]
  (when (and (fs/exists? launcher)
             (not (managed-launcher? launcher)))
    (throw (ex-info (str "Refusing to replace unmanaged executable: " launcher)
                    {:launcher (str launcher)}))))

(defn- copy-source! [source stage]
  (doseq [name ["src" "plugins" "apps/tui-rs/src"]]
    (fs/copy-tree (fs/path source name) (fs/path stage name)))
  (doseq [name ["bb.edn" "agent.edn" "LICENSE" "README.md"
                "apps/tui-rs/Cargo.toml" "apps/tui-rs/Cargo.lock"]]
    (fs/copy (fs/path source name) (fs/path stage name))))

(defn- prune-build-stage! [stage]
  (let [target (fs/path stage "apps/tui-rs/target")
        release (fs/path target "release")
        binary (fs/path release "dao")
        retained (fs/path stage (str ".dao-release-" (random-uuid)))]
    (when-not (fs/regular-file? binary)
      (throw (ex-info "Release build did not produce the dao executable"
                      {:binary (str binary)})))
    (fs/move binary retained)
    (fs/delete-tree target)
    (fs/create-dirs release)
    (fs/move retained binary)
    binary))

(defn- build-stage! [stage]
  (println "Building Rust/Ratatui TUI...")
  (process/shell {:dir (str stage)}
                 "cargo" "build" "--release"
                 "--locked"
                 "--manifest-path" "apps/tui-rs/Cargo.toml")
  (prune-build-stage! stage))

(defn- activate-stage! [stage install-dir]
  (let [install-path (fs/path install-dir)
        parent (.getParent install-path)
        backup (fs/path parent (str ".dao-backup-" (random-uuid)))]
    (when (fs/exists? install-path)
      (fs/move install-path backup {:atomic-move true}))
    (try
      (fs/move stage install-path {:atomic-move true})
      (when (fs/exists? backup) (fs/delete-tree backup))
      (catch Throwable error
        (when (and (fs/exists? backup) (not (fs/exists? install-path)))
          (fs/move backup install-path {:atomic-move true}))
        (throw error)))))

(defn- install-launcher! [launcher install-dir]
  (let [temporary (fs/path (.getParent (fs/path launcher))
                           (str ".dao-launcher-" (random-uuid)))]
    (spit (str temporary) (launcher-script install-dir))
    (when-not (.setExecutable (io/file (str temporary)) true false)
      (throw (ex-info "Could not mark dao launcher executable"
                      {:launcher (str temporary)})))
    (fs/move temporary launcher {:replace-existing true :atomic-move true})))

(defn install!
  [{:keys [source-root install-dir bin-dir]
    :or {source-root (System/getProperty "user.dir")}}]
  (let [source-root (require-source-root! (absolute-path source-root))
        install-dir (absolute-path (or install-dir (default-install-dir)))
        bin-dir (absolute-path (or bin-dir (default-bin-dir)))
        launcher (fs/path bin-dir "dao")
        source-path (fs/path source-root)
        install-path (fs/path install-dir)]
    (when (.startsWith install-path source-path)
      (throw (ex-info "Install directory must be outside the source repository"
                      {:source source-root :install-dir install-dir})))
    (doseq [command ["bb" "cargo"]]
      (when-not (fs/which command)
        (throw (ex-info (str "Required command is unavailable: " command)
                        {:command command}))))
    (fs/create-dirs (.getParent install-path))
    (fs/create-dirs bin-dir)
    (assert-launcher-safe! launcher)
    (let [stage (fs/create-temp-dir {:dir (.getParent install-path)
                                     :prefix ".dao-install-"})]
      (try
        (copy-source! source-root stage)
        (build-stage! stage)
        (activate-stage! stage install-dir)
        (install-launcher! launcher install-dir)
        (finally
          (when (fs/exists? stage) (fs/delete-tree stage)))))
    (println)
    (println "Installed dao:")
    (println "  application:" install-dir)
    (println "  command:    " (str launcher))
    (if (path-entry? (System/getenv "PATH") bin-dir)
      (println "  ready:       run `dao` from any workspace")
      (do
        (println "  PATH action required:")
        (println (str "    export PATH=\"" bin-dir ":$PATH\""))))
    {:install-dir install-dir :launcher (str launcher)}))

(defn entrypoint [& args]
  (try
    (let [{:keys [help] :as options} (parse-args args)]
      (if help
        (println usage)
        (install! options)))
    (catch Throwable error
      (binding [*out* *err*]
        (println "Install failed:" (or (ex-message error) (str error))))
      (System/exit 1))))
