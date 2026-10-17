(ns qi.plugins.tools
  "Thin Pi-style coding tools backed by the replaceable ExecutionWorld."
  (:require [qi.kernel :as kernel]
            [clojure.string :as str])
  (:import [java.time OffsetDateTime ZoneId]))

(def ^:private path-parameter
  {:type "object"
   :required ["path"]
   :properties {"path" {:type "string"}}
   :additionalProperties false})

(defn- target-path [world path write?]
  {:provider (:provider world)
   :path ((if write? (:resolve-write! world) (:resolve! world)) path)})

(defn- keep-result-details [keys]
  (fn [_ value] (select-keys value keys)))

(defn- collection-result-details [value]
  (assoc (select-keys value [:path :truncated])
         :item-count (count (:items value))))

(defn- current-time-tool []
  {:name "current_time"
   :description "Return the current time in an IANA timezone."
   :parameters {:type "object"
                :properties {"timezone" {:type "string"}}
                :additionalProperties false}
   :execute (fn [{:keys [timezone]} _]
              (let [zone (or timezone "UTC")]
                {:timezone zone
                 :time (str (OffsetDateTime/now (ZoneId/of zone)))}))})

(defn- read-details [value]
  (select-keys value [:path :offset :line-count :total-lines :truncated
                      :truncated-by :first-line-exceeds-limit :max-chars
                      :size]))

(defn- render-read-result
  [{requested-offset :offset}
   {result-offset :offset
    :keys [content line-count total-lines truncated truncated-by
           first-line-exceeds-limit max-chars]}]
  (let [requested-offset (or requested-offset 1)
        start-line (inc result-offset)
        end-line (+ result-offset line-count)
        beyond-eof? (or (and (zero? total-lines) (> requested-offset 1))
                        (and (pos? total-lines)
                             (> requested-offset total-lines)))
        notice
        (cond
          beyond-eof?
          (str "[Offset " requested-offset " is beyond end of file ("
               total-lines " lines total); no lines returned.]")

          (zero? total-lines)
          "[Read empty file (0 lines).]"

          first-line-exceeds-limit
          (str "[Line " start-line " exceeds the " max-chars
               " character limit; the preview is incomplete. Narrow the "
               "result with grep or an approved bash command.]")

          truncated
          (str "[Showing lines " start-line "-" end-line " of " total-lines
               (when (= :characters truncated-by)
                 (str " (" max-chars " character limit)"))
               ". Use offset=" (inc end-line) " to continue.]")

          :else
          (str "[Read lines " start-line "-" end-line " of " total-lines
               ".]"))]
    (str content (when-not (str/blank? content) "\n\n") notice)))

(defn- skill-url? [path]
  (and (string? path) (str/starts-with? path "skill://")))

(defn- skill-resources [ctx]
  (or (kernel/service ctx :resources/catalog)
      (throw (ex-info "skill:// requires the resource catalog plugin" {}))))

(defn- read-tool [ctx world default-lines max-chars]
  {:name "read"
   :description (str "Read UTF-8 file lines. offset is a one-based line "
                     "number and limit is the maximum number of lines. "
                     "Continue with the offset reported by a truncated result. "
                     "Offsets beyond EOF return no lines. "
                     "Discovered skills and their assets use skill:// URLs.")
   :parameters {:type "object"
                :required ["path"]
                :properties {"path" {:type "string"}
                             "offset" {:type "integer" :minimum 1
                                       :description "One-based start line."}
                             "limit" {:type "integer" :minimum 1
                                      :description "Maximum lines to return."}}
                :additionalProperties false}
   :approval-target #(if (skill-url? (:path %))
                       {:provider :resources :path (:path %)}
                       (target-path world (:path %) false))
   :execute
   (fn [{:keys [offset] :as args} _]
     (let [request (assoc args
                          :offset (dec (or offset 1))
                          :unit :lines
                          :limit (or (:limit args) default-lines)
                          :max-chars max-chars)]
       (if (skill-url? (:path args))
         ((:read-skill-resource (skill-resources ctx)) request)
         ((:read! world) request))))
   :result-details (fn [_ value] (read-details value))
   :render render-read-result})

(defn- read-file-alias [ctx world default-lines max-chars]
  (assoc (read-tool ctx world default-lines max-chars)
         :name "read_file"
         :description (str "Compatibility alias for read. "
                           "Offsets beyond EOF return no lines.")))

(defn- write-tool [world]
  {:name "write"
   :description "Write or append UTF-8 content to a file in the execution world."
   :execution-mode :sequential
   :parameters {:type "object"
                :required ["path" "content"]
                :properties {"path" {:type "string"}
                             "content" {:type "string"}
                             "append" {:type "boolean"}}
                :additionalProperties false}
   :approval-target #(target-path world (:path %) true)
   :execute (fn [args _] ((:write! world) args))
   :result-details (keep-result-details [:path :bytes :appended])})

(defn- edit-tool [world]
  {:name "edit"
   :description "Replace one exact, unique text occurrence in a file."
   :execution-mode :sequential
   :parameters {:type "object"
                :required ["path" "old_text" "new_text"]
                :properties {"path" {:type "string"}
                             "old_text" {:type "string"}
                             "new_text" {:type "string"}}
                :additionalProperties false}
   :approval-target #(target-path world (:path %) false)
   :execute (fn [{:keys [path old_text new_text]} _]
              ((:edit! world) {:path path :old-text old_text
                               :new-text new_text}))
   :result-details (keep-result-details [:path :replacements :bytes])})

