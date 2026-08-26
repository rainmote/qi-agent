(ns agent.secure-files
  "Owner-only filesystem primitives for local agent state and credentials."
  (:require [clojure.java.io :as io])
  (:import [java.nio.file FileAlreadyExistsException Files LinkOption Path]
           [java.nio.file.attribute PosixFilePermission PosixFilePermissions]))

(def ^:private owner-directory-permissions
  #{PosixFilePermission/OWNER_READ
    PosixFilePermission/OWNER_WRITE
    PosixFilePermission/OWNER_EXECUTE})

(def ^:private owner-file-permissions
  #{PosixFilePermission/OWNER_READ
    PosixFilePermission/OWNER_WRITE})

(defn- path ^Path [value]
  (.toPath (.getAbsoluteFile (io/file (str value)))))

(defn- set-posix-permissions! [^Path target permissions]
  (try
    (Files/setPosixFilePermissions target (java.util.HashSet. permissions))
    true
    (catch UnsupportedOperationException _ false)))

(defn- restrict-java-file! [target directory?]
  (let [file (.toFile ^Path target)
        results [(.setReadable file false false)
                 (.setWritable file false false)
                 (if directory? (.setExecutable file false false) true)
                 (.setReadable file true true)
                 (.setWritable file true true)
                 (if directory? (.setExecutable file true true) true)]]
    (when-not (every? true? results)
      (throw (ex-info "Could not apply owner-only filesystem permissions"
                      {:path (str target) :directory directory?}))))
  target)

(defn protect-directory!
  "Create a directory when needed and make it accessible only to its owner."
  [value]
  (let [target (path value)]
    (when (Files/isSymbolicLink target)
      (throw (ex-info "Refusing to protect a symbolic-link state directory"
                      {:path (str target)})))
    (Files/createDirectories
     target (make-array java.nio.file.attribute.FileAttribute 0))
    (when-not (set-posix-permissions! target owner-directory-permissions)
      (restrict-java-file! target true))
    (str target)))

(defn protect-file!
  "Make an existing regular data file readable and writable only by its owner."
  [value]
  (let [target (path value)]
    (when (Files/isSymbolicLink target)
      (throw (ex-info "Refusing to protect a symbolic-link state file"
                      {:path (str target)})))
    (when-not (Files/isRegularFile target (make-array LinkOption 0))
      (throw (ex-info "Owner-only state path is not a regular file"
                      {:path (str target)})))
    (when-not (set-posix-permissions! target owner-file-permissions)
      (restrict-java-file! target false))
    (str target)))

(defn ensure-owner-file!
  "Atomically create an empty owner-only file, or tighten an existing file."
  [value]
  (let [target (path value)
        parent (.getParent target)]
    (when parent
      (Files/createDirectories
       parent (make-array java.nio.file.attribute.FileAttribute 0)))
    (when (Files/isSymbolicLink target)
      (throw (ex-info "Refusing to open a symbolic-link state file"
                      {:path (str target)})))
    (when-not (Files/exists target (make-array LinkOption 0))
      (try
        (Files/createFile
         target
         (into-array
          java.nio.file.attribute.FileAttribute
          [(PosixFilePermissions/asFileAttribute
            (java.util.HashSet. owner-file-permissions))]))
        (catch UnsupportedOperationException _
          (when-not (.createNewFile (.toFile target))
            (throw (ex-info "Could not create owner-only state file"
                            {:path (str target)}))))
        (catch FileAlreadyExistsException _)))
    (protect-file! target)))

(defn managed-state-root
  "Return the nearest .bb-agent ancestor for a generated local-state path."
  [value]
  (loop [current (path value)]
    (when current
      (if (= ".bb-agent" (some-> current .getFileName str))
        current
        (recur (.getParent current))))))

(defn protect-managed-parents!
  "Tighten .bb-agent and every existing/generated directory down to value.
  Paths outside .bb-agent are deliberately left alone."
  [value]
  (let [target (path value)
        directory (if (Files/isDirectory target (make-array LinkOption 0))
                    target
                    (.getParent target))]
    (when-let [root (managed-state-root directory)]
      (loop [current directory
             values []]
        (if (and current (.startsWith current root))
          (recur (.getParent current) (conj values current))
          (doseq [entry (reverse values)]
            (protect-directory! entry))))))
  value)

(defn protect-tree!
  "Recursively migrate one generated state tree to owner-only permissions.
  Symbolic links are skipped and never followed."
  [value]
  (let [root (path value)]
    (when (Files/exists root (make-array LinkOption 0))
      (with-open [entries (Files/walk
                           root
                           (make-array java.nio.file.FileVisitOption 0))]
        (doseq [entry (iterator-seq (.iterator entries))]
          (cond
            (Files/isSymbolicLink entry) nil
            (Files/isDirectory entry (make-array LinkOption 0))
            (protect-directory! entry)
            (Files/isRegularFile entry (make-array LinkOption 0))
            (protect-file! entry)))))
    (str root)))
