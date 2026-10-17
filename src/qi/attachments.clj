(ns qi.attachments
  "Resolve workspace-bound upload references only at the final model boundary."
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.schema :as schema])
  (:import [java.nio.file Files LinkOption OpenOption StandardOpenOption]
           [java.nio.file.attribute PosixFilePermission]
           [java.security MessageDigest]
           [java.util Base64]))

(def max-bytes (* 8 1024 1024))
(def content-schema
  {:anyOf [{:type "string" :minLength 1 :maxLength 1048576}
           {:type "array" :minItems 1 :maxItems 9
            :items {:anyOf [{:type "object" :additionalProperties false
                             :properties {"type" {:const "text"} "text" {:type "string" :maxLength 1048576}}
                             :required ["type" "text"]}
                            {:type "object" :additionalProperties false
                             :properties {"type" {:const "attachment"}
                                          "id" {:type "string" :pattern "^[A-Za-z0-9_-]{8,128}$"}
                                          "name" {:type "string" :maxLength 180}
                                          "mime" {:type "string" :maxLength 100}
                                          "size" {:type "integer" :minimum 1 :maximum max-bytes}
                                          "workspaceId" {:type "string" :pattern "^[a-f0-9]{16}$"}}
                             :required ["type" "id" "name" "mime" "size" "workspaceId"]}]}}]})

(defn validate-content! [content]
  (schema/validate! content-schema content)
  (when (or (and (string? content) (str/blank? content))
            (and (sequential? content)
                 (every? #(and (= "text" (name (:type %))) (str/blank? (:text %))) content)))
    (throw (ex-info "Message must not be blank" {})))
  content)

(defn- digest [bytes]
  (apply str (map #(format "%02x" (bit-and (int %) 255))
                  (.digest (MessageDigest/getInstance "SHA-256") bytes))))

(defn- owner-only! [path]
  (when (Files/isSymbolicLink path)
    (throw (ex-info "Attachment store cannot contain symbolic links" {:retryable false})))
  (try
    (let [permissions (Files/getPosixFilePermissions path (make-array LinkOption 0))]
      (when (some #(contains? permissions %)
                  [PosixFilePermission/GROUP_READ PosixFilePermission/GROUP_WRITE
                   PosixFilePermission/GROUP_EXECUTE PosixFilePermission/OTHERS_READ
                   PosixFilePermission/OTHERS_WRITE PosixFilePermission/OTHERS_EXECUTE])
        (throw (ex-info "Attachment store must be owner-only" {:retryable false}))))
    (catch UnsupportedOperationException _ nil)))

(defn- read-private [directory filename limit]
  (let [root (.toPath (io/file directory))
        path (.resolve root filename)]
    (owner-only! root)
    (owner-only! path)
    (when-not (Files/isRegularFile path (into-array LinkOption [LinkOption/NOFOLLOW_LINKS]))
      (throw (ex-info "Attachment is not a regular file" {:retryable false})))
    (when (> (Files/size path) limit)
      (throw (ex-info "Attachment exceeds its read limit" {:retryable false})))
    (with-open [stream (Files/newInputStream path (into-array OpenOption [StandardOpenOption/READ LinkOption/NOFOLLOW_LINKS]))]
      (let [bytes (.readNBytes stream (int (inc limit)))]
        (when (> (alength bytes) limit)
          (throw (ex-info "Attachment grew beyond its read limit" {:retryable false})))
        bytes))))

(defn resolve-reference
  "Resolve an uploaded ID against an explicit canonical workspace and private store.
  The returned data must not be persisted in the session log."
  [directory workspace block]
  (let [id (:id block)]
    (when-not (and (string? id) (re-matches #"[A-Za-z0-9_-]{8,128}" id))
      (throw (ex-info "Invalid attachment identifier" {:retryable false})))
    (let [metadata (json/parse-string (String. (read-private directory (str id ".json") 4096) "UTF-8") true)
          root (.getAbsolutePath (io/file workspace))
          expected-id (subs (digest (.getBytes root "UTF-8")) 0 16)]
      (when-not (= root (.getCanonicalPath (io/file workspace)))
        (throw (ex-info "Workspace root changed; attachment access refused" {:retryable false})))
      (when-not (and (= root (:workspacePath metadata))
                     (= expected-id (:workspaceId metadata) (:workspaceId block))
                     (= id (:id metadata)))
        (throw (ex-info "Attachment does not belong to this workspace" {:retryable false})))
      (let [bytes (read-private directory (str id ".bin") max-bytes)
            mime (:mime metadata)]
        (when-not (and (= (alength bytes) (:size metadata)) (= (digest bytes) (:sha256 metadata)))
          (throw (ex-info "Attachment integrity check failed" {:retryable false})))
        (if (contains? #{"image/png" "image/jpeg" "image/gif" "image/webp"} mime)
          {:type "image" :url (str "data:" mime ";base64," (.encodeToString (Base64/getEncoder) bytes))}
          {:type "text"
           :text (str "[Uploaded file: " (:name metadata) ", " (alength bytes) " bytes, " mime "]\n"
                      (if (and (<= (alength bytes) (* 256 1024))
                               (or (str/starts-with? mime "text/") (= mime "application/json")))
                        (String. bytes "UTF-8")
                        "Binary contents are not extracted for this model. The user can preview or download the original file; do not claim to have read its contents."))})))))

(defn resolve-request
  "Replace only uploaded user references in a transient model request."
  [ctx request]
  (let [world (kernel/service ctx :execution/world)
        directory (or (qenv/get "QI_AGENT_ATTACHMENT_DIR") (str (io/file (qenv/home) "attachments")))]
    (update request :messages
            (fn [messages]
              (mapv (fn [message]
                      (if (and (= "user" (:role message)) (sequential? (:content message)))
                        (update message :content
                                (fn [blocks]
                                  (mapv (fn [block]
                                          (if (= "attachment" (some-> (:type block) name))
                                            (do
                                              (when-not (:root world)
                                                (throw (ex-info "Uploaded files require a workspace execution root" {:retryable false})))
                                              (resolve-reference directory (:root world) block))
                                            block)) blocks)))
                        message)) messages)))))

(defn validate-user-content!
  "Validate references before queuing a durable message; return the original IDs."
  [ctx content]
  (validate-content! content)
  (when (sequential? content)
    (resolve-request ctx {:messages [{:role "user" :content content}]}))
  content)
