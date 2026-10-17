(ns qi.tool-images
  "Provider-neutral image attachments for tool messages and text-only summaries."
  (:require [cheshire.core :as json]
            [clojure.string :as str]))

(defn input-modalities
  "Resolve declared capabilities; :supports-images? is an explicit override."
  [config defaults]
  (let [modalities (set (map keyword (or (:input-modalities config) defaults)))]
    (if (contains? config :supports-images?)
      ((if (:supports-images? config) conj disj) modalities :image)
      modalities)))

(defn require-tool-images!
  "Fail locally before a text-only provider receives screenshot attachments."
  [config defaults provider request]
  (when (and (some #(and (= "tool" (:role %)) (seq (:images %)))
                   (:messages request))
             (not (contains? (input-modalities config defaults) :image)))
    (throw (ex-info
            (str "Provider " (name provider)
                 " does not declare image input support. Select an image-capable "
                 "model and configure :input-modalities #{:text :image} or "
                 ":supports-images? true before using screenshot tools.")
            {:provider provider :model (:model config)
             :unsupported-modality :image :retryable false}))))

(defn image-url [image]
  (let [url (or (:url image) (:image_url image))]
    (when-not (and (string? url)
                   (or (re-matches #"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}" url)
                       (re-matches #"https?://[^\s]+" url)))
      ;; Never put image bytes in exception data: the runtime persists errors.
      (throw (ex-info "Image attachment requires a supported image data URL or HTTP(S) URL"
                      {:unsupported-image true :retryable false})))
    url))

(defn content-text [content]
  (cond
    (string? content) content
    (nil? content) ""
    :else (json/generate-string content)))

(defn responses-image [image]
  (cond-> {:type "input_image" :image_url (image-url image)}
    (:detail image) (assoc :detail (:detail image))))

(defn responses-output [message]
  (let [text (content-text (:content message))]
    (if (seq (:images message))
      (into [{:type "input_text" :text text}]
            (map responses-image (:images message)))
      text)))

(defn chat-image [image]
  {:type "image_url"
   :image_url (cond-> {:url (image-url image)}
                (:detail image) (assoc :detail (:detail image)))})

(defn anthropic-image [image]
  (let [url (image-url image)]
    {:type "image"
     :source (if-let [[_ media-type data]
                      (re-matches #"data:(image/[^;]+);base64,(.+)" url)]
               {:type "base64" :media_type media-type :data data}
               {:type "url" :url url})}))

(def ^:private image-types
  #{:image "image" :image_url "image_url" :input_image "input_image"
    :computer_screenshot "computer_screenshot"})

(def ^:private omitted-image
  {:type "text" :text "[Image omitted from text summary; recapture if needed.]"})

(defn image-count [value]
  (cond
    (map? value)
    (if (contains? image-types (:type value))
      1
      (reduce-kv (fn [total key item]
                   (+ total (if (= :images key) (count item) (image-count item))))
                 0 value))
    (sequential? value) (reduce + 0 (map image-count value))
    :else 0))

(defn without-image-data
  "Retain text and image-presence markers without traversing bitmap payloads."
  [value]
  (cond
    (map? value)
    (if (contains? image-types (:type value))
      omitted-image
      (reduce-kv (fn [result key item]
                   (assoc result key
                          (if (= :images key)
                            (vec (repeat (count item) omitted-image))
                            (without-image-data item))))
                 {} value))
    (sequential? value) (mapv without-image-data value)
    :else value))

(defn text-only-content
  "Render user content for compaction without converting image bytes to text."
  [content]
  (cond
    (string? content) content
    (nil? content) nil
    (sequential? content)
    (str/join "\n" (map #(or (:text %) (content-text %))
                         (without-image-data content)))
    :else (content-text (without-image-data content))))
