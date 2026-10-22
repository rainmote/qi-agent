(ns qi.plugins.execution-world
  "Replaceable local filesystem/process execution world.

  Model-facing tools depend on this service instead of directly touching the
  host, so a container, SSH daemon, or test double can replace it."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.sandbox :as sandbox]
            [qi.secure-files :as secure]
            [qi.terminal-process :as terminal]
            [qi.workspace-runtime :as runtime]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.file Files LinkOption Path]
           [java.util.concurrent TimeUnit]))

(def ^:private seatbelt-profile
  (str "(version 1)\n"
       "(deny default)\n"
       "(allow process*)\n(allow signal)\n(allow sysctl-read)\n"
       "(allow mach-lookup)\n(allow ipc-posix-sem*)\n(allow ipc-posix-shm*)\n"
       "(allow file-read-metadata (subpath \"/Users\"))\n"
       "(allow file-read* (literal \"/\") (literal \"/var\") (literal \"/etc\")\n"
       "  (subpath \"/System\") (subpath \"/usr\") (subpath \"/bin\")\n"
       "  (subpath \"/sbin\") (subpath \"/Library\") (subpath \"/private\")\n"
       "  (subpath \"/dev\") (subpath (param \"WORKSPACE\")))\n"
       "(allow file-write* (subpath (param \"WORKSPACE\")))\n"))

(defn- real-path ^Path [path]
  (.toRealPath (fs/path path) (make-array LinkOption 0)))

(defn- lexical-path ^Path [^Path root input]
  (let [candidate (.normalize (.resolve root (str input)))]
    (when-not (.startsWith candidate root)
      (throw (ex-info "Path escapes the execution root"
                      {:path input :root (str root)})))
    candidate))

(defn- existing-inside ^Path [^Path root input]
  (let [target (real-path (lexical-path root input))]
    (when-not (.startsWith target root)
      (throw (ex-info "Path resolves outside the execution root"
                      {:path input :root (str root)})))
    target))

(defn- writable-inside ^Path [^Path root input]
  (let [target (lexical-path root input)
        parent (.getParent target)]
    (when-not parent
      (throw (ex-info "Write target has no parent" {:path input})))
    ;; Resolving the real parent rejects traversal through a symlink. Requiring
    ;; the parent to exist also avoids an unchecked create-directories walk.
    (let [real-parent (real-path parent)
          existing? (or (Files/exists target (make-array LinkOption 0))
                        (Files/isSymbolicLink target))]
      (when-not (.startsWith real-parent root)
        (throw (ex-info "Write target resolves outside the execution root"
                        {:path input :root (str root)})))
      (if existing?
        (let [real-target (real-path target)]
          (when-not (.startsWith real-target root)
            (throw (ex-info "Write target resolves outside the execution root"
                            {:path input :root (str root)})))
          real-target)
        (.resolve real-parent (str (.getFileName target)))))))

(defn- read-limited [path offset limit]
  (let [text (slurp (str path))
        start (min (count text) (max 0 offset))
        end (min (count text) (+ start limit))]
    {:content (subs text start end)
     :offset start
     :truncated (< end (count text))
     :size (count text)}))

(defn- assert-file-size! [path max-file-bytes]
  (let [size (Files/size path)]
    (when (> size max-file-bytes)
      (throw (ex-info "File exceeds the configured safe read limit"
                      {:path (str path)
                       :bytes size
                       :max-file-bytes max-file-bytes})))
    size))

(defn- content-bytes [value]
  (alength (.getBytes (str value) "UTF-8")))

(defn- assert-write-size! [content max-write-bytes]
  (let [size (content-bytes content)]
    (when (> size max-write-bytes)
      (throw (ex-info "Write exceeds the configured safe size limit"
                      {:bytes size :max-write-bytes max-write-bytes})))
    size))

