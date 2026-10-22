(ns qi.plugins.tui
  "JLine TUI frontend using a Charm-style Model/Update/View architecture."
  (:require [qi.command :as command]
            [qi.context-summary :as summary]
            [qi.kernel :as kernel]
            [babashka.fs :as fs]
            [babashka.terminal :as terminal]
            [clojure.string :as str])
  (:import [java.text BreakIterator]
           [java.util Locale]
           [java.util.concurrent LinkedBlockingQueue TimeUnit]
           [org.jline.terminal Attributes Terminal TerminalBuilder]))

(def ^:private esc "\u001b[")
(def ^:private ansi-pattern #"\u001b\[[0-9;?]*[ -/]*[@-~]")
(def ^:private osc-pattern #"\u001b\][^\u0007]*(?:\u0007|\u001b\\)")
(def ^:private cursor-marker "\uFDD0")

(def themes
  {:midnight {:accent "38;5;81" :muted "38;5;244" :user "38;5;111"
              :assistant "38;5;114" :tool "38;5;215" :error "38;5;203"
              :border "38;5;238" :status "38;5;250"}
   :paper {:accent "38;5;25" :muted "38;5;242" :user "38;5;24"
           :assistant "38;5;28" :tool "38;5;130" :error "38;5;160"
           :border "38;5;245" :status "38;5;238"}
   :matrix {:accent "38;5;48" :muted "38;5;240" :user "38;5;82"
            :assistant "38;5;46" :tool "38;5;154" :error "38;5;196"
            :border "38;5;22" :status "38;5;120"}})

(defn- code [theme role]
  (str "\u001b[" (or (get theme role) "0") "m"))

(defn- styled [theme role text]
  (str (code theme role) text "\u001b[0m"))

(defn- strip-terminal-styles [text]
  (-> (str (or text ""))
      (str/replace ansi-pattern "")
      (str/replace osc-pattern "")))

(defn strip-ansi [text]
  (str/replace (strip-terminal-styles text) cursor-marker ""))

(defn- char-width [ch]
  (let [n (int ch)
        category (Character/getType ch)]
    (cond
      (or (< n 32) (<= 127 n 159)) 0
      (= n 0xFDD0) 0
      (contains? #{Character/NON_SPACING_MARK
                   Character/COMBINING_SPACING_MARK
                   Character/ENCLOSING_MARK}
                 category) 0
      (or (<= 4352 n 4447) (<= 9001 n 9002)
          (<= 11904 n 42191) (<= 44032 n 55203)
          (<= 63744 n 64255) (<= 65040 n 65049)
          (<= 65072 n 65131) (<= 65281 n 65376)
          (<= 65504 n 65510)) 2
      :else 1)))

(defn visible-width [text]
  (reduce (fn [total ch]
            (+ total (char-width ch)))
          0 (strip-ansi text)))

(defn- take-width [text width]
  (loop [remaining (seq (str text)) out [] used 0]
    (if-let [ch (first remaining)]
      (let [w (char-width ch)]
        (if (> (+ used w) width)
          [(apply str out) (apply str remaining)]
          (recur (next remaining) (conj out ch) (+ used w))))
      [(apply str out) ""])))

(defn wrap-text [text width]
  (let [width (max 1 width)
        text (str/replace (str (or text "")) "\t" "    ")]
    (vec
     (mapcat
      (fn [line]
        (if (empty? line)
          [""]
          (loop [remaining line lines []]
            (if (empty? remaining)
              lines
              (let [[head tail] (take-width remaining width)]
                (recur tail (conj lines head)))))))
      (str/split (strip-terminal-styles text) #"\n" -1)))))

(defn- grapheme-boundary [text cursor direction]
  (let [iterator (BreakIterator/getCharacterInstance Locale/ROOT)]
    (.setText iterator text)
    (let [boundary (case direction
                     :previous (.preceding iterator cursor)
                     :next (.following iterator cursor))]
      (if (= BreakIterator/DONE boundary)
        (if (= direction :previous) 0 (count text))
        boundary))))

(defn make-editor
  ([] (make-editor ""))
  ([text] {:text (str text) :cursor (count (str text))}))

(defn editor-insert [editor text]
  (let [{:keys [cursor]} editor
        current (:text editor)]
    {:text (str (subs current 0 cursor) text (subs current cursor))
     :cursor (+ cursor (count text))}))

(defn editor-backspace [editor]
  (let [{:keys [text cursor]} editor]
    (if (zero? cursor)
      editor
      (let [previous (grapheme-boundary text cursor :previous)]
        {:text (str (subs text 0 previous) (subs text cursor))
         :cursor previous}))))

(defn editor-delete [editor]
  (let [{:keys [text cursor]} editor]
    (if (>= cursor (count text))
      editor
      (let [next (grapheme-boundary text cursor :next)]
        (assoc editor :text (str (subs text 0 cursor)
                                 (subs text next)))))))

(defn editor-move [editor amount]
  (loop [next-editor editor
         remaining amount]
    (cond
      (zero? remaining) next-editor
      (neg? remaining)
      (recur (update next-editor :cursor
                     #(grapheme-boundary (:text next-editor) % :previous))
             (inc remaining))
      :else
      (recur (update next-editor :cursor
                     #(grapheme-boundary (:text next-editor) % :next))
             (dec remaining)))))

(defn- line-bounds [text cursor]
  (let [before (subs text 0 cursor)
        start (inc (.lastIndexOf before "\n"))
        next-newline (.indexOf text "\n" cursor)
        end (if (neg? next-newline) (count text) next-newline)]
    [start end]))

(defn editor-line-start [editor]
  (let [[start _] (line-bounds (:text editor) (:cursor editor))]
    (assoc editor :cursor start)))

(defn editor-line-end [editor]
  (let [[_ end] (line-bounds (:text editor) (:cursor editor))]
    (assoc editor :cursor end)))

(defn editor-vertical [editor direction]
  (let [{:keys [text cursor]} editor
        [start end] (line-bounds text cursor)
        column (visible-width (subs text start cursor))
        cursor-at-column
        (fn [line-start line-end]
          (+ line-start
             (count (first (take-width (subs text line-start line-end)
                                       column)))))]
    (case direction
      :up (if (zero? start)
            editor
            (let [previous-end (dec start)
                  previous-start (inc (.lastIndexOf
                                       (subs text 0 previous-end) "\n"))]
              (assoc editor :cursor
                     (cursor-at-column previous-start previous-end))))
      :down (if (= end (count text))
              editor
              (let [next-start (inc end)
                    next-newline (.indexOf text "\n" next-start)
                    next-end (if (neg? next-newline) (count text) next-newline)]
                (assoc editor :cursor
                       (cursor-at-column next-start next-end))))
      editor)))

(defn- content-text [content]
  (cond
    (string? content) content
    (sequential? content)
    (str/join "\n"
              (keep (fn [block]
                      (case (:type block)
                        :text (:text block)
                        "text" (:text block)
                        :image (str "[image " (:url block) "]")
                        "image" (str "[image " (:url block) "]")
                        nil))
                    content))
    (nil? content) ""
    :else (pr-str content)))

(defn- safe-render [renderer value options]
  (try
    (let [rendered (renderer value options)]
      (if (sequential? rendered) (vec (map str rendered)) [(str rendered)]))
    (catch Throwable error
      [(str "renderer error: " (ex-message error))])))

(defn- markdown-lines [state content width]
  (let [theme (:theme state)]
    (second
     (reduce
      (fn [[code? lines] line]
        (cond
          (str/starts-with? (str/trim line) "```")
          [(not code?) (conj lines (styled theme :muted line))]

          code?
          [code? (into lines (map #(styled theme :tool (str "  " %))
                                  (wrap-text line (max 1 (- width 2)))))]

          (str/starts-with? line "#")
          [code? (into lines
                       (map #(str "\u001b[1m" (styled theme :accent %) "\u001b[22m")
                            (wrap-text (str/replace line #"^#+\s*" "") width)))]

          (re-find #"^\s*[-*+]\s+" line)
          [code? (into lines
                       (map #(str (styled theme :accent "• ") %)
                            (wrap-text
                             (str/replace line #"^\s*[-*+]\s+" "")
                             (max 1 (- width 2)))))]

          :else
          [code?
           (into lines
                 (map (fn [wrapped]
                        (-> wrapped
                            (str/replace
                             #"`([^`]+)`"
                             (fn [[_ value]] (styled theme :tool value)))
                            (str/replace
                             #"\*\*([^*]+)\*\*"
                             (fn [[_ value]] (str "\u001b[1m" value
                                                  "\u001b[22m")))))
                      (wrap-text line width)))]))
      [false []]
      (str/split (str content) #"\n" -1)))))

(defn- message-lines [state message width]
  (let [theme (:theme state)
        role (keyword (or (:role message) "message"))
        renderer-id (or (:type message) (:custom_type message) role)
        renderer (or (get-in state [:registries :message-renderers renderer-id])
                     (when (keyword? renderer-id)
                       (get-in state [:registries :message-renderers
                                      (name renderer-id)]))
                     (get-in state [:registries :message-renderers
                                    role])
                     (get-in state [:registries :message-renderers
                                    (name role)]))]
    (if renderer
      (safe-render renderer message {:width width :theme theme})
      (let [[label color] (case role
                            :user ["You" :user]
                            :assistant ["Assistant" :assistant]
                            [(str/capitalize (name role)) :muted])
            content (content-text (:content message))]
        (if (str/blank? content)
          []
          (into [(styled theme color label)]
                (map #(str "  " %)
                     (if (= role :assistant)
                       (markdown-lines state content (- width 2))
                       (wrap-text content (- width 2))))))))))

(defn- compact-tool-text [value max-chars]
  (let [text (cond
               (nil? value) ""
               (string? value) value
               :else (pr-str value))
        text (str/trim (str/replace text #"\s+" " "))]
    (str (subs text 0 (min max-chars (count text)))
         (when (> (count text) max-chars) "…"))))

(defn- tool-argument-summary [tool-name arguments max-chars]
  (let [original arguments
        arguments (if (map? arguments) arguments {})
        value #(get arguments %)
        path (or (value :path) (value :file))]
    (compact-tool-text
     (case tool-name
       "bash" (str "$ " (or (value :command) (value :cmd) "")
                    (when-let [cwd (value :cwd)] (str " · cwd " cwd)))
       "bb_repl" (or (value :code) "")
       "read" (str path
                    (when-let [offset (value :offset)] (str ":" offset))
                    (when-let [limit (value :limit)] (str " · " limit " lines")))
       "read_file" (str path
                         (when-let [offset (value :offset)] (str ":" offset))
                         (when-let [limit (value :limit)]
                           (str " · " limit " lines")))
       "write" (str path " · " (count (str (or (value :content) "")))
                     " chars" (when (value :append) " · append"))
       "edit" (str path " · replace "
                    (count (str (or (value :old_text) (value :old) "")))
                    "→"
                    (count (str (or (value :new_text) (value :new) "")))
                    " chars")
       "grep" (str "/" (or (value :query) (value :pattern) "") "/ in "
                    (or path (value :root) "."))
       "find" (str (or (value :pattern) "*") " in "
                    (or path (value :root) "."))
       "ls" (str (or path (value :root) "."))
       "current_time" (str (or (value :timezone) "local"))
       (if (seq arguments) (pr-str arguments) (str (or original ""))))
     max-chars)))

(defn- tool-update-text [update]
  (if-let [chunk (:chunk update)]
    (str (name (or (:stream update) :output)) ": " chunk)
    (pr-str update)))

(defn- bash-exit-code [content]
  (when-let [[_ code] (and (string? content)
                           (re-find #"(?m)^exit (-?\d+)" content))]
    (parse-long code)))

(defn- tool-argument-label [tool-name]
  (case tool-name
    "bash" "command"
    "bb_repl" "code"
    ("read" "read_file") "file"
    ("write" "edit") "target"
    ("grep" "find") "search"
    "ls" "path"
    "args"))

(defn- tool-result-label [tool-name ok?]
  (if-not ok?
    "error"
    (case tool-name
      "bash" "output"
      ("read" "read_file") "preview"
      ("grep" "find") "matches"
      "ls" "entries"
      "bb_repl" "value"
      "result")))

(defn- tool-result-summary [tool-name result max-chars]
  (let [text (str (or (:content result) (:error result) ""))
        details (:details result)
        nonblank-lines (vec (remove str/blank? (str/split-lines text)))
        first-line (first nonblank-lines)]
    (compact-tool-text
     (case tool-name
       ("read" "read_file")
       (if (and (map? details) (number? (:total-lines details)))
         (let [start (inc (or (:offset details) 0))
               line-count (or (:line-count details) 0)
               end (+ (or (:offset details) 0) line-count)]
           (str (if (zero? line-count)
                  "empty file"
                  (str "lines " start "-" end "/" (:total-lines details)))
                " · " (:size details) " chars"
                (when (:truncated details) " · more available")
                (when first-line (str " · " first-line))))
         (str (count (str/split-lines text)) " lines · " (count text)
              " chars" (when first-line (str " · " first-line))))

       "write"
       (if (map? details)
         (str (if (:appended details) "appended " "wrote ")
              (:bytes details) " bytes → " (:path details))
         text)

       "edit"
       (if (map? details)
         (str (:replacements details) " replacement"
              (when (not= 1 (:replacements details)) "s")
              " · " (:bytes details) " bytes → " (:path details))
         text)

       "bash"
       (if (map? details)
         (str "exit " (:exit-code details)
              " · stdout " (:stdout-chars details) " chars"
              (when (pos? (or (:stderr-chars details) 0))
                (str " · stderr " (:stderr-chars details) " chars"))
              (when (:truncated details) " · truncated"))
         text)

       ("grep" "find" "ls")
       (if (and (map? details) (number? (:item-count details)))
         (str (:item-count details) " items"
              (when (:truncated details) " · more available")
              (when-let [path (:path details)] (str " · " path)))
         (str (count nonblank-lines) " items"
              (when first-line (str " · " first-line))))

       text)
     max-chars)))

(defn- legacy-duration-ms [event result-event]
  (or (get-in result-event [:data :duration-ms])
      (try
        (when (and (:at event) (:at result-event))
          (.toMillis (java.time.Duration/between
                      (java.time.Instant/parse (:at event))
                      (java.time.Instant/parse (:at result-event)))))
        (catch Throwable _ nil))))

(defn- attach-tool-result [timeline index event]
  (let [call-event (get timeline index)
        result-data (cond-> (:data event)
                      (nil? (get-in event [:data :duration-ms]))
                      (assoc :duration-ms
                             (legacy-duration-ms call-event event)))]
    (-> timeline
        (assoc-in [index :data :result] result-data)
        (assoc-in [index :data :result-event] event))))

(defn- build-timeline [events]
  (loop [remaining (seq events) collapsed [] open-calls {}]
    (if-let [event (first remaining)]
      (let [type (some-> (:type event) name)
            call-id (get-in event [:data :call-id])]
        (cond
          (and (= "tool/call" type) call-id)
          (recur (next remaining)
                 (conj collapsed event)
                 (assoc open-calls call-id (count collapsed)))

          (and (= "tool/result" type) call-id
               (contains? open-calls call-id))
          (let [index (get open-calls call-id)
                collapsed (attach-tool-result collapsed index event)]
            (recur (next remaining)
                   collapsed
                   (dissoc open-calls call-id)))

          :else
          (recur (next remaining) (conj collapsed event) open-calls)))
      {:timeline collapsed :open-tool-calls open-calls})))

(defn- collapse-tool-events [events]
  (:timeline (build-timeline events)))

(defn- tool-lines [state event width]
  (let [{:keys [type data]} event
        type (some-> type name)
        theme (:theme state)
        tool-name (:name data)
        live (get-in state [:live-tools (:call-id data)])
        result (or (:result data)
                   (when (:ended? live)
                     (dissoc live :updates :ended?))
                   (when (= "tool/result" type) data))
        completed? (some? result)
        ok? (and completed? (true? (:ok result)))
        exit-code (when (= tool-name "bash")
                    (or (get-in result [:details :exit-code])
                        (bash-exit-code (:content result))))
        display-ok? (and ok? (or (nil? exit-code) (zero? exit-code)))
        status (cond (not completed?) :running ok? :done :else :error)
        data (-> (merge data live result)
                 (assoc :arguments (:arguments data)
                        :result result
                        :status status))
        renderer (or (get-in state [:registries :tool-renderers tool-name])
                     (:render-tui (kernel/tool (:context state) tool-name)))]
    (if renderer
      (safe-render renderer data {:width width :theme theme
                                  :event-type "tool/execution"
                                  :phase status})
      (let [expanded? (:tools-expanded? state)
            duration (:duration-ms result)
            icon (cond (= status :running) "◆" display-ok? "✓" :else "✗")
            status-label (cond
                           (= status :running) "running"
                           (number? exit-code) (str "exit " exit-code)
                           (= status :done) "done"
                           :else "error")
            head (styled theme (if (and completed? (not display-ok?))
                                 :error :tool)
                         (str icon " " (or tool-name "unknown-tool")
                              " · " status-label
                              (when (number? duration)
                                (str " · " duration " ms"))))
            summary-limit (max 40 (min 240 (* 2 (max 20 width))))
            argument-summary (tool-argument-summary
                              tool-name (:arguments data) summary-limit)
            argument-lines
            (when-not (str/blank? argument-summary)
              (map #(str "  " (tool-argument-label tool-name) ": " %)
                   (wrap-text argument-summary (max 1 (- width 8)))))
            update-lines
            (mapcat (fn [update]
                      (map #(str "  live: " %)
                           (wrap-text (compact-tool-text
                                       (tool-update-text update)
                                       summary-limit)
                                      (max 1 (- width 8)))))
                    (if expanded? (:updates data)
                        (take-last 1 (:updates data))))
            result-text (or (:error result) (:content result))
            result-text (if expanded?
                          (str (or result-text ""))
                          (tool-result-summary tool-name result
                                               summary-limit))
            result-lines
            (when (and completed? (not (str/blank? result-text)))
              (map #(str "  " (tool-result-label tool-name display-ok?)
                         ": " %)
                   (wrap-text result-text (max 1 (- width 10)))))
            detail-lines
            (when expanded?
              (concat
               (when-let [call-id (:call-id data)] [(str "  id: " call-id)])
               (when (seq (:arguments data))
                 (map #(str "  args*: " %)
                      (wrap-text (pr-str (:arguments data))
                                 (max 1 (- width 9)))))))]
        (vec (concat [head]
                     (if expanded? detail-lines argument-lines)
                     update-lines result-lines))))))

(defn- entry-lines [state event width]
  (let [{:keys [type data]} event
        renderer (get-in state [:registries :entry-renderers type])]
    (cond
      renderer (safe-render renderer event
                            {:width width :theme (:theme state)})
      (= "message" type)
      (when-not (= "tool" (get-in data [:message :role]))
        (message-lines state (:message data) width))
      (contains? #{"tool/call" "tool/result"} type)
      (tool-lines state event width)
      (= "ui/output" type)
      (mapv #(styled (:theme state) :muted %)
            (wrap-text (if (string? data) data (pr-str data)) width))
      (= "ui/error" type)
      (mapv #(styled (:theme state) :error %)
            (wrap-text (str data) width))
      :else [])))

(defn- project-session-events [events]
  (reduce
   (fn [visible event]
     (case (some-> (:type event) name)
       "session/clear" []
       "session/compaction"
       (mapv (fn [message]
               {:type "message" :data {:message message}})
             (get-in event [:data :replacement_messages]))
       (conj visible event)))
   [] events))

(defn- state-timeline [state]
  (or (:timeline state)
      (collapse-tool-events (project-session-events (:events state)))))

(defn- render-durable-lines [state width timeline]
  (vec
   (mapcat #(or (entry-lines state % width) [])
           (concat timeline (:local-events state)))))

(defn- cache-entry-key [scope index event]
  [scope (or (:id event)
             [(some-> (:type event) name)
              (get-in event [:data :call-id])
              index])])

(defn- reusable-entry-cache? [state width cache]
  (and cache
       (= width (:width cache))
       (= (:theme-name state) (:theme-name cache))
       (= (:tools-expanded? state) (:tools-expanded? cache))
       (identical? (:registries state) (:registries cache))))

(defn- render-entry-cache [state width scope events old-entries reusable?]
  (reduce-kv
   (fn [{:keys [entries lines]} index event]
     (let [key (cache-entry-key scope index event)
           live (when (= "tool/call" (some-> (:type event) name))
                  (get-in state [:live-tools (get-in event
                                                     [:data :call-id])]))
           cached (when reusable? (get old-entries key))
           rendered (if (and cached
                             (identical? event (:event cached))
                             (identical? live (:live cached)))
                      (:lines cached)
                      (vec (or (entry-lines state event width) [])))]
       {:entries (assoc entries key {:event event :live live
                                     :lines rendered})
        :lines (into lines rendered)}))
   {:entries {} :lines []}
   (vec events)))

(defn- durable-cache-valid? [state width timeline]
  (let [cache (:durable-cache state)]
    (and cache
         (= width (:width cache))
         (= (:theme-name state) (:theme-name cache))
         (= (:tools-expanded? state) (:tools-expanded? cache))
         (identical? timeline (:timeline cache))
         (identical? (:live-tools state) (:live-tools cache))
         (identical? (:local-events state) (:local-events cache))
         (identical? (:registries state) (:registries cache)))))

(defn- refresh-durable-cache [state]
  (let [width (max 20 (:width state 80))
        timeline (state-timeline state)
        old-cache (:durable-cache state)
        reusable? (reusable-entry-cache? state width old-cache)
        timeline-render
        (render-entry-cache state width :timeline timeline
                            (:entries old-cache) reusable?)
        local-render
        (render-entry-cache state width :local (:local-events state)
                            (:entries old-cache) reusable?)]
    (assoc state :durable-cache
           {:width width
            :theme-name (:theme-name state)
            :tools-expanded? (:tools-expanded? state)
            :timeline timeline
            :live-tools (:live-tools state)
            :local-events (:local-events state)
            :registries (:registries state)
            :entries (merge (:entries timeline-render)
                            (:entries local-render))
            :lines (into (:lines timeline-render)
                         (:lines local-render))})))

(defn replace-session-events
  "Replace durable session events and rebuild the incremental TUI timeline."
  [state events]
  (let [events (vec events)
        {:keys [timeline open-tool-calls]}
        (build-timeline (project-session-events events))]
    (-> state
        (assoc :events events
               :timeline timeline
               :open-tool-calls open-tool-calls
               :scroll 0)
        refresh-durable-cache)))

(defn- append-session-event [state event]
  (let [type (some-> (:type event) name)
        call-id (get-in event [:data :call-id])
        state (update state :events conj event)]
    (case type
      "session/clear"
      (assoc state :timeline [] :open-tool-calls {} :scroll 0)

      "session/compaction"
      (assoc state
             :timeline (mapv (fn [message]
                               {:type "message" :data {:message message}})
                             (get-in event [:data :replacement_messages]))
             :open-tool-calls {}
             :scroll 0)

      "tool/call"
      (if call-id
        (-> state
            (assoc-in [:open-tool-calls call-id]
                      (count (:timeline state)))
            (update :timeline conj event))
        (update state :timeline conj event))

      "tool/result"
      (if-let [index (and call-id
                          (get-in state [:open-tool-calls call-id]))]
        (-> state
            (update :timeline attach-tool-result index event)
            (update :open-tool-calls dissoc call-id))
        (update state :timeline conj event))

      (update state :timeline conj event))))

(defn transcript-lines [state width]
  (let [timeline (state-timeline state)
        durable (if (durable-cache-valid? state width timeline)
                  (get-in state [:durable-cache :lines])
                  (render-durable-lines state width timeline))
        partial (when (= :model (get-in state [:agent-state :phase]))
                  (let [reasoning (get-in state
                                          [:agent-state :partial-reasoning])
                        answer (get-in state
                                       [:agent-state :partial-assistant])]
                    (concat
                     (when (and (:tools-expanded? state)
                                (not (str/blank? reasoning)))
                       (into [(styled (:theme state) :muted "Reasoning · live")]
                             (map #(str "  " %)
                                  (wrap-text reasoning (- width 2)))))
                     (when-not (str/blank? answer)
                       (into [(styled (:theme state) :assistant
                                      "Assistant · live")]
                             (map #(str "  " %)
                                  (markdown-lines state answer
                                                  (- width 2))))))))]
    (vec (concat durable partial))))

(defn- editor-view [state width max-lines focused?]
  (let [{:keys [text cursor]} (:editor state)
        cursor-view (if focused?
                      (str cursor-marker
                           (when-not (:hardware-cursor? state) "▌"))
                      "")
        marked (str (subs text 0 cursor) cursor-view (subs text cursor))
        content-width (max 1 (- width 3))
        raw-lines (wrap-text marked content-width)
        cursor-line (dec (count (wrap-text
                                 (str (subs text 0 cursor) cursor-marker "▌")
                                 content-width)))
        max-lines (max 1 max-lines)
        start (max 0 (min (max 0 (- (count raw-lines) max-lines))
                          (- cursor-line (dec max-lines))))
        raw-lines (subvec raw-lines start
                          (min (count raw-lines) (+ start max-lines)))
        theme (:theme state)]
    (mapv (fn [index line]
            (str (styled theme :accent
                         (if (and (zero? (+ start index)) (zero? start))
                           "❯ " "  "))
                 line))
          (range) raw-lines)))

(defn- widget-lines [state placement width]
  (vec
   (mapcat
    (fn [[_ {:keys [value options]}]]
      (when (= placement (:placement options))
        (let [rendered (try
                         (if (fn? value) (value state) value)
                         (catch Throwable error
                           [(str "widget error: " (ex-message error))]))]
          (mapcat #(wrap-text % width)
                  (if (sequential? rendered) rendered [(str rendered)])))))
    (get-in state [:registries :widgets]))))

(defn- fit-visible [text width]
  (let [line (first (wrap-text text (max 1 width)))
        padding (max 0 (- width (visible-width line)))]
    (str line (apply str (repeat padding " ")))))

(defn- status-line [state width]
  (let [provider (when-let [registry (:model-registry state)]
                   ((:current registry)))
        phase (or (get-in state [:agent-state :phase]) :idle)
        usage (get-in state [:agent-state :last-result :usage :total_tokens])
        context (:context-manager state)
        context-tokens (when context
                         ((:estimate! context) ((:messages (:store state)))))
        context-percent (when context-tokens
                          (long (* 100 (/ context-tokens
                                          (:context-window context)))))
        extras (->> (get-in state [:registries :statuses]) vals
                    (map :value) (remove nil?) (map str))
        hint (when (>= width 70)
               "  Ctrl+N newline · Ctrl+O tools · Ctrl+T theme")
        text (str (name phase)
                  (when provider (str "  " (name (or (:id provider) provider))))
                  (when usage (str "  " usage " tokens"))
                  (when context-percent (str "  ctx " context-percent "%"))
                  (when (pos? (:scroll state 0))
                    (str "  history ↑" (:scroll state)))
                  (when (seq extras) (str "  " (str/join "  " extras)))
                  hint)]
    (fit-visible text width)))

(defn- pending-lines [state width]
  (mapv (fn [{:keys [kind message]}]
          (styled (:theme state) :muted
                  (first (wrap-text
                          (str "↳ " (if (= kind :follow-up)
                                      "follow-up" "steer") ": " message)
                          width))))
        (:queue state)))

(defn- overlay-lines [state width height]
  (when-let [{:keys [kind title message items selected editor lines view model]}
             (:overlay state)]
    (let [box-width (max 20 (min (- width 4) 72))
          theme (:theme state)
          border (apply str (repeat (- box-width 2) "─"))
          max-body-lines (max 1 (- height 5))
          body
          (case kind
            :select
            (let [message-lines (vec (take 2
                                           (when message
                                             (wrap-text message
                                                        (- box-width 4)))))
                  item-budget (max 1 (- max-body-lines
                                        (count message-lines)))
                  item-count (count items)
                  start (max 0 (min (max 0 (- item-count item-budget))
                                    (- selected (quot item-budget 2))))
                  visible-items (subvec (vec items) start
                                        (min item-count (+ start item-budget)))]
              (concat
               message-lines
               (map-indexed
                (fn [index {:keys [label description]}]
                  (let [actual-index (+ start index)]
                    (str (if (= actual-index selected) "› " "  ") label
                         (when description (str " — " description)))))
                visible-items)))
            :input (let [{:keys [text cursor]} editor]
                     (wrap-text (str "❯ " (subs text 0 cursor)
                                     cursor-marker
                                     (when-not (:hardware-cursor? state) "▌")
                                     (subs text cursor))
                                (- box-width 4)))
            :custom (or (when view
                          (try
                            (let [value (view model)]
                              (if (sequential? value) value [(str value)]))
                            (catch Throwable error
                              [(str "view error: " (ex-message error))])))
                        lines [])
            [])]
      (vec
       (concat
        [(styled theme :border (str "┌" border "┐"))
         (styled theme :accent
                 (str "│ " (fit-visible title (- box-width 3)) "│"))]
        (map (fn [line]
               (let [plain (fit-visible line (- box-width 4))]
                 (str (styled theme :border "│") " " plain " "
                      (styled theme :border "│"))))
             (take max-body-lines body))
        [(styled theme :border (str "└" border "┘"))])))))

(defn render-screen [state]
  (let [width (max 20 (:width state 80))
        height (max 8 (:height state 24))
        theme (:theme state)
        header [(styled theme :accent "qì agent")
                (styled theme :border (apply str (repeat width "─")))]
        above (widget-lines state :above-editor width)
        below (widget-lines state :below-editor width)
        pending (pending-lines state width)
        notifications (mapv (fn [{:keys [text level]}]
                              (styled theme (if (= level :error) :error :muted)
                                      (str "• " text)))
                            (take-last 2 (:notifications state)))
        editor-budget (max 1
                           (min (max 3 (quot height 3))
                                (max 1 (- height (count header) (count above)
                                          (count below) (count pending)
                                          (count notifications) 2))))
        editor (editor-view state width editor-budget (nil? (:overlay state)))
        fixed (+ (count header) (count above) (count below) (count pending)
                 (count editor) (count notifications) 1)
        available (max 1 (- height fixed))
        transcript (transcript-lines state width)
        end (max 0 (- (count transcript) (:scroll state 0)))
        start (max 0 (- end available))
        visible (subvec transcript start end)
        visible (into visible (repeat (- available (count visible)) ""))
        base (vec (concat header visible notifications above pending editor below
                          [(styled theme :status (status-line state width))]))
        overlay (overlay-lines state width height)]
    (if (seq overlay)
      (let [start-row (max 2 (quot (- height (count overlay)) 2))]
        (reduce-kv (fn [lines index line]
                     (if (< (+ start-row index) (count lines))
                       (assoc lines (+ start-row index) line)
                       lines))
                   base overlay))
      base)))

(defn- registry-service [queue]
  (let [state (atom {:message-renderers {} :entry-renderers {}
                     :tool-renderers {} :shortcuts {} :statuses {}
                     :widgets {}})
        registration-order (atom 0)
        refresh! #(.offer ^LinkedBlockingQueue queue {:type :ui-refresh})
        register!
        (fn [bucket owner id value]
          (let [key [owner id]
                active? (atom true)]
            (swap! state assoc-in [bucket key]
                   {:order (swap! registration-order inc) :value value})
            (refresh!)
            (fn []
              (when (compare-and-set! active? true false)
                (swap! state update bucket dissoc key)
                (refresh!)))))
        effective
        (fn [bucket]
          (reduce (fn [result [[_ id] registration]]
                    (assoc result id (:value registration)))
                  {}
                  (sort-by (comp :order val) (get @state bucket))))]
    (let [registries (fn [] {:message-renderers
                             (effective :message-renderers)
                             :entry-renderers (effective :entry-renderers)
                             :tool-renderers (effective :tool-renderers)
                             :shortcuts (effective :shortcuts)
                             :statuses (effective :statuses)
                             :widgets (effective :widgets)})]
      {:registries registries
       :register-message-renderer!
       #(register! :message-renderers %1 %2 %3)
       :register-entry-renderer! #(register! :entry-renderers %1 %2 %3)
       :register-tool-renderer! #(register! :tool-renderers %1 %2 %3)
       :register-shortcut! #(register! :shortcuts %1 %2 %3)
       :set-status! #(register! :statuses %1 %2 {:value %3})
       :set-widget! #(register! :widgets %1 %2 {:value %3 :options %4})
       :notify! #(.offer ^LinkedBlockingQueue queue
                         {:type :ui-notify :notification %})
       :set-theme! #(.offer ^LinkedBlockingQueue queue
                            {:type :ui-theme :theme %})
       :snapshot (fn [] {:registries (registries)})})))

(defn- prompt-service [queue active?]
  (letfn [(request! [kind request]
            (when-not @active?
              (throw (ex-info "The TUI prompt service is not active" {})))
            (let [result (promise)]
              (.put ^LinkedBlockingQueue queue
                    {:type :ui-request :kind kind
                     :request request :result result})
              @result))]
    {:active? (fn [] @active?)
     :select! #(request! :select %)
     :confirm! #(request! :select
                          (merge {:items [{:label "Yes" :value true}
                                          {:label "No" :value false}]
                                  :default false}
                                 %))
     :input! #(request! :input %)
     :custom! #(request! :custom %)}))

(defn- startup-trust-overlay [ctx]
  (when-let [trust (kernel/service ctx :project/trust)]
    (let [info (if-let [info-fn (:decision-info trust)]
                 (info-fn)
                 {:decision ((:decision trust)) :explicit? true})]
      (when (and (= :deny (:decision info))
                 (not (:explicit? info))
                 (:set-decision! trust))
        {:kind :select
         :title "Trust this project?"
         :message (str (:root trust)
                       "\nTrust enables Bash, file changes, and project resources.")
         :items [{:label "Trust project"
                  :description "Enable project tools and resources."
                  :value :allow}
                 {:label "Open restricted"
                  :description "Keep privileged tools blocked."
                  :value :deny}
                 {:label "Exit"
                  :description "Close without saving a decision."
                  :value :exit}]
         :selected 1
         :required? true
         :on-done
         (fn [state choice]
           (if (= :exit choice)
             (assoc state :running? false)
             (let [decision (if (= :allow choice) :allow :deny)
                   changed ((:set-decision! trust) decision)
                   resources (kernel/service ctx :resources/catalog)
                   _ (when resources ((:reload! resources)))
                   text (if (= :allow decision)
                          (str "Trusted project: " (:root changed))
                          "Opened in restricted mode. Use /trust allow to enable Bash and writes.")]
               (update state :local-events conj
                       {:type "ui/output" :data text}))))}))))

(defn- completion-files [root]
  (try
    (->> (fs/glob root "**")
         (filter fs/regular-file?)
         (remove #(str/includes? (str %) "/.git/"))
         (map #(str (fs/relativize root %)))
         (take 500)
         vec)
    (catch Throwable _ [])))

(defn initial-state [ctx config registries]
  (let [store (kernel/require-service ctx :session/store)
        messages ((:messages store))
        events ((:events store))
        state {:width 80 :height 24
               :local-events []
               :live-tools {}
               :agent-state ((:state (kernel/require-service
                                      ctx :agent/session)))
               :editor (make-editor)
               :history (->> messages (filter summary/user-instruction?)
                             (map :content) (filter string?)
                             (take-last 100) vec)
               :history-index nil
               :history-draft nil
               :scroll 0
               :queue []
               :tools-expanded? false
               :running? true
               :overlay (startup-trust-overlay ctx)
               :notifications []
               :theme-name (or (:theme config) :midnight)
               :theme (get themes (or (:theme config) :midnight)
                           (:midnight themes))
               :hardware-cursor? (boolean (:hardware-cursor config))
               :registries (registries)
               :model-registry (kernel/service ctx :llm/registry)
               :context-manager (kernel/service ctx :context/manager)
               :store store
               :context ctx
               :root (or (:root config) ".")
               :files (delay (completion-files (or (:root config) ".")))}]
    (replace-session-events state events)))

(defn- local-event [state type data]
  (update state :local-events conj {:type type :data data}))

(defn- sync-session-events [state]
  (if-let [events-fn (get-in state [:store :events])]
    (replace-session-events state (events-fn))
    state))

(defn- complete-overlay [state value]
  (let [{:keys [result on-done]} (:overlay state)
        next-state (assoc state :overlay nil)]
    (when result (deliver result value))
    (if on-done
      (try
        (on-done next-state value)
        (catch Throwable error
          (local-event next-state "ui/error" (ex-message error))))
      next-state)))

(defn- select-overlay [title items & [{:keys [message result on-done default]}]]
  {:kind :select :title title :message message :items (vec items)
   :selected (max 0 (or (first (keep-indexed
                                (fn [index item]
                                  (when (= default (:value item)) index))
                                items)) 0))
   :result result :on-done on-done})

(defn- selector-for-command [ctx state result]
  (case (:ui result)
    :model-selector
    (let [registry (kernel/service ctx :llm/registry)
          providers (or (when-let [providers-fn (:providers registry)]
                          (providers-fn))
                        (get-in result [:output :providers]) [])
          items (mapv (fn [provider]
                        (let [id (or (:id provider) (:provider provider))]
                          {:label (name id) :description (:model provider)
                           :value id})) providers)]
      (assoc state :overlay
             (select-overlay
              "Select provider" items
              {:on-done (fn [s id]
                          (if id
                            (local-event s "ui/output"
                                         ((:select! registry) id))
                            s))})))
    :tree-selector
    (let [tree (:output result)
          items (mapv (fn [entry]
                        {:label (str (or (:label entry) (:id entry)))
                         :description (str (:type entry))
                         :value (:id entry)}) tree)
          store (kernel/require-service ctx :session/store)]
      (assoc state :overlay
             (select-overlay "Session tree" items
                              {:on-done (fn [s id]
                                          (if id
                                            (-> s
                                                (local-event
                                                 "ui/output"
                                                 ((:checkout! store) id))
                                                sync-session-events)
                                            s))})))
    :session-selector
    (let [sessions (:output result)
          items (mapv (fn [session]
                        {:label (or (:name session) (:label session)
                                    (:session-id session) "unnamed")
                         :description (str (:message-count session)
                                           " messages · " (:path session))
                         :value (:path session)}) sessions)]
      (assoc state :overlay
             (select-overlay
              "Sessions" items
              {:on-done
               (fn [s path]
                 (if path
                   (let [current (when-let [current-fn
                                            (some-> (:model-registry s)
                                                    :current)]
                                   (current-fn))]
                     (assoc s
                            :next-session path
                            :next-provider (or (:id current)
                                               (:provider current))
                            :running? false))
                   s))})))
    :theme-selector
    (if-let [requested (:theme result)]
      (if-let [theme (get themes requested)]
        (assoc state :theme-name requested :theme theme)
        (local-event state "ui/error" (str "Unknown theme: " requested)))
      (assoc state :overlay
             (select-overlay
              "Select theme"
              (mapv (fn [theme-name]
                      {:label (name theme-name) :value theme-name})
                    (keys themes))
              {:default (:theme-name state)
               :on-done (fn [s name]
                          (if-let [theme (get themes name)]
                            (assoc s :theme-name name :theme theme)
                            s))})))
    (cond-> state
      (:error result) (local-event "ui/error" (:error result))
      (some? (:output result)) (local-event "ui/output" (:output result)))))

(defn- submit! [ctx state mode]
  (let [text (str/trim (:text (:editor state)))
        session (kernel/require-service ctx :agent/session)]
    (if (str/blank? text)
      state
      (if (str/starts-with? text "/")
        (let [result (command/dispatch! ctx text)
              state (-> state
                        (assoc :editor (make-editor)
                               :history-index nil
                               :history-draft nil)
                        sync-session-events)]
          (if (:quit? result)
            (assoc state :running? false)
            (selector-for-command ctx state result)))
        (try
          (let [phase (get-in state [:agent-state :phase])
                idle? (= :idle phase)
                accepted-state
                (fn [next-state]
                  (-> next-state
                      (assoc :editor (make-editor)
                             :history-index nil
                             :history-draft nil)
                      (update :history
                              (fn [history]
                                (let [history (if (= text (last history))
                                                history
                                                (conj history text))]
                                  (vec (take-last 100 history)))))))]
            (cond
              (and (= mode :follow-up) (not idle?))
              (do ((:follow-up! session) text) (accepted-state state))

              (and (or (= mode :steer) (= mode :normal)) (not idle?))
              (do ((:steer! session) text) (accepted-state state))

              :else
              (let [{:keys [result]} ((:submit! session) text)]
                (future
                  (let [{:keys [ok error]} @result]
                    (when-not ok
                      (kernel/emit! ctx :ui/run-error
                                    {:message (ex-message error)}))))
                (accepted-state state))))
          (catch Throwable error
            (local-event state "ui/error" (ex-message error))))))))

(defn- history-move [state direction]
  (let [history (:history state)
        current (:history-index state)
        state (if (and (= direction :up) (nil? current))
                (assoc state :history-draft (:editor state))
                state)
        next-index (case direction
                     :up (max 0 (if (nil? current)
                                  (dec (count history)) (dec current)))
                     :down (min (count history)
                                (if (nil? current) (count history)
                                    (inc current))))]
    (if (empty? history)
      state
      (if (= next-index (count history))
        (assoc state :history-index nil
               :editor (or (:history-draft state) (make-editor))
               :history-draft nil)
      (assoc state :history-index next-index
             :editor (make-editor (nth history next-index)))))))

(defn- completion-overlay [ctx state]
  (let [text (get-in state [:editor :text])
        cursor (get-in state [:editor :cursor])
        before (subs text 0 cursor)
        token (or (re-find #"[^\s]*$" before) "")]
    (cond
      (str/starts-with? token "/")
      (let [prefix (subs token 1)
            items (->> (command/commands ctx)
                       (filter #(str/starts-with? (:name %) prefix))
                       (mapv #(assoc % :label (str "/" (:name %))
                                     :value (str "/" (:name %) " "))))]
        (if (seq items)
          (assoc state :overlay
                 (select-overlay
                  "Commands" items
                  {:on-done (fn [s value]
                              (if value
                                (let [start (- cursor (count token))]
                                  (assoc s :editor
                                         {:text (str (subs text 0 start) value
                                                     (subs text cursor))
                                          :cursor (+ start (count value))}))
                                s))}))
          state))
      (or (str/starts-with? token "@") (str/includes? token "/"))
      (let [at? (str/starts-with? token "@")
            prefix (if at? (subs token 1) token)
            items (->> @(:files state)
                       (filter #(str/includes? % prefix))
                       (take 30)
                       (mapv (fn [path] {:label path :value path})))]
        (if (seq items)
          (assoc state :overlay
                 (select-overlay
                  "Files" items
                  {:on-done (fn [s value]
                              (if value
                                (let [start (- cursor (count token))
                                      replacement (str (when at? "@") value)]
                                  (assoc s :editor
                                         {:text (str (subs text 0 start)
                                                     replacement
                                                     (subs text cursor))
                                          :cursor (+ start
                                                     (count replacement))}))
                                s))}))
          state))
      :else state)))

(defn- shortcut-name [key]
  (if (string? key)
    key
    (case key
      :ctrl-c "ctrl+c" :ctrl-d "ctrl+d" :ctrl-n "ctrl+n"
      :ctrl-o "ctrl+o" :ctrl-s "ctrl+s" :ctrl-t "ctrl+t"
      :alt-enter "alt+enter" :tab "tab" :escape "escape"
      :enter "enter" nil)))

(defn- handle-overlay-key [state key text]
  (let [{:keys [kind items selected editor required?]} (:overlay state)]
    (case kind
      :select
      (case key
        :up (assoc-in state [:overlay :selected]
                      (max 0 (dec selected)))
        :down (if (seq items)
                (assoc-in state [:overlay :selected]
                          (min (dec (count items)) (inc selected)))
                state)
        :enter (complete-overlay state (:value (nth items selected nil)))
        :escape (if required? state (complete-overlay state nil))
        state)
      :input
      (case key
        :enter (complete-overlay state (:text editor))
        :escape (complete-overlay state nil)
        :backspace (update-in state [:overlay :editor] editor-backspace)
        :left (update-in state [:overlay :editor] editor-move -1)
        :right (update-in state [:overlay :editor] editor-move 1)
        (if text (update-in state [:overlay :editor] editor-insert text) state))
      :custom
      (if-let [update-fn (get-in state [:overlay :update])]
        (try
          (let [outcome (update-fn (get-in state [:overlay :model])
                                   {:key key :text text})
                {:keys [model done? value]}
                (if (map? outcome) outcome {:model outcome})]
            (if done?
              (complete-overlay state value)
              (assoc-in state [:overlay :model] model)))
          (catch Throwable error
            (-> state
                (assoc-in [:overlay :lines]
                          [(str "update error: " (ex-message error))])
                (assoc-in [:overlay :view] nil)
                (assoc-in [:overlay :update] nil))))
        (case key
          :enter (complete-overlay state true)
          :escape (complete-overlay state nil)
          state))
      state)))

(defn handle-key [ctx state key text]
  (if (:overlay state)
    (if (= key :ctrl-c)
      (if (get-in state [:overlay :required?])
        (complete-overlay state :exit)
        (do
          ((:abort! (kernel/require-service ctx :agent/session)))
          (handle-overlay-key state :escape nil)))
      (handle-overlay-key state key text))
    (if-let [shortcut (and (shortcut-name key)
                           (get-in state [:registries :shortcuts
                                          (shortcut-name key)]))]
      (do
        (try ((:handler shortcut) {:context ctx :state state})
             (catch Throwable error
               (kernel/emit! ctx :ui/run-error
                             {:message (ex-message error)})))
        state)
      (case key
        :enter (submit! ctx state :normal)
        :alt-enter (submit! ctx state :follow-up)
        :ctrl-s (submit! ctx state :steer)
        :ctrl-n (-> state (update :editor editor-insert "\n")
                    (assoc :history-index nil :history-draft nil))
        :backspace (-> state (update :editor editor-backspace)
                       (assoc :history-index nil :history-draft nil))
        :delete (-> state (update :editor editor-delete)
                    (assoc :history-index nil :history-draft nil))
        :left (update state :editor editor-move -1)
        :right (update state :editor editor-move 1)
        :home (update state :editor editor-line-start)
        :end (update state :editor editor-line-end)
        :up (if (not (str/includes? (get-in state [:editor :text]) "\n"))
              (history-move state :up)
              (update state :editor editor-vertical :up))
        :down (if (:history-index state)
                (history-move state :down)
                (update state :editor editor-vertical :down))
        :page-up (let [line-count (count (transcript-lines
                                          state (:width state 80)))
                       limit (max 0 (dec line-count))
                       step (max 5 (- (:height state 24) 7))]
                   (update state :scroll #(min limit (+ % step))))
        :page-down (let [step (max 5 (- (:height state 24) 7))]
                     (update state :scroll #(max 0 (- % step))))
        :ctrl-o (update state :tools-expanded? not)
        :ctrl-t (selector-for-command ctx state
                                      {:ui :theme-selector})
        :tab (completion-overlay ctx state)
        :escape (do ((:abort! (kernel/require-service ctx :agent/session)))
                    state)
        :ctrl-c (if (= :idle (get-in state [:agent-state :phase]))
                  (let [now (System/currentTimeMillis)]
                    (if (< (- now (or (:last-ctrl-c-at state) 0)) 500)
                      (assoc state :running? false)
                      (-> state
                          (assoc :editor (make-editor)
                                 :history-index nil
                                 :history-draft nil
                                 :last-ctrl-c-at now)
                          (update :notifications
                                  #(vec (take-last
                                         5 (conj % {:text "Press Ctrl+C again to exit"
                                                    :level :info})))))))
                  (do ((:abort! (kernel/require-service ctx :agent/session)))
                      state))
        :ctrl-d (if (str/blank? (get-in state [:editor :text]))
                  (assoc state :running? false)
                  (update state :editor editor-delete))
        (if text
          (-> state (update :editor editor-insert text)
              (assoc :history-index nil :history-draft nil))
          state)))))

(defn- durable-state-changed? [before after]
  (or (not= (:width before) (:width after))
      (not= (:theme-name before) (:theme-name after))
      (not= (:tools-expanded? before) (:tools-expanded? after))
      (not (identical? (:timeline before) (:timeline after)))
      (not (identical? (:live-tools before) (:live-tools after)))
      (not (identical? (:local-events before) (:local-events after)))
      (not (identical? (:registries before) (:registries after)))))

(defn- preserves-scrolled-history? [message]
  (case (:type message)
    :session-event
    (not (contains? #{"session/clear" "session/compaction"}
                    (some-> (get-in message [:event :type]) name)))

    (:agent-state :tool-update :tool-end :run-error) true
    false))

(defn- preserve-scroll-position [before after]
  (let [old-scroll (:scroll before 0)]
    (if-not (pos? old-scroll)
      after
      (let [width (:width before 80)
            old-count (count (transcript-lines before width))
            new-count (count (transcript-lines after width))
            next-scroll (+ old-scroll (- new-count old-count))
            limit (max 0 (dec new-count))]
        (assoc after :scroll (max 0 (min limit next-scroll)))))))

(defn update-state [ctx state message registries]
  (let [next-state
        (case (:type message)
    :key (handle-key ctx state (:key message) (:text message))
    :paste (-> state (update :editor editor-insert (:text message))
               (assoc :history-index nil :history-draft nil))
    :session-event
    (let [event (:event message)
          state (append-session-event state event)]
      (if (= "tool/result" (some-> (:type event) name))
        (update state :live-tools dissoc (get-in event [:data :call-id]))
        state))
    :agent-state (assoc state :agent-state (:state message))
    :queue-update (assoc state :queue (vec (:queue message)))
    :tool-update
    (let [event (:event message)
          call-id (:call-id event)]
      (update-in state [:live-tools call-id]
                 (fn [live]
                   (-> (merge live (dissoc event :update))
                       (update :updates
                               #(vec (take-last 20
                                                (conj (or % [])
                                                      (:update event)))))))))
    :tool-end (update-in state
                         [:live-tools (get-in message [:event :call-id])]
                         merge (:event message) {:ended? true})
    :ui-refresh (assoc state :registries (registries))
    :ui-notify (update state :notifications
                       #(vec (take-last 5 (conj % (:notification message)))))
    :ui-theme (if-let [theme (get themes (:theme message))]
                (assoc state :theme-name (:theme message) :theme theme)
                state)
    :ui-request
    (let [{:keys [kind request result]} message]
      (assoc state :overlay
             (case kind
               :select (select-overlay (:title request) (:items request)
                                       {:message (:message request)
                                        :default (:default request)
                                        :result result})
               :input {:kind :input :title (:title request)
                       :editor (make-editor (:value request)) :result result}
               :custom {:kind :custom :title (:title request)
                        :lines (vec (:lines request))
                        :model (:model request)
                        :view (:view request)
                        :update (:update request)
                        :result result}
               nil)))
    :run-error (local-event state "ui/error" (:message message))
    :terminal-closed (-> state
                         (assoc :running? false)
                         (local-event "ui/error"
                                      (or (:message message)
                                          "Terminal input closed")))
    state)
        next-state (if (preserves-scrolled-history? message)
                     (preserve-scroll-position state next-state)
                     next-state)]
    (if (durable-state-changed? state next-state)
      (refresh-durable-cache next-state)
      next-state)))

(defn- read-escape [reader]
  (let [builder (StringBuilder.)]
    (loop [remaining 32]
      (let [n (if (pos? remaining) (.read reader 8) -2)]
        (if (or (neg? n) (zero? remaining))
          (str builder)
          (do (.append builder (char n))
              (if (or (Character/isLetter (char n)) (= \~ (char n)))
                (str builder)
                (recur (dec remaining)))))))))

(defn- read-paste [reader running?]
  (let [end "\u001b[201~" builder (StringBuilder.)]
    (loop [tail ""]
      (if-not @running?
        (str builder)
        (let [n (.read reader 100)]
          (if (neg? n)
            (recur tail)
            (let [ch (str (char n))
                  next-tail (str tail ch)]
              (.append builder ch)
              (if (str/ends-with? next-tail end)
                (subs (str builder) 0 (- (.length builder) (count end)))
                (recur (subs next-tail (max 0 (- (count next-tail)
                                                 (count end)))))))))))))

(defn mouse-wheel-key
  "Decode an SGR terminal mouse-wheel escape sequence into a transcript key."
  [sequence]
  (when-let [[_ button]
             (re-matches #"\[<(\d+);\d+;\d+[mM]" sequence)]
    (case (Long/parseLong button)
      64 :page-up
      65 :page-down
      nil)))

(defn- read-key [reader running?]
  (let [n (.read reader 100)]
    (cond
      (= -1 n) {:type :key :key :ctrl-d}
      (neg? n) nil
      (= 27 n)
      (let [sequence (read-escape reader)]
        (case sequence
          "[A" {:type :key :key :up}
          "[B" {:type :key :key :down}
          "[C" {:type :key :key :right}
          "[D" {:type :key :key :left}
          "[H" {:type :key :key :home}
          "[F" {:type :key :key :end}
          "[3~" {:type :key :key :delete}
          "[5~" {:type :key :key :page-up}
          "[6~" {:type :key :key :page-down}
          "[200~" {:type :paste :text (read-paste reader running?)}
          "" {:type :key :key :escape}
          (if-let [key (mouse-wheel-key sequence)]
            {:type :key :key key}
            (if (contains? #{"\r" "\n"} sequence)
              {:type :key :key :alt-enter}
              nil))))
      (= 3 n) {:type :key :key :ctrl-c}
      (= 4 n) {:type :key :key :ctrl-d}
      (= 10 n) {:type :key :key :enter}
      (= 14 n) {:type :key :key :ctrl-n}
      (= 15 n) {:type :key :key :ctrl-o}
      (= 19 n) {:type :key :key :ctrl-s}
      (= 20 n) {:type :key :key :ctrl-t}
      (= 9 n) {:type :key :key :tab}
      (= 13 n) {:type :key :key :enter}
      (contains? #{8 127} n) {:type :key :key :backspace}
      (< n 27) {:type :key :key (str "ctrl+" (char (+ 96 n)))}
      (< n 32) nil
      :else {:type :key :text (str (char n))})))

(defn- cursor-position [lines]
  (first
   (keep-indexed
    (fn [row line]
      (let [column (.indexOf ^String line cursor-marker)]
        (when-not (neg? column)
          {:row (inc row)
           :column (inc (visible-width (subs line 0 column)))})))
    lines)))

(defn- render-diff! [writer old-lines new-lines hardware-cursor?]
  (let [changes (keep (fn [index]
                        (let [old (get old-lines index)
                              new (get new-lines index "")]
                          (when (not= old new) [index new])))
                      (range (max (count old-lines) (count new-lines))))
        cursor (cursor-position new-lines)]
    (when (seq changes)
      (.print writer "\u001b[?2026h")
      (doseq [[index new] changes]
        (.print writer
                (str "\u001b[" (inc index) ";1H\u001b[2K"
                     (str/replace new cursor-marker "")
                     "\u001b[0m\u001b]8;;\u0007")))
      (if cursor
        (.print writer
                (str "\u001b[" (:row cursor) ";" (:column cursor) "H"
                     (if hardware-cursor? "\u001b[?25h" "\u001b[?25l")))
        (.print writer "\u001b[?25l"))
      (.print writer "\u001b[?2026l")
      (.flush writer))))

(defn- run-terminal! [ctx config queue registries active?]
  (when-not (and (terminal/tty? :stdin) (terminal/tty? :stdout))
    (throw (ex-info "TUI mode requires an interactive terminal" {})))
  (let [^Terminal terminal (-> (TerminalBuilder/builder) (.system true) (.build))
        ^Attributes original (.enterRawMode terminal)
        reader (.reader terminal)
        writer (.writer terminal)
        running? (atom true)
        state (atom (initial-state ctx config registries))
        old-lines (atom [])
        alternate? (not= :main (:screen config))
        mouse? (not= false (:mouse config))
        input-thread
        (Thread.
         (fn []
           (while @running?
             (try
               (when-let [key (read-key reader running?)]
                 (.offer ^LinkedBlockingQueue queue key))
               (catch Throwable error
                 (reset! running? false)
                 (.offer ^LinkedBlockingQueue queue
                         {:type :terminal-closed
                          :message (ex-message error)}))))))
        restored? (atom false)
        restore!
        (fn []
          (when (compare-and-set! restored? false true)
            (reset! running? false)
            (reset! active? false)
            (try
              ((:abort! (kernel/require-service ctx :agent/session)))
              (catch Throwable _ nil))
            (.interrupt input-thread)
            (try
              (.print writer
                      (str (when mouse? "\u001b[?1000l\u001b[?1006l")
                           "\u001b[?2004l\u001b[?25h\u001b[0m"
                           (if alternate? "\u001b[?1049l" "\n")))
              (.flush writer)
              (catch Throwable _ nil))
            (try (.setAttributes terminal original)
                 (catch Throwable _ nil))
            (try (.close terminal) (catch Throwable _ nil))))
        shutdown-hook (Thread. restore!)]
    (.setDaemon input-thread true)
    (reset! active? true)
    (.addShutdownHook (Runtime/getRuntime) shutdown-hook)
    (try
      (.print writer (str (when alternate? "\u001b[?1049h")
                          (when mouse? "\u001b[?1000h\u001b[?1006h")
                          "\u001b[?25l\u001b[?2004h\u001b[2J"))
      (.flush writer)
      (.start input-thread)
      (loop [first-render? true last-size nil]
        (let [width (.getWidth terminal)
              height (.getHeight terminal)
              size [width height]
              resized? (not= size last-size)
              message (.poll ^LinkedBlockingQueue queue
                             33 TimeUnit/MILLISECONDS)
              messages
              (when message
                (loop [items [message]]
                  (if-let [next-message (.poll ^LinkedBlockingQueue queue)]
                    (recur (conj items next-message))
                    items)))]
          (when resized?
            (swap! state #(refresh-durable-cache
                           (assoc % :width width :height height))))
          (doseq [next-message messages]
            (swap! state #(update-state ctx % next-message registries)))
          (when (or first-render? resized? (seq messages))
            (let [lines (render-screen @state)]
              (render-diff! writer @old-lines lines
                            (:hardware-cursor? @state))
              (reset! old-lines lines)))
          (reset! running? (and @running? (:running? @state)))
          (when @running? (recur false size))))
      @state
      (finally
        (try
          (.removeShutdownHook (Runtime/getRuntime) shutdown-hook)
          (catch IllegalStateException _ nil))
        (restore!)))))

(def plugin
  {:id :frontend/tui
   :description "Charm-style JLine TUI frontend and UI extension host."
   :requires #{:agent/session :session/store}
   :provides #{:frontend/interactive :ui/prompt :ui/extensions}
   :start
   (fn [ctx config]
     (let [queue (LinkedBlockingQueue.)
           ui-active? (atom false)
           extension-service (registry-service queue)
           registries (:registries extension-service)
           session (kernel/require-service ctx :agent/session)
           pending-state (atom ((:state session)))
           state-enqueued? (atom false)
           enqueue-state!
           (fn [state]
             (reset! pending-state state)
             (compare-and-set! state-enqueued? false true))]
       (kernel/register-service! ctx :ui/extensions extension-service)
       (kernel/register-service! ctx :ui/prompt
                                 (prompt-service queue ui-active?))
       (kernel/register-service!
        ctx :frontend/interactive
        {:run! #(run-terminal! ctx config queue registries ui-active?)})
       (kernel/on! ctx :session/event
                   (fn [_ event]
                     (.offer queue {:type :session-event :event event})))
       (kernel/on! ctx :tool.execution/update
                   (fn [_ event]
                     (.offer queue {:type :tool-update :event event})))
       (kernel/on! ctx :tool.execution/end
                   (fn [_ event]
                     (.offer queue {:type :tool-end :event event})))
       (kernel/on! ctx :queue/changed
                   (fn [_ event]
                     (.offer queue {:type :queue-update
                                    :queue (:queue event)})))
       (kernel/on! ctx :ui/run-error
                   (fn [_ event]
                     (.offer queue {:type :run-error
                                    :message (:message event)})))
       (let [dispose ((:subscribe! session)
                      (fn [event]
                        (when (= :agent/state (:type event))
                          (enqueue-state! event))))]
         (kernel/track-effect! ctx dispose))
       ;; Convert the coalescing token into the latest state without blocking
       ;; the agent callback. A tiny daemon bridge owns this internal detail.
       (let [bridge-running? (atom true)
             bridge (Thread.
                     (fn []
                       (try
                         (while @bridge-running?
                           (Thread/sleep 8)
                           (when (compare-and-set! state-enqueued? true false)
                             (.offer queue {:type :agent-state
                                            :state @pending-state})))
                         (catch InterruptedException _ nil))))]
         (.setDaemon bridge true)
         (.start bridge)
         (kernel/track-effect! ctx #(do (reset! bridge-running? false)
                                        (.interrupt bridge))))
       nil))})
