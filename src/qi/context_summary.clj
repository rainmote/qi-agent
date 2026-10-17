(ns qi.context-summary
  "Complete, image-redacted source text and auditable compaction coverage."
  (:require [qi.tool-images :as images]
            [cheshire.core :as json]
            [clojure.string :as str])
  (:import [java.security MessageDigest]
           [java.nio.charset StandardCharsets]))

(defn source [messages]
  (str/join
   "\n"
   (map (fn [{:keys [role content tool_calls tool_call_id images]}]
          (str role ": " (or (images/text-only-content content) "[no text]")
               (when tool_call_id (str " [tool_call_id=" tool_call_id "]"))
               (when (seq tool_calls)
                 (str "\ntool_calls: " (json/generate-string
                                        (images/without-image-data tool_calls))))
               (when (seq images)
                 (str " [" (count images) " image(s) omitted; recapture if needed.]"))))
        messages)))

(defn sha256 [text]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes text StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and 0xff %)) digest))))

(defn coverage [messages text chunks]
  {:version 1 :source-format :transcript-v1
   :message-count (count messages) :source-chars (count text)
   :sha256 (sha256 text) :image-count (images/image-count messages)
   :image-policy :omitted-with-marker
   :chunks (mapv (fn [{:keys [start end]}]
                   {:start start :end end :sha256 (sha256 (subs text start end))}) chunks)})

(defn replacement [text retained]
  (into [{:role "system" :content (str "Previous conversation summary:\n" text)}] retained))

(defn protected-retain
  "Keep the latest user instruction and everything after it verbatim."
  [messages]
  (if-let [index (last (keep-indexed #(when (= "user" (:role %2)) %1) messages))]
    (- (count messages) index)
    1))
