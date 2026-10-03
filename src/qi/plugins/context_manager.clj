(ns qi.plugins.context-manager
  "Token budgeting, append-only semantic compaction, and bounded fallback."
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugins.session :as session]
            [qi.tool-images :as images]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- estimate-tokens [chars-per-token image-token-budget value]
  ;; Image tokenization varies with model, resolution, and detail. This is a
  ;; configurable budgeting heuristic, not measured usage or a billing value.
  (+ (* image-token-budget (images/image-count value))
     (long (Math/ceil
            (/ (double (count (json/generate-string
                               (images/without-image-data value))))
               chars-per-token)))))

(defn- summary-source [messages max-chars]
  (let [text (str/join
              "\n"
              (map (fn [{:keys [role content tool_calls images]}]
                     (str role ": "
                          (or (images/text-only-content content)
                              (when (seq tool_calls)
                                (str "tool calls "
                                     (str/join ", "
                                               (keep #(get-in % [:function :name])
                                                     tool_calls))))
                              "[no text]")
                          (when (seq images)
                            (str " [" (count images)
                                 " tool image(s) omitted; recapture if needed.]"))))
                   messages))]
    (subs text 0 (min (count text) max-chars))))

(defn- semantic-summary!
  [llm system-prompt messages max-source-chars cancel-token provider]
  (cancellation/throw-if-cancelled! cancel-token)
  (let [source (summary-source messages max-source-chars)
        response
        (llm {:system-prompt
              (or system-prompt
                  (str "Summarize a coding-agent session faithfully. Preserve: "
                       "the user's goal, completed work, decisions, unresolved "
                       "items, files read or changed, and key tool results. "
                       "Do not invent facts. Use concise labeled sections."))
              :messages [{:role "user" :content source}]
              :tools []
              :cancel-token cancel-token
              :options (cond-> {:temperature 0}
                         provider (assoc :provider provider))})
        content (get-in response [:message :content])]
    (cancellation/throw-if-cancelled! cancel-token)
    (when (str/blank? content)
      (throw (ex-info "Semantic compactor returned an empty summary" {})))
    content))

(def plugin
  {:id :context/manager
   :description "Automatic context budget and semantic compaction provider."
   :requires #{:session/store :llm/generate}
   :provides #{:context/manager}
   :start
   (fn [ctx {:keys [context-window reserve-tokens chars-per-token
                    retain-messages max-source-chars summary-system-prompt
                    image-token-budget]
             :or {context-window 114688
                  reserve-tokens 16384
                  chars-per-token 4.0
                  image-token-budget 4096
                  retain-messages 12
                  max-source-chars 48000}}]
     (when-not (and (pos-int? context-window)
                    (pos-int? reserve-tokens)
                    (< reserve-tokens context-window)
                    (number? chars-per-token)
                    (pos? chars-per-token)
                    (pos-int? image-token-budget)
                    (pos-int? retain-messages)
                    (pos-int? max-source-chars))
       (throw (ex-info "Invalid context manager limits"
                       {:context-window context-window
                        :reserve-tokens reserve-tokens
                        :chars-per-token chars-per-token
                        :image-token-budget image-token-budget
                        :retain-messages retain-messages})))
     (let [store (kernel/require-service ctx :session/store)
           llm (kernel/require-service ctx :llm/generate)
           threshold (- context-window reserve-tokens)
           estimate! (fn
                       ([messages]
                        (estimate-tokens chars-per-token image-token-budget messages))
                       ([_model messages]
                        (estimate-tokens chars-per-token image-token-budget messages)))
           needs? (fn
                    ([messages]
                     (>= (estimate! messages) threshold))
                    ([_model messages reserve]
                     (>= (estimate! messages)
                         (- context-window (or reserve reserve-tokens)))))
           compact-body!
           (fn [{:keys [force reason cancel-token provider]}]
             (cancellation/throw-if-cancelled! cancel-token)
             (let [current ((:messages store))
                   initial (session/compaction-plan current retain-messages)
                   plan (if (and (empty? (:dropped initial))
                                 (or force (= reason :budget)))
                          ;; Keep the newest message (and its entire tool batch)
                          ;; whenever an older prefix can be summarized.
                          (let [smaller (session/compaction-plan current 1)]
                            (if (seq (:dropped smaller))
                              smaller
                              (session/compaction-plan current 0)))
                          initial)]
               (if (empty? (:dropped plan))
                 {:compacted false :reason :nothing-to-drop}
                 (let [dropped (:dropped plan)
                       semantic (when (seq dropped)
                                  (try
                                    (semantic-summary!
                                     llm summary-system-prompt dropped
                                     max-source-chars cancel-token provider)
                                    (catch Throwable error
                                      (if (:cancelled (ex-data error))
                                        (throw error)
                                        (do
                                          (kernel/emit!
                                           ctx :context/compaction-fallback
                                           {:reason reason
                                            :message (ex-message error)})
                                          nil)))))
                       _ (cancellation/throw-if-cancelled! cancel-token)
                       result
                       ((:compact! store)
                        (cond-> {:plan plan}
                          semantic (assoc :summary semantic)))]
                   (kernel/emit! ctx :context/compacted
                                 (assoc result :semantic (boolean semantic)
                                        :reason reason))
                   result))))
           compact! (fn
                      ([] (compact-body! {}))
                      ([options] (compact-body! options)))
           prepare! (fn [request]
                      (if (needs? (:messages request))
                        (do
                          (compact! {:reason :budget
                                     :cancel-token (:cancel-token request)
                                     :provider (get-in request
                                                       [:options :provider])})
                          (assoc request :messages ((:messages store))))
                        request))]
       (kernel/register-service!
        ctx :context/manager
        {:estimate! estimate!
         :needs-compaction? needs?
         :compact! compact!
         :prepare! prepare!
         :context-window context-window
         :reserve-tokens reserve-tokens
         :image-token-budget image-token-budget
         :threshold threshold}))
     nil)})
