(ns agent.plugins.session-title
  "Automatic, deterministic session titles derived from the first completed turn."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(def ^:private request-prefix
  #"(?iu)^\s*(?:请(?:你)?|麻烦(?:你)?|劳烦(?:你)?|能否|可否|可以(?:请你)?|帮我|帮忙|我想(?:请你)?|please|could you|would you|can you)\s*[，,:：-]*\s*")

(defn- content-text [content]
  (cond
    (string? content) content

    (sequential? content)
    (->> content
         (keep (fn [block]
                 (cond
                   (string? block) block
                   (map? block) (or (:text block)
                                    (when (contains? #{:image "image"}
                                                     (:type block))
                                      "图片"))
                   :else nil)))
         (str/join " "))

    (map? content) (or (:text content) (content-text (:content content)))
    :else nil))

(defn- strip-request-prefixes [value]
  (loop [current value remaining 4]
    (let [next-value (-> current
                         (str/replace #"(?iu)^\s*/(?:goal|plan)\s+" "")
                         (str/replace request-prefix ""))]
      (if (or (zero? remaining) (= current next-value))
        next-value
        (recur next-value (dec remaining))))))

(defn title-from-message
  "Create a compact title from a user message without another model request."
  ([message] (title-from-message message 36))
  ([message max-length]
   (let [source (some-> (:content message) content-text)
         candidate
         (some-> source
                 (str/replace #"(?s)```.*?```" " 代码 ")
                 (str/replace #"(?iu)https?://\S+" "链接")
                 (str/replace #"(?m)^\s*(?:#{1,6}|[-*+]\s+)" "")
                 (str/replace #"\s+" " ")
                 str/trim
                 strip-request-prefixes
                 (str/split #"[。！？!?；;\r\n]+" 2)
                 first
                 (str/replace #"^[\s，,：:、—-]+|[\s，,：:、—-]+$" "")
                 str/trim)]
     (when-not (str/blank? candidate)
       (if (<= (count candidate) max-length)
         candidate
         (str (subs candidate 0 (dec max-length)) "…"))))))

(defn- final-assistant-message? [message]
  (and (= "assistant" (some-> (:role message) name))
       (empty? (:tool_calls message))))

(defn- first-user-message [messages]
  (some #(when (= "user" (some-> (:role %) name)) %) messages))

(def plugin
  {:id :session/auto-title
   :description "Name an untitled session after its first completed turn."
   :requires #{:session/store}
   :provides #{:session/auto-title}
   :start
   (fn [ctx {:keys [enabled max-length]
             :or {enabled true max-length 36}}]
     (when-not (and (boolean? enabled)
                    (int? max-length)
                    (<= 8 max-length 80))
       (throw (ex-info "Invalid automatic session title settings"
                       {:enabled enabled :max-length max-length})))
     (let [store (kernel/require-service ctx :session/store)
           title! (fn [assistant]
                    (when (and enabled
                               (nil? ((:name store)))
                               (final-assistant-message? assistant))
                      (when-let [title (some-> ((:messages store))
                                               first-user-message
                                               (title-from-message max-length))]
                        ;; Re-check immediately before the append so a manual
                        ;; rename always wins over the automatic policy.
                        (when (nil? ((:name store)))
                          (let [event ((:name! store) title)]
                            (kernel/emit! ctx :session/event event)
                            (kernel/emit! ctx :session/auto-titled
                                          {:name title
                                           :session-id (:session-id store)
                                           :event-id (:id event)}))
                          title))))
           service {:enabled? (fn [] enabled)
                    :title-from-message #(title-from-message % max-length)
                    :title! title!}]
       (kernel/register-service! ctx :session/auto-title service)
       (kernel/on! ctx :agent.message/end
                   (fn [_ event] (title! (:message event))))
       ;; Recover old untitled sessions that already contain a complete turn.
       (when (nil? ((:name store)))
         (when-let [assistant (some #(when (final-assistant-message? %) %)
                                    (reverse ((:messages store))))]
           (title! assistant))))
     nil)})