(defn- list-tool [world]
  {:name "ls"
   :description "List immediate entries in a directory."
   :parameters {:type "object"
                :properties {"path" {:type "string"}
                             "limit" {:type "integer"}}
                :additionalProperties false}
   :approval-target #(target-path world (or (:path %) ".") false)
   :execute (fn [args _] ((:list! world) args))
   :result-details (fn [_ value] (collection-result-details value))
   :render (fn [_ {:keys [items truncated]}]
             (str (str/join "\n"
                            (map #(str (name (:type %)) "\t" (:path %))
                                 items))
                  (when truncated "\n[truncated]")))})

(defn- find-tool [world]
  {:name "find"
   :description "Find files or directories by a basename wildcard pattern."
   :parameters {:type "object"
                :properties {"path" {:type "string"}
                             "pattern" {:type "string"}
                             "limit" {:type "integer"}}
                :additionalProperties false}
   :approval-target #(target-path world (or (:path %) ".") false)
   :execute (fn [args _] ((:find! world) args))
   :result-details (fn [_ value] (collection-result-details value))
   :render (fn [_ {:keys [items truncated]}]
             (str (str/join "\n" items)
                  (when truncated "\n[truncated]")))})

(defn- grep-tool [world]
  {:name "grep"
   :description "Search UTF-8 workspace files with a regular expression."
   :parameters {:type "object"
                :required ["query"]
                :properties {"path" {:type "string"}
                             "query" {:type "string"}
                             "limit" {:type "integer"}}
                :additionalProperties false}
   :approval-target #(target-path world (or (:path %) ".") false)
   :execute (fn [args _] ((:search! world) args))
   :result-details (fn [_ value] (collection-result-details value))
   :render (fn [_ {:keys [items truncated]}]
             (str (str/join "\n"
                            (map #(str (:path %) ":" (:line %) ":"
                                       (:text %))
                                 items))
                  (when truncated "\n[truncated]")))})

(defn- bash-tool [ctx world default-timeout]
  {:name "bash"
   :description (str "Run a shell command in the execution world. "
                     "Set run_in_background to return a job ID immediately; "
                     "use job_output, job_list and job_kill to manage it.")
   :execution-mode :sequential
   :parameters {:type "object"
                :required ["command"]
                :properties {"command" {:type "string"}
                             "cwd" {:type "string"}
                             "run_in_background" {:type "boolean"}
                             "timeout_ms" {:type "integer" :minimum 1}}
                :additionalProperties false}
   :approval-target
   (fn [{:keys [command cwd]}]
     {:provider (:provider world)
      :cwd ((:resolve! world) (or cwd "."))
      :command command})
   :execute
   (fn [{:keys [command cwd timeout_ms run_in_background]} execution]
     (if run_in_background
       (let [jobs (or (kernel/service ctx :execution/jobs)
                      (throw (ex-info "Background jobs require the jobs plugin" {})))]
         ((:start! jobs) {:command command :cwd (or cwd ".")
                         :timeout-ms timeout_ms} execution))
       ((:spawn! world)
        {:command command
         :cwd (or cwd ".")
         :timeout-ms (or timeout_ms default-timeout)
         :cancel-token (:cancel-token execution)
         :on-update #(when-let [callback (:on-update execution)]
                       (callback execution %))})))
   :result-details
   (fn [_ value]
     (assoc (select-keys value [:exit-code :cwd :duration-ms :truncated
                                :full-output-path :job-id :status :background])
            :stdout-chars (count (:stdout value))
            :stderr-chars (count (:stderr value))))
   :render
   (fn [_ {:keys [exit-code stdout stderr truncated full-output-path job-id status]}]
     (if job-id
       (str "Background job " job-id " (" (name status) "). "
            "Use job_output with job_id=" job-id " to read progress.")
       (str "exit " exit-code
          (when-not (str/blank? stdout) (str "\nstdout:\n" stdout))
          (when-not (str/blank? stderr) (str "\nstderr:\n" stderr))
          (when truncated "\n[truncated]")
          (when full-output-path
            (str "\n[full output: " full-output-path "]")))))})

(def plugin
  {:id :tools/coding
   :description "ExecutionWorld-backed read/write/edit/bash/grep/find/ls tools."
   :requires #{:execution/world}
   :start
   (fn [ctx {:keys [max-read-chars default-read-lines timeout-ms
                    compatibility-read-file allow-tools]
             :or {max-read-chars 50000 default-read-lines 2000 timeout-ms 30000
                  compatibility-read-file true}}]
     (when-not (and (pos-int? max-read-chars)
                    (pos-int? default-read-lines)
                    (pos-int? timeout-ms))
       (throw (ex-info "Tool limits must be positive integers"
                       {:max-read-chars max-read-chars
                        :default-read-lines default-read-lines
                        :timeout-ms timeout-ms})))
     (when-not (or (nil? allow-tools)
                   (and (sequential? allow-tools) (every? string? allow-tools)))
       (throw (ex-info ":allow-tools must be an array of tool names" {})))
     (let [world (kernel/require-service ctx :execution/world)
           allowed (when (some? allow-tools) (set allow-tools))
           process? (contains? (:capabilities world) :process)]
       (doseq [tool (cond-> [(current-time-tool)
                             (read-tool ctx world default-read-lines
                                        max-read-chars)
                             (write-tool world)
                             (edit-tool world)
                             (list-tool world)
                             (find-tool world)
                             (grep-tool world)]
                      process? (conj (bash-tool ctx world timeout-ms))
                      compatibility-read-file
                      (conj (read-file-alias ctx world default-read-lines
                                             max-read-chars)))]
         (when (or (nil? allowed) (contains? allowed (:name tool)))
           (kernel/register-tool! ctx tool))))
     nil)})
