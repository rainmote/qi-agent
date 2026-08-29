(ns qi.plugins.omp
  "Selected Oh My Pi harness ideas implemented as a reversible qì agent plugin.

  The plugin deliberately stays inside the existing ExecutionWorld and model
  registry boundaries. It adds content-anchored batch edits and role-based
  provider routing without replacing the default coding tools or runtime."
  (:require [qi.kernel :as kernel]
            [clojure.string :as str])
  (:import [java.math BigInteger]
           [java.nio.charset StandardCharsets]
           [java.security MessageDigest]))

(def ^:private standard-roles
  #{:default :plan :slow :smol :advisor})

(defn- sha256 [value]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) StandardCharsets/UTF_8))]
    (str/upper-case (format "%064x" (BigInteger. 1 digest)))))

(defn- file-tag [text]
  (subs (sha256 text) 0 12))

(defn- line-tag [text]
  (subs (sha256 text) 0 8))

(defn- text-layout [text]
  (let [newline (if (str/includes? text "\r\n") "\r\n" "\n")
        trailing-newline? (str/ends-with? text "\n")
        parts (if (empty? text)
                []
                (vec (str/split text #"\r?\n" -1)))
        lines (if (and trailing-newline? (seq parts) (empty? (peek parts)))
                (pop parts)
                parts)]
    {:lines (vec lines)
     :newline newline
     :trailing-newline? trailing-newline?}))

(defn- content-lines [content]
  (let [parts (vec (str/split (str content) #"\r?\n" -1))]
    (if (and (> (count parts) 1) (empty? (peek parts)))
      (pop parts)
      parts)))

(defn- layout-text [{:keys [lines newline trailing-newline?]}]
  (if (empty? lines)
    ""
    (str (str/join newline lines)
         (when trailing-newline? newline))))

(defn- read-all! [world path max-file-chars]
  (let [result ((:read! world)
                {:path path :offset 0 :limit (inc max-file-chars)})]
    (when (or (:truncated result) (> (:size result) max-file-chars))
      (throw (ex-info
              "File is too large for an anchored snapshot"
              {:path (:path result)
               :size (:size result)
               :max-file-chars max-file-chars})))
    result))

(defn- snapshot [path text]
  (let [layout (text-layout text)]
    {:path path
     :text text
     :file-hash (file-tag text)
     :layout layout
     :line-hashes (mapv line-tag (:lines layout))}))

(defn- snapshot-result [{:keys [path file-hash layout line-hashes]}]
  {:path path
   :file_hash file-hash
   :line_count (count (:lines layout))
   :lines (mapv (fn [index text hash]
                  {:line (inc index)
                   :anchor (str (inc index) ":" hash)
                   :text text})
                (range)
                (:lines layout)
                line-hashes)})

(defn- parse-anchor [anchor]
  (when-not (string? anchor)
    (throw (ex-info "Edit anchors must be strings like 12:AB12CD34"
                    {:anchor anchor})))
  (if-let [[_ line hash] (re-matches #"([1-9][0-9]*):([0-9A-Fa-f]{8})"
                                     anchor)]
    {:line (parse-long line) :hash (str/upper-case hash)}
    (throw (ex-info "Invalid edit anchor; expected LINE:8_HEX_HASH"
                    {:anchor anchor}))))

(defn- verify-anchor! [current anchor]
  (let [{:keys [line hash] :as parsed} (parse-anchor anchor)
        expected (get (:line-hashes current) (dec line))]
    (when-not expected
      (throw (ex-info "Edit anchor line is outside the current file"
                      {:anchor anchor
                       :line-count (count (:line-hashes current))})))
    (when-not (= expected hash)
      (throw (ex-info "Edit anchor content hash is stale"
                      {:anchor anchor
                       :expected (str line ":" expected)
                       :hint "Run hash_read again before editing."})))
    parsed))

(defn- operation [current edit]
  (let [op (some-> (:op edit) name str/lower-case keyword)
        start (verify-anchor! current (:start edit))
        end (verify-anchor! current (or (:end edit) (:start edit)))
        start-line (:line start)
        end-line (:line end)]
    (when-not (contains? #{:replace :delete :insert_before :insert_after} op)
      (throw (ex-info "Unsupported anchored edit operation" {:op (:op edit)})))
    (when (and (contains? #{:replace :delete} op)
               (> start-line end-line))
      (throw (ex-info "Edit start must not come after end"
                      {:start (:start edit) :end (:end edit)})))
    (when (and (contains? #{:insert_before :insert_after} op)
               (:end edit)
               (not= start-line end-line))
      (throw (ex-info "Insert operations accept one anchor only"
                      {:start (:start edit) :end (:end edit)})))
    (when (and (contains? #{:replace :insert_before :insert_after} op)
               (not (contains? edit :content)))
      (throw (ex-info "This edit operation requires content" {:op op})))
    (let [from (dec start-line)
          to end-line]
      (case op
        :replace {:op op :from from :to to
                  :content (content-lines (:content edit))
                  :lo (* 2 start-line) :hi (* 2 end-line)}
        :delete {:op op :from from :to to
                 :lo (* 2 start-line) :hi (* 2 end-line)}
        :insert_before {:op op :insert-index from
                        :content (content-lines (:content edit))
                        :lo (dec (* 2 start-line))
                        :hi (dec (* 2 start-line))}
        :insert_after {:op op :insert-index start-line
                       :content (content-lines (:content edit))
                       :lo (inc (* 2 start-line))
                       :hi (inc (* 2 start-line))}))))

(defn- reject-overlaps! [operations]
  (doseq [[left right] (partition 2 1 (sort-by :lo operations))]
    (when (<= (:lo right) (:hi left))
      (throw (ex-info "Anchored edit operations overlap"
                      {:left (select-keys left [:op :lo :hi])
                       :right (select-keys right [:op :lo :hi])}))))
  operations)

(defn- apply-operation [lines {:keys [op from to insert-index content]}]
  (case op
    :replace (vec (concat (subvec lines 0 from) content
                          (subvec lines to)))
    :delete (vec (concat (subvec lines 0 from) (subvec lines to)))
    (:insert_before :insert_after)
    (vec (concat (subvec lines 0 insert-index) content
                 (subvec lines insert-index)))))

(defn- apply-operations [layout operations]
  (let [descending (sort-by #(or (:insert-index %) (:from %)) > operations)]
    (assoc layout :lines (reduce apply-operation (:lines layout) descending))))

(defn- render-snapshot [_ {:keys [path file_hash lines]}]
  (str "[" path "#" file_hash "]"
       (when (seq lines)
         (str "\n"
              (str/join "\n"
                        (map #(str (:anchor %) "|" (:text %)) lines))))
       "\n[Use this exact file_hash and the LINE:HASH anchors with hash_edit. "
       "Run hash_read again after any write to this file.]"))

(defn- render-edit [_ {:keys [path previous_file_hash file_hash edits
                              line_count]}]
  (str "[" path "#" file_hash "]\n"
       "Applied " edits " anchored edit(s); " line_count " lines.\n"
       "Previous snapshot: " previous_file_hash
       ". Re-read before another edit to this file."))

(defn- hash-read-tool [world snapshots max-file-chars]
  {:name "hash_read"
   :description
   (str "Read a complete UTF-8 file with content-hash anchors. Use before "
        "hash_edit when editing non-trivial or concurrently changing files.")
   :parameters {:type "object"
                :required ["path"]
                :properties {"path" {:type "string"}}
                :additionalProperties false}
   :approval-target
   (fn [{:keys [path]}]
     {:provider (:provider world) :path ((:resolve! world) path)})
   :execute
   (fn [{:keys [path]} _]
     (let [result (read-all! world path max-file-chars)
           value (snapshot (:path result) (:content result))]
       (swap! snapshots assoc (:path result) value)
       (snapshot-result value)))
   :result-details
   (fn [_ value] (select-keys value [:path :file_hash :line_count]))
   :render render-snapshot})

(defn- hash-edit-tool [world snapshots max-file-chars max-edits]
  {:name "hash_edit"
   :description
   (str "Apply one or more content-anchored edits atomically in memory, then "
        "write once. Rejects stale snapshots, wrong line hashes, and overlaps.")
   :execution-mode :sequential
   :parameters
   {:type "object"
    :required ["path" "file_hash" "edits"]
    :properties
    {"path" {:type "string"}
     "file_hash" {:type "string" :pattern "^[0-9A-Fa-f]{12}$"}
     "edits"
     {:type "array" :minItems 1
      :items
      {:type "object"
       :required ["op" "start"]
       :properties
       {"op" {:type "string"
              :enum ["replace" "delete" "insert_before" "insert_after"]}
        "start" {:type "string" :pattern "^[1-9][0-9]*:[0-9A-Fa-f]{8}$"}
        "end" {:type "string" :pattern "^[1-9][0-9]*:[0-9A-Fa-f]{8}$"}
        "content" {:type "string"}}
       :additionalProperties false}}}
    :additionalProperties false}
   :approval-target
   (fn [{:keys [path]}]
     {:provider (:provider world) :path ((:resolve-write! world) path)})
   :execute
   (fn [{:keys [path file_hash edits]} _]
     (when (> (count edits) max-edits)
       (throw (ex-info "Too many operations in one anchored edit"
                       {:count (count edits) :max-edits max-edits})))
     (let [result (read-all! world path max-file-chars)
           canonical-path (:path result)
           remembered (get @snapshots canonical-path)
           provided (str/upper-case file_hash)
           current (snapshot canonical-path (:content result))]
       (when-not remembered
         (throw (ex-info "No hash_read snapshot exists for this file"
                         {:path canonical-path
                          :hint "Run hash_read before hash_edit."})))
       (when-not (= provided (:file-hash remembered))
         (throw (ex-info "Provided file hash is not the latest hash_read snapshot"
                         {:path canonical-path
                          :provided provided
                          :expected (:file-hash remembered)
                          :hint "Run hash_read again before editing."})))
       (when-not (= provided (:file-hash current))
         (throw (ex-info "File changed after hash_read; edit was rejected"
                         {:path canonical-path
                          :provided provided
                          :current (:file-hash current)
                          :hint "Run hash_read again before editing."})))
       (let [operations (->> edits
                             (mapv #(operation current %))
                             reject-overlaps!)
             updated-layout (apply-operations (:layout current) operations)
             updated-text (layout-text updated-layout)
             _ ((:write! world) {:path canonical-path
                                 :content updated-text
                                 :append false})
             next-snapshot (snapshot canonical-path updated-text)]
         ;; A returned post-edit hash is useful evidence, but it is not a new
         ;; read snapshot: the model has not seen the new line layout yet.
         ;; Force a fresh hash_read before another edit on this path.
         (swap! snapshots dissoc canonical-path)
         {:path canonical-path
          :previous_file_hash (:file-hash current)
          :file_hash (:file-hash next-snapshot)
          :edits (count edits)
          :line_count (count (get-in next-snapshot [:layout :lines]))})))
   :result-details
   (fn [_ value]
     (select-keys value [:path :previous_file_hash :file_hash :edits
                         :line_count]))
   :render render-edit})

(defn- role-key [value]
  (cond
    (keyword? value) value
    (string? value) (keyword (str/lower-case (str/trim value)))
    (nil? value) nil
    :else (throw (ex-info "Role must be a keyword or string" {:role value}))))

(defn- provider-key [value]
  (if (keyword? value) value (keyword (str value))))

(defn- normalize-roles [roles]
  (into {}
        (map (fn [[role providers]]
               [(role-key role)
                (mapv provider-key
                      (if (sequential? providers) providers [providers]))]))
        (or roles {})))

(defn- role-router! [ctx registry configured-roles default-role]
  (let [active (atom (role-key (or default-role :default)))
        roles (into standard-roles (keys configured-roles))
        available #(set (map :id ((:providers registry))))
        resolve-provider
        (fn [role]
          (let [candidates (get configured-roles role)
                registered (available)]
            (when (seq candidates)
              (or (some registered candidates)
                  (throw (ex-info "No configured provider for role is registered"
                                  {:role role
                                   :configured candidates
                                   :available registered}))))))
        status
        (fn []
          {:role @active
           :provider (or (resolve-provider @active)
                         (:id ((:current registry))))
           :roles (vec (sort roles))
           :routes configured-roles})
        set-role!
        (fn [role]
          (let [role (role-key role)]
            (when-not (contains? roles role)
              (throw (ex-info "Unknown model role"
                              {:role role :available roles})))
            (resolve-provider role)
            (reset! active role)
            (kernel/emit! ctx :omp/role-selected (status))
            (status)))
        service {:current #(deref active)
                 :status status
                 :set! set-role!
                 :roles #(vec (sort roles))}]
    (kernel/register-service! ctx :omp/roles service)
    (kernel/register-command!
     ctx
     {:name "role"
      :description "Show or select an OMP model role."
      :execute (fn [argument _]
                 (if (str/blank? argument)
                   (status)
                   (set-role! argument)))})
    (kernel/intercept!
     ctx :llm/request -20
     (fn [_ request next]
       (let [role (role-key (or (get-in request [:options :role]) @active))
             provider (resolve-provider role)
             routed (cond-> (update request :options #(dissoc (or % {}) :role))
                      provider (assoc-in [:options :provider] provider))]
         (kernel/emit! ctx :omp/role-routed
                       {:role role
                        :provider (or provider
                                      (:id ((:current registry))))})
         (next routed))))))

(def plugin
  {:id :omp/coding-foundation
   :description
   "OMP-inspired anchored editing and role-based model routing."
   :requires #{:execution/world :llm/registry}
   :provides #{:omp/roles}
   :start
   (fn [ctx {:keys [max-file-chars max-edits roles default-role]
            :or {max-file-chars 500000 max-edits 32
                 default-role :default}}]
     (when-not (and (pos-int? max-file-chars) (pos-int? max-edits))
       (throw (ex-info "OMP plugin limits must be positive integers"
                       {:max-file-chars max-file-chars
                        :max-edits max-edits})))
     (let [world (kernel/require-service ctx :execution/world)
           registry (kernel/require-service ctx :llm/registry)
           snapshots (atom {})]
       (kernel/register-tool!
        ctx (hash-read-tool world snapshots max-file-chars))
       (kernel/register-tool!
        ctx (hash-edit-tool world snapshots max-file-chars max-edits))
       (role-router! ctx registry (normalize-roles roles) default-role))
     nil)})
