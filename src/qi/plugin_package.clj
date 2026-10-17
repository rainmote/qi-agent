(ns qi.plugin-package
  "Pinned, data-only plugin bundles. Nothing in a package becomes host code."
  (:require [babashka.process :as process]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [qi.runtime-blueprint :as blueprint]
            [qi.schema :as schema]
            [qi.plugins.web-tools :as web])
  (:import [java.io ByteArrayOutputStream PushbackReader StringReader]
           [java.net URI]
           [java.nio.file Files LinkOption]
           [java.security MessageDigest]))

(def max-bundle-bytes (* 512 1024))
(defn fail! [message data]
  (throw (ex-info message (assoc data :type :plugin-package/invalid))))
(defn sha256 [^bytes bytes]
  (apply str (map #(format "%02x" (bit-and (int %) 255))
                  (.digest (MessageDigest/getInstance "SHA-256") bytes))))
(defn id! [value]
  (when-not (and (string? value) (re-matches #"[a-z][a-z0-9-]{1,63}" value))
    (fail! "Package id must contain 2-64 lowercase letters, digits or hyphens" {}))
  value)
(defn exact! [value allowed label]
  (when-not (and (map? value) (every? allowed (keys value)))
    (fail! (str label " contains unsupported fields") {}))
  value)
(defn- text! [value limit label]
  (when-not (and (string? value) (not (str/blank? value)) (<= (count value) limit))
    (fail! (str label " must be a bounded non-empty string") {})) value)
(defn version! [value]
  (when-not (and (string? value)
                 (re-matches #"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?" value)
                 (<= (count value) 64))
    (fail! "Package versions must be exact semver values" {})) value)

(defn read-edn [source]
  (try
    (with-open [reader (PushbackReader. (StringReader. source))]
    (let [options {:eof ::eof :readers {}
                   :default (fn [_ _] (fail! "Tagged literals are not supported" {}))}
          value (edn/read options reader)]
      (when-not (= ::eof (edn/read options reader))
        (fail! "Bundle must contain exactly one EDN value" {}))
      value))
    (catch clojure.lang.ExceptionInfo error (throw error))
    (catch Throwable _ (fail! "Invalid EDN package data" {}))))

(defn- data! [value depth]
  (when (> depth 12) (fail! "UI data nesting exceeds limit" {}))
  (cond
    (or (nil? value) (boolean? value) (number? value)) value
    (string? value) (when (> (count value) 16000) (fail! "UI text exceeds limit" {}))
    (vector? value) (do (when (> (count value) 200) (fail! "UI array exceeds limit" {}))
                         (doseq [item value] (data! item (inc depth))))
    (map? value) (do (when (> (count value) 64) (fail! "UI map exceeds limit" {}))
                      (doseq [[k v] value]
                        (when-not (or (string? k) (keyword? k))
                          (fail! "UI data keys must be strings or keywords" {}))
                        (data! v (inc depth))))
    :else (fail! "UI only accepts JSON-compatible data" {}))
  value)

(def ^:private ui-types #{"text" "markdown" "metric" "table"})
(def ^:private data-schemas
  {"text" {:type "object" :additionalProperties false
           :properties {:text {:type "string" :maxLength 16000}} :required ["text"]}
   "markdown" {:type "object" :additionalProperties false
               :properties {:text {:type "string" :maxLength 16000}} :required ["text"]}
   "metric" {:type "object" :additionalProperties false
             :properties {:value {:type ["string" "number"]} :label {:type "string" :maxLength 120}
                          :unit {:type "string" :maxLength 32}}
             :required ["value" "label"]}
   "table" {:type "object" :additionalProperties false
            :properties {:columns {:type "array" :maxItems 12 :minItems 1
                                   :items {:type "string" :maxLength 120}}
                         :rows {:type "array" :maxItems 200 :items {:type "array" :maxItems 12
                                   :items {:type ["string" "number" "boolean" "null"]}}}}
            :required ["columns" "rows"]}})
(defn validate-slot! [slot]
  (exact! slot #{:id :slot :type :title :tool :data} "UI slot")
  (id! (:id slot))
  (when-not (contains? #{"panel" "tool-result"} (:slot slot))
    (fail! "UI slot must be panel or tool-result" {}))
  (when-not (contains? ui-types (:type slot)) (fail! "Unsupported UI renderer" {}))
  (text! (:title slot) 120 "UI title")
  (when (= "tool-result" (:slot slot)) (text! (:tool slot) 64 "UI tool name"))
  (data! (:data slot) 0)
  (schema/validate! (get data-schemas (:type slot)) (:data slot) "UI data does not match its renderer")
  slot)

(defn parse-bundle [bytes]
  (when (> (alength ^bytes bytes) max-bundle-bytes) (fail! "Plugin bundle exceeds 512 KiB" {}))
  (let [manifest (read-edn (String. ^bytes bytes "UTF-8"))]
    (exact! manifest #{:format :id :version :name :description :requires :blueprint :ui} "Bundle")
    (when-not (= 1 (:format manifest)) (fail! "Bundle :format must be 1" {}))
    (id! (:id manifest)) (version! (:version manifest))
    (text! (:name manifest) 120 "Package name")
    (text! (:description manifest) 500 "Package description")
    (let [dependencies (or (:requires manifest) [])
          ui (or (:ui manifest) [])]
      (when-not (and (vector? dependencies) (<= (count dependencies) 16))
        (fail! ":requires must be a vector of at most 16 exact dependencies" {}))
      (doseq [dep dependencies]
        (exact! dep #{:id :version} "Dependency")
        (id! (:id dep)) (version! (:version dep))
        (when (= (:id manifest) (:id dep)) (fail! "A package cannot depend on itself" {})))
      (when-not (= (count dependencies) (count (distinct (map :id dependencies))))
        (fail! "Duplicate package dependencies are not allowed" {}))
      (when-not (and (vector? ui) (<= (count ui) 12))
        (fail! ":ui must be a vector with at most 12 slots" {}))
      (doseq [slot ui] (validate-slot! slot))
      (when-not (= (count ui) (count (distinct (map :id ui))))
        (fail! "Duplicate UI slot ids are not allowed" {}))
      (when-not (or (:blueprint manifest) (seq ui))
        (fail! "Package must provide a Blueprint or a UI slot" {}))
      (let [compiled (when-let [source (:blueprint manifest)]
                       (when-not (string? source) (fail! ":blueprint must be an EDN string" {}))
                       (blueprint/parse-blueprint source))]
        (when (some #(and (= "tool-result" (:slot %))
                         (not (some #{(:tool %)} (map :name (:tools compiled))))) ui)
          (fail! "Tool-result slots may only target this package's Blueprint tools" {}))
        {:manifest (assoc manifest :requires dependencies :ui ui)
         :compiled compiled :sha256 (sha256 bytes) :bytes bytes}))))

(defn assert-no-symlinks! [file]
  (loop [path (.toPath (.getAbsoluteFile (io/file (str file))))]
    (when path
      (when (Files/isSymbolicLink path) (fail! "Symbolic links are not allowed in package paths" {}))
      (recur (.getParent path))))
  file)
(defn- bounded-read
  ([stream] (bounded-read stream max-bundle-bytes))
  ([stream limit]
  (with-open [input stream output (ByteArrayOutputStream.)]
    (let [buffer (byte-array 8192)]
      (loop [total 0]
        (let [n (.read input buffer)]
          (if (= -1 n) (.toByteArray output)
              (let [total (+ total n)]
                (when (> total limit) (fail! "Plugin bundle exceeds 512 KiB" {}))
                (.write output buffer 0 n)
                (recur total)))))))))
(defn local-bundle [path]
  (assert-no-symlinks! path)
  (when-not (.isFile (io/file path)) (fail! "Bundle path must name a regular file" {}))
  (bounded-read (io/input-stream path)))
(defn- remote-target! [source]
  (let [uri (URI. source)]
    (when-not (and (= "https" (.getScheme uri)) (= -1 (.getPort uri)))
      (fail! "Remote packages require standard HTTPS without custom ports" {}))
    ;; Use the same canonical-host and all-address checks as the public web
    ;; transport. Pin the returned address instead of resolving twice.
    (let [lookup (future (try (web/resolve-public-url source) (catch Throwable error error)))]
      (try
        (let [target (deref lookup 10000 ::timeout)]
          (when (= target ::timeout) (fail! "Package hostname lookup timed out" {}))
          (when (instance? Throwable target) (throw target))
          target)
        (finally (when-not (realized? lookup) (future-cancel lookup)))))))
(defn- https-bundle [source]
  (let [{:keys [host port address]} (remote-target! source)
        address (if (str/includes? address ":") (str "[" address "]") address)
        running (process/process
                 ["/usr/bin/curl" "-q" "--silent" "--show-error" "--globoff"
                  "--proxy" "" "--noproxy" "*" "--proto" "=https"
                  "--max-redirs" "0" "--max-time" "15" "--connect-timeout" "10"
                  "--max-filesize" (str max-bundle-bytes)
                  "--resolve" (str host ":" port ":" address)
                  "--write-out" "\n%{http_code}" "--url" source]
                 {:err :discard :env {"PATH" "/usr/bin:/bin"} :shutdown process/destroy-tree})
        reading (future (try (bounded-read (:out running) (+ 4 max-bundle-bytes))
                             (catch Throwable error (process/destroy-tree running) error)))]
    (try
      (let [result (deref running 20000 ::timeout)]
        (when (= result ::timeout) (fail! "Package download timed out" {}))
        (when-not (zero? (:exit result)) (fail! "Package download failed" {:exit (:exit result)}))
        (let [bytes (deref reading 1000 ::timeout)]
          (when (instance? Throwable bytes) (throw bytes))
          (when (= bytes ::timeout) (fail! "Package download did not finish" {}))
          (let [length (alength ^bytes bytes) body-length (- length 4)]
            (when-not (and (>= length 4) (= "\n200" (String. ^bytes bytes body-length 4 "US-ASCII")))
              (fail! "Package response must be HTTP 200; redirects are not followed" {}))
            (let [body (byte-array body-length)]
              (System/arraycopy bytes 0 body 0 body-length)
              body))))
      (finally (process/destroy-tree running) (future-cancel reading)))))
(defn- delete-tree! [root]
  (when (.exists (io/file root))
    (with-open [entries (Files/walk (.toPath (io/file root))
                                   (make-array java.nio.file.FileVisitOption 0))]
      (doseq [path (reverse (vec (iterator-seq (.iterator entries))))]
        (Files/deleteIfExists path)))))
(defn- git-bundle [source commit path]
  (when-not (and (string? commit) (re-matches #"[a-f0-9]{40}(?:[a-f0-9]{24})?" commit))
    (fail! "Git source requires an immutable full commit hash" {}))
  (when-not (and (string? path) (re-matches #"[a-zA-Z0-9_./-]+\.edn" path)
                 (not (str/starts-with? path "/"))
                 (not-any? #{".." "." ""} (str/split path #"/")))
    (fail! "Git package path must be a safe relative .edn file" {}))
  (let [url (subs source 4) target (remote-target! url)
        address (:address target)
        pin (str (:host target) ":" (:port target) ":"
                 (if (str/includes? address ":") (str "[" address "]") address))
        directory (Files/createTempDirectory "qi-plugin-git-" (make-array java.nio.file.attribute.FileAttribute 0))
        run (fn [& args]
              (let [running (process/process
                             (vec (concat ["/usr/bin/git" "-c" "core.hooksPath=/dev/null"
                                           "-c" "credential.helper=" "-c" "http.followRedirects=false"
                                           "-c" "http.proxy=" "-c" (str "http.curloptResolve=" pin)
                                           "-c" "protocol.file.allow=never" "-c" "protocol.ext.allow=never"] args))
                             {:dir (str directory) :out :string :err :discard
                              :shutdown process/destroy-tree
                              :env {"PATH" "/usr/bin:/bin" "GIT_CONFIG_NOSYSTEM" "1"
                                    "GIT_CONFIG_GLOBAL" "/dev/null" "GIT_TERMINAL_PROMPT" "0"
                                    "GIT_CONFIG_COUNT" "0"}})
                    result (deref running 30000 ::timeout)]
                (when (= ::timeout result)
                  (process/destroy-tree running)
                  (fail! "Pinned Git package read timed out" {}))
                (when-not (zero? (:exit result))
                  (fail! "Pinned Git package read failed" {:exit (:exit result)}))
                (:out result)))]
    (try
      (run "init" "--quiet")
      (run "fetch" "--quiet" "--no-tags" "--depth=1" "--" url commit)
      (when-not (= commit (str/trim (run "rev-parse" "FETCH_HEAD")))
        (fail! "Fetched Git commit did not match requested pin" {}))
      (let [size (Long/parseLong (str/trim (run "cat-file" "-s" (str commit ":" path))))]
        (when (> size max-bundle-bytes) (fail! "Git bundle exceeds 512 KiB" {})))
      (.getBytes ^String (run "show" (str commit ":" path)) "UTF-8")
      (finally (delete-tree! (str directory))))))

(defn read-source [{:keys [source sha256 commit path]}]
  (text! source 4096 "Package source")
  (when (and sha256 (not (re-matches #"[a-f0-9]{64}" sha256)))
    (fail! "sha256 must be 64 lowercase hexadecimal characters" {}))
  (let [git? (str/starts-with? source "git+https://")
        remote? (or (str/starts-with? source "https://") git?)]
    (when (and (not git?) (or commit path))
      (fail! "commit/path only apply to Git package sources" {}))
    (when (and remote? (nil? sha256)) (fail! "Remote package sources require a SHA-256 pin" {}))
    (when (and (not remote?) (re-find #"^[a-zA-Z][a-zA-Z0-9+.-]*:" source))
      (fail! "Unsupported package source scheme" {}))
    (let [bytes (cond (str/starts-with? source "git+https://") (git-bundle source commit path)
                      remote? (https-bundle source)
                      :else (local-bundle source))
          result (parse-bundle bytes)]
      (when (and sha256 (not= sha256 (:sha256 result)))
        (fail! "Package SHA-256 integrity check failed" {}))
      (assoc result :source (cond-> {:location source :kind (cond commit "git" remote? "https" :else "local")}
                             commit (assoc :commit commit :path path))))))
