(ns qi.secure-files
  "Owner-only filesystem primitives for local agent state and credentials."
  (:require [clojure.java.io :as io])
  (:import [java.io IOException]
           [java.nio.channels Channels]
           [java.nio.file FileAlreadyExistsException Files LinkOption OpenOption Path StandardOpenOption]
           [java.nio.file.attribute PosixFilePermission PosixFilePermissions]
           [java.util.concurrent TimeUnit]))

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
  "Return the nearest canonical or legacy managed-state ancestor."
  [value]
  (loop [current (path value)]
    (when current
      (if (contains? #{".qi-agent" ".bb-agent"}
                     (some-> current .getFileName str))
        current
        (recur (.getParent current))))))

(defn protect-managed-parents!
  "Tighten a managed state root and every directory down to value.
  Paths outside .qi-agent/.bb-agent are deliberately left alone."
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

(def ^:private effective-user-id
  ;; Account names may be unavailable for container UIDs. This process never
  ;; changes OS identity; cache the effective UID, not a display name or env var.
  (delay
    (try
      (let [builder (ProcessBuilder. ["/usr/bin/id" "-u"])]
        (.clear (.environment builder))
        (let [process (.start builder)]
          (try
            (when-not (.waitFor process 2 TimeUnit/SECONDS)
              (throw (ex-info "Timed out resolving credential owner" {})))
            (let [output (slurp (.getInputStream process))
                  match (re-matches #"([0-9]+)\n?" output)]
              (when-not (and (zero? (.exitValue process)) match)
                (throw (ex-info "Cannot resolve credential owner" {})))
              (Long/parseLong (second match)))
            (finally
              (when (.isAlive process)
                (.destroyForcibly process)
                (.waitFor process 1 TimeUnit/SECONDS))
              (.close (.getInputStream process))
              (.close (.getErrorStream process))
              (.close (.getOutputStream process))))))
      (catch Exception error
        (throw (ex-info "Cannot verify current credential owner"
                        {:code :insecure-credentials} error))))))

(defn- owner-file-identity [^Path target]
  (try
    (let [attributes (Files/readAttributes target "unix:*"
                                           (into-array LinkOption [LinkOption/NOFOLLOW_LINKS]))
          uid (get attributes "uid")
          ;; Unix UIDs are unsigned, while NIO exposes them as Java ints.
          owner (when (integer? uid) (Integer/toUnsignedLong (int uid)))
          permissions (get attributes "permissions")]
      (when (get attributes "isSymbolicLink")
        (throw (ex-info "Refusing a symbolic-link credential file" {:code :insecure-credentials})))
      (when-not (true? (get attributes "isRegularFile"))
        (throw (ex-info "Private credential path must be a regular file" {:code :insecure-credentials})))
      (when-not (and (= owner @effective-user-id)
                     (some? permissions)
                     (every? owner-file-permissions permissions))
        (throw (ex-info "Credential file must be private and owner-only"
                        {:code :insecure-credentials})))
      {:file-key (get attributes "fileKey")
       :size (get attributes "size")
       :modified (get attributes "lastModifiedTime")
       :owner owner
       :permissions (set permissions)})
    (catch UnsupportedOperationException error
      (throw (ex-info "Cannot verify private credential file permissions"
                      {:code :insecure-credentials} error)))))

(defn assert-owner-file!
  "Reject linked, non-regular, foreign-owned or publicly accessible state files.
  Unlike protect-file!, this validates existing credentials without repairing them."
  [value]
  (let [target (path value)]
    (owner-file-identity target)
    (str target)))

(defn read-owner-file-text!
  "Read UTF-8 credentials through one no-follow open and verify private identity.
  Path snapshots detect visible replacement, not sustained same-UID ABA attacks."
  [value]
  (let [target (path value)]
    (try
      (let [before (owner-file-identity target)
            unchanged! (fn []
                         (when-not (= before (owner-file-identity target))
                           (throw (ex-info "Credential file changed while being read"
                                           {:code :insecure-credentials}))))]
        (when-not (:file-key before)
          (throw (ex-info "Cannot verify private credential file identity"
                          {:code :insecure-credentials})))
        (assert-owner-file! target)
        (with-open [channel (Files/newByteChannel
                             target (into-array OpenOption
                                                [StandardOpenOption/READ LinkOption/NOFOLLOW_LINKS]))
                    input (Channels/newInputStream channel)]
          (unchanged!)
          (let [text (slurp input :encoding "UTF-8")]
            (unchanged!)
            text)))
      (catch IOException error
        (throw (ex-info "Could not safely read private credential file"
                        {:code :insecure-credentials} error))))))