(defn- logical-lines [text]
  ;; A final POSIX newline terminates the last physical line; it does not add a
  ;; second, phantom empty line to the range/count shown to the model.
  (if (empty? text)
    []
    (let [lines (str/split text #"\r?\n" -1)]
      (if (and (seq lines) (empty? (peek lines)))
        (pop (vec lines))
        (vec lines)))))

(defn- fit-whole-lines [lines max-chars]
  (loop [remaining lines fitted [] characters 0]
    (if-let [line (first remaining)]
      (let [separator (if (empty? fitted) 0 1)
            required (+ separator (count line))]
        (cond
          (<= (+ characters required) max-chars)
          (recur (next remaining) (conj fitted line)
                 (+ characters required))

          ;; Preserve a useful preview even when one line alone exceeds the
          ;; character budget. Offset-based continuation cannot recover the
          ;; remainder of that same line, so expose this case explicitly.
          (empty? fitted)
          {:lines [(subs line 0 (min max-chars (count line)))]
           :character-truncated? true
           :first-line-exceeds-limit? true}

          :else
          {:lines fitted :character-truncated? true}))
      {:lines fitted :character-truncated? false})))

(defn- read-lines-limited [path offset limit max-chars]
  (let [text (slurp (str path))
        lines (logical-lines text)
        total-lines (count lines)
        start (min total-lines (max 0 offset))
        requested-end (min total-lines (+ start (max 1 limit)))
        selected (subvec lines start requested-end)
        fitted (fit-whole-lines selected max-chars)
        output-lines (:lines fitted)
        character-truncated? (:character-truncated? fitted)
        first-line-exceeds-limit? (:first-line-exceeds-limit? fitted)
        returned-lines (count output-lines)
        end (+ start returned-lines)
        more-lines? (< end total-lines)]
    {:content (str/join "\n" output-lines)
     :offset start
     :line-count returned-lines
     :total-lines total-lines
     :truncated (or more-lines? character-truncated?)
     :truncated-by (cond
                     character-truncated? :characters
                     more-lines? :lines
                     :else nil)
     :first-line-exceeds-limit (boolean first-line-exceeds-limit?)
     :max-chars max-chars
     :size (count text)}))

(defn- relative [^Path root ^Path target]
  (str (.relativize root target)))

(defn- walk-paths [root max-walk-entries]
  ;; Files/walk does not follow symbolic links unless FOLLOW_LINKS is supplied.
  (with-open [paths (Files/walk root (make-array java.nio.file.FileVisitOption 0))]
    (let [entries (vec (take (inc max-walk-entries)
                             (iterator-seq (.iterator paths))))]
      (when (> (count entries) max-walk-entries)
        (throw (ex-info "Workspace traversal exceeds the configured entry limit"
                        {:root (str root)
                         :max-walk-entries max-walk-entries})))
      entries)))

(defn- direct-paths [root max-walk-entries]
  (with-open [entries (Files/newDirectoryStream root)]
    (let [values (vec (take (inc max-walk-entries) (seq entries)))]
      (when (> (count values) max-walk-entries)
        (throw (ex-info "Directory listing exceeds the configured entry limit"
                        {:root (str root)
                         :max-walk-entries max-walk-entries})))
      values)))

(defn- regular-files [root max-walk-entries max-file-bytes skipped]
  (->> (walk-paths root max-walk-entries)
       (filter #(Files/isRegularFile % (make-array LinkOption 0)))
       (remove #(Files/isSymbolicLink %))
       (filter (fn [file]
                 (if (<= (Files/size file) max-file-bytes)
                   true
                   (do (swap! skipped inc) false))))))

(defn- bounded [items limit]
  (let [values (vec (take (inc limit) items))]
    {:items (vec (take limit values))
     :truncated (> (count values) limit)}))

(defn- pump! [stream stream-name on-update spool-path preview-limit spool-limit update-limit
              overflow terminate!]
  (future
    (with-open [reader (io/reader stream)
                writer (io/writer spool-path)]
      (let [buffer (char-array 4096)
            output (StringBuilder.)]
        (loop [total 0
               live-characters 0]
          (let [n (.read reader buffer)]
            (if (neg? n)
              {:preview (str output)
               :total-chars total
               :path spool-path}
              (let [next-total (+ total n)
                    preview-count (min n (max 0 (- preview-limit (.length output))))
                    persist-count (min n (max 0 (- spool-limit total)))
                    live-count (min n (max 0 (- update-limit live-characters)))]
                (when (pos? preview-count)
                  (.append output buffer 0 preview-count))
                (when (pos? persist-count)
                  (.write writer buffer 0 persist-count))
                (when (and on-update (pos? live-count))
                  (on-update {:stream stream-name
                              :chunk (String. buffer 0 live-count)}))
                (when (and (> next-total spool-limit)
                           (compare-and-set!
                            overflow nil
                            {:stream stream-name
                             :max-output-file-chars spool-limit}))
                  (terminate!))
                (recur next-total (+ live-characters live-count))))))))))

(defn- spool-path! [output-root suffix]
  (secure/protect-managed-parents! output-root)
  (secure/protect-directory! output-root)
  (let [target (fs/path output-root
                        (str "." (random-uuid) "." suffix ".tmp"))]
    (secure/ensure-owner-file! target)
    (str target)))

(defn- persist-full-output! [output-root stdout-result stderr-result]
  (let [target (fs/path output-root (str (random-uuid) ".log"))]
    (secure/ensure-owner-file! target)
    (with-open [writer (io/writer (str target))]
      (.write writer "STDOUT\n")
      (with-open [reader (io/reader (:path stdout-result))]
        (io/copy reader writer))
      (.write writer "\nSTDERR\n")
      (with-open [reader (io/reader (:path stderr-result))]
        (io/copy reader writer)))
    (secure/protect-file! target)
    (str target)))

(def ^:private generated-output-name
  #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log")

(defn- prune-generated-output! [output-root max-output-files max-walk-entries]
  (if-not (Files/exists output-root (make-array LinkOption 0))
    0
    (let [files (->> (walk-paths output-root max-walk-entries)
                     (filter #(Files/isRegularFile % (make-array LinkOption 0)))
                     (filter #(re-matches generated-output-name
                                          (str (.getFileName %))))
                     (sort-by #(.toMillis
                                (Files/getLastModifiedTime
                                 % (make-array LinkOption 0)))
                              >))
          expired (drop max-output-files files)]
      (doseq [path expired]
        (fs/delete-if-exists path))
      (count expired))))

(defn- file-matches [root pattern file limit]
  (with-open [reader (io/reader (str file))]
    (->> (line-seq reader)
         (map-indexed vector)
         (keep (fn [[index line]]
                 (when (re-find pattern line)
                   {:path (relative root file)
                    :line (inc index)
                    :text line})))
         (take limit)
         doall)))

(defn- remember-descendants! [process tracked]
  (try
    (with-open [stream (.descendants (.toHandle process))]
      (let [handles (vec (iterator-seq (.iterator stream)))]
        (swap! tracked
               (fn [known]
                 (into {} (map (fn [handle] [(.pid handle) handle]))
                       (filter #(.isAlive %)
                               (concat (vals known) handles)))))))
    (catch Throwable _)))

(defn- process-groups-available? []
  (and (fs/executable? "/usr/bin/perl") (fs/executable? "/bin/kill")
       (fs/executable? "/bin/ps") (some? (io/resource "qi/process_guard.pl"))))

(defn- signal-group! [child signal]
  ;; The launcher creates this group before executing user code. Retaining the
  ;; group identity also covers orphans missed between ProcessHandle polls.
  @(process/process ["/bin/kill" signal "--" (str "-" (.pid child))]
                    {:out :string :err :string}))

(defn- terminate-process-tree! [process tracked]
  (remember-descendants! process tracked)
  (signal-group! process "-TERM")
  (let [root (.toHandle process)
        handles (conj (vec (reverse (vals @tracked))) root)]
    (doseq [handle handles]
      (when (.isAlive handle)
        (.destroy handle)))
    (try
      (.waitFor process 200 TimeUnit/MILLISECONDS)
      (catch Throwable _))
    (signal-group! process "-KILL")
    (doseq [handle handles]
      (when (.isAlive handle)
        (.destroyForcibly handle)))))

(defn- track-descendants-during-startup! [process tracked]
  ;; Pump/future setup can be descheduled while a short-lived parent exits.
  ;; Start discovery independently before that setup so its children remain
  ;; owned by this invocation even after they are reparented.
  (let [thread (Thread.
                (fn []
                  (try
                    (loop []
                      (remember-descendants! process tracked)
                      (when (.isAlive process)
                        (Thread/sleep 5)
                        (recur)))
                    (catch InterruptedException _))))]
    (.setName thread (str "qi-process-descendants-" (.pid process)))
    (.setDaemon thread true)
    (.start thread)
    thread))

(defn- remaining-ms [deadline]
  (max 0 (long (Math/ceil (/ (- deadline (System/nanoTime)) 1000000.0)))))

(defn- await-process! [process tracked deadline]
  ;; Remember children while the shell is alive so timeout/cancel still owns
  ;; them after their parent exits. Never block past the command deadline.
  (loop []
    (remember-descendants! process tracked)
    (let [remaining (remaining-ms deadline)]
      (cond
        (zero? remaining) false
        (not (.isAlive process)) true
        (.waitFor process (min 20 remaining) TimeUnit/MILLISECONDS) true
        :else (recur)))))

(defn- await-pump! [task deadline cancel-token]
  (loop []
    (cancellation/throw-if-cancelled! cancel-token)
    (let [remaining (remaining-ms deadline)
          value (deref task (min 20 remaining) ::drain-timeout)]
      (if (and (= ::drain-timeout value) (pos? remaining))
        (recur)
        value))))

(defn- process-command [sandbox root command assets]
  ;; Tool commands are intentionally non-login shells. A login shell reads
  ;; user startup files before executing the requested command, which leaks
  ;; unrelated configuration into results and conflicts with a workspace-only
  ;; sandbox (for example ~/.profile becomes a spurious permission error).
  (when-not (process-groups-available?)
    (throw (ex-info "POSIX process-group launcher is unavailable" {})))
  (into ["/usr/bin/perl" (-> (io/resource "qi/process_guard.pl") io/file .getCanonicalPath)
         "--parent" (str (.pid (java.lang.ProcessHandle/current))) "--"]
  (case sandbox
    :none ["/bin/sh" "-c" command]
    :seatbelt ["/usr/bin/sandbox-exec"
               "-D" (str "WORKSPACE=" root)
               "-D" (str "RUNTIME=" (or (:root assets) root))
               "-p" (str seatbelt-profile
                         (when (:available? assets) "\n(allow file-read* (subpath (param \"RUNTIME\")))\n"))
               "/bin/sh" "-c" command]
    :unavailable
    (throw (ex-info
            "Process execution is unavailable because no safe sandbox was found"
            {:sandbox sandbox})))))

(defn- spawn! [root output-root sandbox default-timeout max-timeout
               max-output max-output-file-chars max-output-files
               max-walk-entries assets
               {:keys [command cwd timeout-ms cancel-token on-update stream-output?]
                :or {cwd "."}}]
  (when (str/blank? command)
    (throw (ex-info "Command must not be blank" {})))
  (let [working-directory (existing-inside root cwd)]
    (when-not (fs/directory? working-directory)
      (throw (ex-info "Command cwd is not a directory" {:cwd cwd})))
    (cancellation/throw-if-cancelled! cancel-token)
    (let [effective-timeout (or timeout-ms default-timeout)]
      (when-not (and (pos-int? effective-timeout)
                     (<= effective-timeout max-timeout))
        (throw (ex-info "Command timeout is outside the configured safe range"
                        {:timeout-ms effective-timeout
                         :max-timeout-ms max-timeout})))
      (let [started (System/nanoTime)
          deadline (+ started (* effective-timeout 1000000))
          stdout-spool (spool-path! output-root "stdout")
          stderr-spool (spool-path! output-root "stderr")
          overflow (atom nil)
          process (try
                    (let [builder (doto (ProcessBuilder.
                                         (process-command sandbox root command assets))
                                    (.directory (io/file (str working-directory))))]
                      (when (:available? assets)
                        ;; Packaged tools do not inherit provider credentials,
                        ;; shell injection or npm user authentication settings.
                        (let [home (fs/path root ".qi-agent/workspace-runtime/home")
                              temporary (fs/path root ".qi-agent/workspace-runtime/tmp")]
                          (doseq [path [home temporary]]
                            (secure/protect-managed-parents! path)
                            (secure/protect-directory! path))
                          (.clear (.environment builder))
                          (.putAll (.environment builder)
                                   (merge {"HOME" (str home) "TMPDIR" (str temporary) "LANG" "en_US.UTF-8"}
                                          (runtime/environment assets root)))))
                      (.start builder))
                    (catch Throwable error
                      (doseq [path [stdout-spool stderr-spool]]
                        (try (fs/delete-if-exists path) (catch Throwable _)))
                      (throw error)))
          tracked (atom {})
          tracker (track-descendants-during-startup! process tracked)
          terminate! #(terminate-process-tree! process tracked)
          dispose-cancel (cancellation/on-cancel!
                          cancel-token
                          terminate!)
          stdout-task (pump! (.getInputStream process) :stdout on-update
                             stdout-spool max-output max-output-file-chars
                             (if stream-output? max-output-file-chars max-output)
                             overflow terminate!)
          stderr-task (pump! (.getErrorStream process) :stderr on-update
                             stderr-spool max-output max-output-file-chars
                             (if stream-output? max-output-file-chars max-output)
                             overflow terminate!)]
        (try
          ;; This API has no stdin writer. Deliver EOF instead of leaving a
          ;; command waiting for input that no caller can provide.
          (.close (.getOutputStream process))
          (let [completed? (await-process! process tracked deadline)]
            (when-not completed?
              (terminate!))
            (let [drain-deadline (if completed? deadline
                                  (+ (System/nanoTime) 500000000))
                  stdout (await-pump! stdout-task drain-deadline cancel-token)
                  stderr (await-pump! stderr-task drain-deadline cancel-token)
                  drained? (and (not= ::drain-timeout stdout)
                                (not= ::drain-timeout stderr))]
              (when-let [limit @overflow]
                (throw (ex-info "Command output exceeded the configured disk limit"
                                (assoc limit :command command))))
              (when-not (and completed? drained? (pos? (remaining-ms deadline)))
                (throw (ex-info "Command timed out"
                                {:timeout-ms effective-timeout :command command})))
              (cancellation/throw-if-cancelled! cancel-token)
              (let [truncated? (or (> (:total-chars stdout) max-output)
                                   (> (:total-chars stderr) max-output))
                    output-path (when truncated?
                                  (prune-generated-output!
                                   output-root (dec max-output-files)
                                   max-walk-entries)
                                  (persist-full-output! output-root stdout stderr))]
                {:exit-code (.exitValue process)
                 :stdout (:preview stdout)
                 :stderr (:preview stderr)
                 :stdout-chars (:total-chars stdout)
                 :stderr-chars (:total-chars stderr)
                 :truncated truncated?
                 :full-output-path output-path
                 :cwd (relative root working-directory)
                 :duration-ms (long (/ (- (System/nanoTime) started) 1000000))})))
          (finally
            (dispose-cancel)
            (.interrupt tracker)
            (try (.join tracker 100) (catch InterruptedException _))
            ;; Future interruption and stream/callback failures also own cleanup;
            ;; cancellation is not the only way a process can leave this scope.
            (terminate!)
            (doseq [stream [(.getInputStream process) (.getErrorStream process)]]
              (try (.close stream) (catch Throwable _)))
            (doseq [task [stdout-task stderr-task]]
              (when-not (future-done? task) (future-cancel task)))
            (doseq [path [stdout-spool stderr-spool]]
              (try (fs/delete-if-exists path) (catch Throwable _)))))))))

(def plugin
  {:id :execution/local-world
   :description "Workspace-bounded filesystem and cancellable process provider."
   :provides #{:execution/world}
   :start
   (fn [ctx {:keys [root timeout-ms max-timeout-ms
                    max-output-chars max-output-file-chars
                    max-file-bytes max-write-bytes max-walk-entries
                    max-output-files output-dir sandbox terminal-cleanup-mode]
             :or {root "." timeout-ms 30000 max-output-chars 50000
                  max-timeout-ms 300000
                  max-output-file-chars 10000000 max-file-bytes 16777216
                  max-write-bytes 4194304
                  max-walk-entries 100000
                  max-output-files 1000
                  output-dir ".qi-agent/tool-output" sandbox :auto terminal-cleanup-mode :strict}}]
     (terminal/capability terminal-cleanup-mode)
     (when-not (every? pos-int? [timeout-ms max-timeout-ms max-output-chars
                                 max-output-file-chars max-file-bytes
                                 max-write-bytes max-walk-entries
                                 max-output-files])
       (throw (ex-info "Execution limits must be positive integers"
                        {:timeout-ms timeout-ms
                        :max-timeout-ms max-timeout-ms
                        :max-output-chars max-output-chars
                        :max-output-file-chars max-output-file-chars
                        :max-file-bytes max-file-bytes
                        :max-write-bytes max-write-bytes
                        :max-walk-entries max-walk-entries
                        :max-output-files max-output-files})))
     (when (< max-output-file-chars max-output-chars)
       (throw (ex-info ":max-output-file-chars must be at least :max-output-chars"
                       {:max-output-chars max-output-chars
                        :max-output-file-chars max-output-file-chars})))
     (when (> timeout-ms max-timeout-ms)
       (throw (ex-info ":timeout-ms must not exceed :max-timeout-ms"
                       {:timeout-ms timeout-ms
                        :max-timeout-ms max-timeout-ms})))
     (let [workspace-root (real-path root)
           mode (sandbox/resolve-mode sandbox)
           assets (runtime/describe)
           terminal-capability (cond-> (terminal/capability terminal-cleanup-mode)
                                 (and (= terminal-cleanup-mode :native-process-group) (not= mode :seatbelt))
                                 (assoc :available? false :reason "Native PTY requires the original Seatbelt on its command child."))
           output-root (lexical-path workspace-root output-dir)
           _ (when (Files/exists output-root (make-array LinkOption 0))
               (secure/protect-tree! output-root))
           _ (prune-generated-output! output-root max-output-files
                                      max-walk-entries)
           world
           {:provider :local
            :sandbox mode
            :root (str workspace-root)
            :default-timeout-ms timeout-ms
            :max-timeout-ms max-timeout-ms
            :process-group-enabled (boolean (process-groups-available?))
            :workspace-runtime (select-keys assets [:available? :reason :python-version])
            :terminal-capability terminal-capability
            :terminal-controller (when (and (:available? terminal-capability)
                                            (:available? assets) (not= :unavailable mode))
                                   #(terminal/controller workspace-root (runtime/describe) mode seatbelt-profile terminal-cleanup-mode))
            :capabilities (cond-> #{:fs/read :fs/write}
                            (and (not= :unavailable mode)
                                 (process-groups-available?)) (conj :process))
            :resolve! (fn [path] (str (existing-inside workspace-root path)))
            :resolve-write! (fn [path]
                              (str (writable-inside workspace-root path)))
            :read! (fn [{:keys [path offset limit unit max-chars]
                         :or {offset 0 limit 50000 max-chars 50000}}]
                     (let [target (existing-inside workspace-root path)]
                       (assert-file-size! target max-file-bytes)
                       (merge {:path (relative workspace-root target)}
                              (if (= unit :lines)
                                (read-lines-limited target offset limit
                                                    max-chars)
                                (read-limited target offset limit)))))
            :write! (fn [{:keys [path content append]}]
                      (let [target (writable-inside workspace-root path)
                            bytes (assert-write-size! content max-write-bytes)
                            existing-bytes (if (and append
                                                    (Files/exists target
                                                     (make-array LinkOption 0)))
                                             (Files/size target)
                                             0)]
                        (when (> (+ existing-bytes bytes) max-write-bytes)
                          (throw (ex-info
                                  "Append would exceed the configured safe size limit"
                                  {:existing-bytes existing-bytes
                                   :bytes bytes
                                   :max-write-bytes max-write-bytes})))
                        (if append
                          (spit (str target) content :append true)
                          (spit (str target) content))
                        {:path (relative workspace-root target)
                         :bytes bytes
                         :appended (boolean append)}))
            :edit! (fn [{:keys [path old-text new-text]}]
                     (let [target (existing-inside workspace-root path)
                           _ (assert-file-size! target max-file-bytes)
                           content (slurp (str target))
                           first-index (.indexOf content old-text)
                           second-index (when-not (neg? first-index)
                                          (.indexOf content old-text
                                                    (inc first-index)))]
                       (when (neg? first-index)
                         (throw (ex-info "Edit text was not found" {:path path})))
                       (when (and second-index (not (neg? second-index)))
                         (throw (ex-info "Edit text is not unique" {:path path})))
                       (let [updated (str (subs content 0 first-index)
                                          new-text
                                          (subs content (+ first-index
                                                           (count old-text))))]
                         (assert-write-size! updated max-write-bytes)
                         (spit (str target) updated)
                         {:path (relative workspace-root target)
                          :replacements 1
                          :bytes (count (.getBytes updated "UTF-8"))})))
            :list! (fn [{:keys [path limit] :or {path "." limit 500}}]
                     (let [target (existing-inside workspace-root path)
                           entries (->> (direct-paths target max-walk-entries)
                                        (sort-by #(str (.getFileName %)))
                                        (map (fn [file]
                                               {:path (relative
                                                       workspace-root
                                                       file)
                                                :type (cond
                                                        (Files/isDirectory
                                                         file (make-array LinkOption 0))
                                                        :directory
                                                        (Files/isRegularFile
                                                         file (make-array LinkOption 0))
                                                        :file
                                                        :else :other)})))]
                       (merge {:path (relative workspace-root target)}
                              (bounded entries limit))))
            :find! (fn [{:keys [path pattern limit]
                         :or {path "." pattern "*" limit 500}}]
                     (let [target (existing-inside workspace-root path)
                           matcher (.getPathMatcher
                                    (java.nio.file.FileSystems/getDefault)
                                    (str "glob:" pattern))
                           entries (->> (walk-paths target max-walk-entries)
                                        (remove #(= target %))
                                        (filter #(.matches matcher
                                                            (.getFileName %)))
                                        (map #(relative workspace-root %))
                                        sort)]
                       (merge {:path (relative workspace-root target)
                               :pattern pattern}
                              (bounded entries limit))))
            :search! (fn [{:keys [path query limit]
                           :or {path "." limit 200}}]
                       (let [target (existing-inside workspace-root path)
                             pattern (re-pattern query)
                             skipped (atom 0)
                             matches
                             (mapcat #(file-matches workspace-root pattern %
                                                    (inc limit))
                                     (regular-files target max-walk-entries
                                                    max-file-bytes skipped))
                             result (bounded matches limit)]
                         (merge {:path (relative workspace-root target)
                                 :query query
                                 :skipped-files @skipped}
                                result)))
            :spawn! #(spawn! workspace-root output-root mode timeout-ms
                             max-timeout-ms
                             max-output-chars max-output-file-chars
                             max-output-files max-walk-entries assets %)}]
       ;; Kept on the existing ExecutionWorld service: neither Host nor renderer
       ;; gets a separate process launcher or a sandbox:none fallback.
       (kernel/register-service! ctx :execution/world world))
     nil)})
