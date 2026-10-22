(ns qi.terminal-process
  "Finite PTY guardian transport owned by ExecutionWorld, never by the Web Host."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [qi.secure-files :as secure]
            [qi.workspace-runtime :as runtime])
  (:import [java.util.concurrent TimeUnit]))

(defn capability
  ([] (capability :strict))
  ([mode]
   (when-not (contains? #{:strict :native-process-group} mode)
     (throw (ex-info "Unknown terminal cleanup mode" {:mode mode})))
   (let [native? (= mode :native-process-group)
         available? (and native? (= "Mac OS X" (System/getProperty "os.name")))]
     {:available? available? :cleanup-mode (name mode)
      :cleanup-scope (if native? "registered-process-groups" "all-descendants")
      :descendant-containment false
      :limitations (when native? ["Detached descendants may survive; cleanup observes registered process groups and the direct child only."
                                  "Process identity checks and group signals are best effort, not atomic containment."])
      :reason (when-not available?
                (if native? "Native process-group PTY currently requires macOS."
                  "PTY is unavailable: strict mode cannot prove cleanup of detached shell descendants. No terminal process was started."))})))

(defn- private-child! [root parts]
  (reduce (fn [parent part]
            (let [path (fs/path parent part)]
              (when (fs/sym-link? path) (throw (ex-info "Symbolic terminal state directory" {})))
              (secure/protect-directory! path)
              (when-not (fs/starts-with? (fs/real-path path) (fs/real-path root))
                (throw (ex-info "Terminal state escapes workspace" {})))
              path)) root parts))

(defn command
  "Native allocation is trusted and session-local; its command child must use
  the original Seatbelt file/network policy plus the fixed owned-TTY ioctl rule.
  JSON cannot select a program, device or policy."
  ([root assets sandbox profile] (command root assets sandbox profile :strict))
  ([root assets sandbox profile cleanup-mode]
  (capability cleanup-mode)
  (let [base [(:python assets) "-I" "-B" (:helper assets)
              "--parent" (str (.pid (java.lang.ProcessHandle/current))) "--root" (str root)
              "--cleanup-mode" (name cleanup-mode)]
        effective-profile (str profile "\n(allow file-read* (subpath (param \"RUNTIME\")))\n")]
    (if (= cleanup-mode :native-process-group)
      (do (when-not (= sandbox :seatbelt)
            (throw (ex-info "Native PTY requires the original Seatbelt on its command child" {})))
          (into base ["--seatbelt-profile" effective-profile "--runtime-root" (:root assets)]))
      (case sandbox
      :seatbelt (into ["/usr/bin/sandbox-exec" "-D" (str "WORKSPACE=" root)
                       "-D" (str "RUNTIME=" (:root assets)) "-p"
                       effective-profile]
                      base)
      :none base
      (throw (ex-info "No safe terminal execution world is available" {})))))))

(defn- read-line-bounded! [reader]
  (let [buffer (StringBuilder.)]
    (loop []
      (let [value (.read ^java.io.Reader reader)]
        (cond
          (neg? value) (when (pos? (.length buffer)) (str buffer))
          (= value 10) (str buffer)
          (>= (.length buffer) 524288) (throw (ex-info "Terminal response exceeds limit" {:uncertain true}))
          :else (do (.append buffer (char value)) (recur)))))))

(defn controller
  ([root assets sandbox profile] (controller root assets sandbox profile :strict))
  ([root assets sandbox profile cleanup-mode]
  (let [state (atom {:status "cold" :cleanup_confirmed true :uncertain false})
        child (atom nil)
        input (atom nil)
        reader (atom nil)
        active (atom nil)
        closed? (atom false)
        stop-requested? (atom false)
        stop-completion (promise)
        admission-lock (Object.)
        lock (Object.)
        observe! (fn [value]
                   (when (map? value)
                     (swap! state merge (select-keys value [:status :cleanup_confirmed :cleanup_observed :cleanup_scope
                                                            :cleanup_mode :descendant_containment :limitations :generation
                                                            :registered_groups :termination :last_interrupt :shell_exit_observed
                                                            :detached_observed :child_pid :guardian_pid :exit_code :reason
                                                            :failure_code :failure_errno :failure_stage :failure_trace :operation_stage
                                                            :command_sandbox :sandbox_ready :startup_aborted
                                                            :tty_path :tty_rdev :command_profile_sha256 :startup_error_output
                                                            :has_more :end :cursor :truncated]))))
        status (fn []
                 (let [process @child]
                   (cond
                     (and process (not (.isAlive ^Process process)) (not (:cleanup_confirmed @state)))
                     (swap! state assoc :status "unknown" :uncertain true :reason "guardian_exited_without_cleanup_confirmation")
                     (and process (not (.isAlive ^Process process)) (:cleanup_confirmed @state))
                     (swap! state assoc :status "closed")
                     :else @state)))
        read-response!
        (fn [id]
          (loop [notifications 0]
            (let [line (read-line-bounded! @reader)]
              (when-not line (throw (ex-info "Terminal guardian closed its control channel" {:uncertain true})))
              (let [value (json/parse-string line true)]
                (cond
                  (= "terminal.closed" (:event value))
                  (do (observe! (:result value))
                      (if (< notifications 2) (recur (inc notifications))
                          (throw (ex-info "Unexpected terminal notifications" {:uncertain true}))))
                  (= id (:id value))
                  (do (observe! (:result value)) value)
                  :else (throw (ex-info "Terminal response identity changed" {:uncertain true})))))))
        exchange!
        (fn [request]
          (locking lock
            (when (or (:uncertain @state) (and @active (not (realized? @active))))
              (throw (ex-info "Previous terminal outcome is unconfirmed; close without replaying input" {:uncertain true})))
            (let [id (str (random-uuid))
                  request (assoc request :id id)
                  receive (future (read-response! id))
                  write (future (.write ^java.io.OutputStream @input (.getBytes (str (json/generate-string request) "\n") "UTF-8"))
                                (.flush ^java.io.OutputStream @input))]
              (reset! active receive)
              (try
                (when (= ::timeout (deref write 1000 ::timeout))
                  (throw (ex-info "Terminal control write is unconfirmed" {:uncertain true})))
                (let [value (deref receive 5000 ::timeout)]
                  (when (= ::timeout value)
                    (throw (ex-info "Terminal operation result is unconfirmed" {:uncertain true})))
                  (when-not (:ok value)
                    (throw (ex-info "Terminal operation failed; input was not replayed" {:uncertain (not (get-in value [:result :cleanup_confirmed]))})))
                  (:result value))
                (catch Throwable error
                  (swap! state assoc :uncertain true :status "unknown")
                  (throw error))))))
        stop!
        (fn []
          (reset! closed? true)
          (let [process (locking admission-lock @child)]
            (if (compare-and-set! stop-requested? false true)
              (let [result
                    (try
                      (when process
                        (when (and (not (:cleanup_confirmed @state)) (not (:uncertain @state)))
                          (try (exchange! {:op "close"}) (catch Throwable _)))
                        ;; EOF never repeats input. It also releases a guardian
                        ;; which retained the naturally exited shell's output.
                        (deref (future (try (.close ^java.io.OutputStream @input) (catch Throwable _))) 500 nil)
                        (.waitFor ^Process process 5000 TimeUnit/MILLISECONDS))
                      (let [value (status)]
                        (if (and (:cleanup_confirmed value) (or (nil? process) (not (.isAlive ^Process process))))
                          (swap! state assoc :status "closed")
                          (swap! state assoc :status "unknown" :uncertain true :reason "cleanup_unconfirmed")))
                      (catch Throwable _
                        (swap! state assoc :status "unknown" :uncertain true :reason "cleanup_unconfirmed")))]
                (deliver stop-completion result)
                result)
              ;; Concurrent close/revoke/cancel shares one cleanup operation;
              ;; a second caller must not mutate the first one's live state.
              (deref stop-completion 6000 (assoc @state :status "unknown" :uncertain true :reason "cleanup_in_progress")))))]
    {:status status :close! stop!
     :request! exchange!
     :start! (fn [admit! cols rows]
               (locking admission-lock
               (when-not (:available? (capability cleanup-mode))
                 (throw (ex-info (:reason (capability cleanup-mode)) {:reason :descendant-containment-unavailable})))
               (when @closed? (throw (ex-info "Terminal admission was closed before start" {})))
               (when-not (:available? assets) (throw (ex-info (:reason assets) {})))
               (when @child (throw (ex-info "Terminal controller cannot be restarted" {:uncertain true})))
               (let [home (private-child! root [".qi-agent" "workspace-runtime" "home"])
                     temporary (private-child! root [".qi-agent" "workspace-runtime" "tmp"])
                     environment (merge {"HOME" (str home) "TMPDIR" (str temporary) "LANG" "en_US.UTF-8"
                                         "TERM" "xterm-256color" "HISTFILE" "/dev/null"}
                                        (runtime/environment assets root))
                     builder (doto (ProcessBuilder. (command root assets sandbox profile cleanup-mode))
                               (.directory (io/file (str root))))]
                 (.clear (.environment builder))
                 (.putAll (.environment builder) environment)
                 (when @closed? (throw (ex-info "Terminal admission was cancelled before process creation" {})))
                 (let [process (.start builder)]
                   (reset! child process)
                   (reset! input (.getOutputStream process))
                   (reset! reader (io/reader (.getInputStream process)))
                   (swap! state assoc :status "starting" :cleanup_confirmed false :guardian_pid (.pid process))
                   ;; Stderr is drained but never projected as arbitrary host
                   ;; data to the model or mixed into the JSON control stream.
                   (future (with-open [stream (.getErrorStream process)]
                             (let [buffer (byte-array 4096)]
                               (loop [] (when-not (neg? (.read stream buffer)) (recur))))))
                   (try
                     (admit! (.pid process))
                     (when @closed? (throw (ex-info "Terminal start was cancelled before PTY admission" {})))
                     (exchange! {:op "open" :cols cols :rows rows})
                     (catch Throwable error
                       (stop!)
                       (throw error)))))))})))
