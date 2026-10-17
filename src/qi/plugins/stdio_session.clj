(ns qi.plugins.stdio-session
  "Persistent, workspace-bounded stdio processes for protocol plugins.

  Unlike the one-shot shell executor, commands are argv vectors and are never
  interpreted by a shell. The owning protocol plugin is responsible for
  consuming stdout; this provider captures only a bounded stderr tail."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.charset StandardCharsets]
           [java.nio.file Files LinkOption Path Paths]
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

(defn- inside-directory ^Path [root input]
  (let [root-path (.toRealPath (Paths/get root (make-array String 0))
                               (make-array LinkOption 0))
        candidate (.normalize (.resolve root-path (str input)))
        resolved (.toRealPath candidate (make-array LinkOption 0))]
    (when-not (.startsWith resolved root-path)
      (throw (ex-info "Session cwd resolves outside the execution root"
                      {:cwd (str input) :root root})))
    (when-not (Files/isDirectory resolved (make-array LinkOption 0))
      (throw (ex-info "Session cwd is not a directory" {:cwd (str input)})))
    resolved))

(defn- process-command [sandbox root command]
  (case sandbox
    :none command
    :seatbelt (into ["/usr/bin/sandbox-exec"
                     "-D" (str "WORKSPACE=" root)
                     "-p" seatbelt-profile]
                    command)
    :unavailable
    (throw (ex-info
            "Persistent processes are unavailable because no safe sandbox was found"
            {:sandbox sandbox}))))

(defn- append-tail [current chunk limit]
  (let [combined (str current chunk)
        size (count combined)]
    (if (> size limit)
      (subs combined (- size limit))
      combined)))

(defn- pump-stderr! [stream tail limit]
  (future
    (try
      (with-open [reader (io/reader stream StandardCharsets/UTF_8)]
        (let [buffer (char-array 2048)]
          (loop []
            (let [n (.read reader buffer)]
              (when-not (neg? n)
                (swap! tail append-tail (String. buffer 0 n) limit)
                (recur))))))
      (catch Throwable _))))

(defn- valid-command! [command]
  (when-not (and (vector? command)
                 (seq command)
                 (every? #(and (string? %) (not (str/blank? %))) command))
    (throw (ex-info "Session command must be a non-empty argv vector"
                    {:command command}))))

(defn- start-session! [world sessions stderr-limit close-timeout-ms
                       {:keys [command cwd env cancel-token]
                        :or {cwd "." env {}}}]
  (valid-command! command)
  (when-not (map? env)
    (throw (ex-info "Session environment must be a map" {:env env})))
  (cancellation/throw-if-cancelled! cancel-token)
  (let [root (:root world)
        working-directory (inside-directory root cwd)
        argv (process-command (:sandbox world) root command)
        builder (doto (ProcessBuilder. ^java.util.List argv)
                  (.directory (io/file (str working-directory))))
        process-env (.environment builder)]
    (doseq [[key value] env]
      (.put process-env (str key) (str value)))
    (let [process (.start builder)
          id (str (random-uuid))
          active? (atom true)
          stderr-tail (atom "")
          cancel-disposer (atom nil)
          close!
          (fn []
            (when (compare-and-set! active? true false)
              (when-let [dispose @cancel-disposer]
                (dispose))
              (try (.close (.getOutputStream process)) (catch Throwable _))
              (when (.isAlive process)
                (.destroy process)
                (when-not (.waitFor process close-timeout-ms
                                    TimeUnit/MILLISECONDS)
                  (.destroyForcibly process)
                  (.waitFor process close-timeout-ms
                            TimeUnit/MILLISECONDS)))
              (swap! sessions dissoc id)))]
      (pump-stderr! (.getErrorStream process) stderr-tail stderr-limit)
      (reset! cancel-disposer
              (cancellation/on-cancel! cancel-token close!))
      (let [session {:id id
                     :command command
                     :cwd (str working-directory)
                     :process process
                     :stdin (.getOutputStream process)
                     :stdout (.getInputStream process)
                     :alive? #(.isAlive process)
                     :exit-code #(when-not (.isAlive process)
                                   (.exitValue process))
                     :stderr-tail #(deref stderr-tail)
                     :wait! (fn [timeout-ms]
                              (.waitFor process timeout-ms
                                        TimeUnit/MILLISECONDS))
                     :close! close!}]
        (when @active?
          (swap! sessions assoc id session))
        (future
          (try
            (.waitFor process)
            (finally
              (when (compare-and-set! active? true false)
                (when-let [dispose @cancel-disposer]
                  (dispose))
                (swap! sessions dissoc id)))))
        session))))

(def plugin
  {:id :execution/stdio-session
   :description "Cancellable persistent argv/stdio process provider."
   :requires #{:execution/world}
   :provides #{:execution/stdio-session}
   :start
   (fn [ctx {:keys [stderr-tail-chars close-timeout-ms]
             :or {stderr-tail-chars 20000 close-timeout-ms 1000}}]
     (when-not (and (pos-int? stderr-tail-chars)
                    (pos-int? close-timeout-ms))
       (throw (ex-info "stdio session limits must be positive integers"
                       {:stderr-tail-chars stderr-tail-chars
                        :close-timeout-ms close-timeout-ms})))
     (let [world (kernel/require-service ctx :execution/world)
           sessions (atom {})
           service {:available? (contains? (:capabilities world) :process)
                    :open! (fn [options]
                             (start-session! world sessions stderr-tail-chars
                                             close-timeout-ms options))
                    :sessions (fn []
                                (->> @sessions vals
                                     (mapv (fn [session]
                                             (select-keys session
                                                          [:id :command :cwd])))))
                    :close-all! (fn []
                                  (doseq [session (vals @sessions)]
                                    ((:close! session))))}]
       (kernel/register-service! ctx :execution/stdio-session service)
       #((:close-all! service))))})
