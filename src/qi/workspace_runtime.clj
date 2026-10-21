(ns qi.workspace-runtime
  "Pinned, symlink-free desktop workspace assets. Never selects host Python."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.security MessageDigest DigestInputStream]))

(defn- digest [path]
  (let [digest (MessageDigest/getInstance "SHA-256")]
    (with-open [stream (DigestInputStream. (io/input-stream (str path)) digest)]
      (let [buffer (byte-array 65536)]
        (loop [] (when-not (neg? (.read stream buffer)) (recur)))))
    (apply str (map #(format "%02x" (bit-and 255 %)) (.digest digest)))))

(defn- sealed-file! [root files relative]
  (when-not (and (string? relative) (not (str/starts-with? relative "/"))
                 (every? #(not (contains? #{"" "." ".."} %)) (str/split relative #"/")))
    (throw (ex-info "Invalid bundled runtime path" {})))
  (let [path (fs/path root relative)
        expected (get files relative)]
    (loop [entry path]
      (when (and entry (not= entry root))
        (when (fs/sym-link? entry) (throw (ex-info "Bundled runtime contains a symbolic link" {})))
        (recur (fs/parent entry))))
    (when-not (and (string? expected) (re-matches #"[a-f0-9]{64}" expected)
                   (fs/regular-file? path) (= expected (digest path)))
      (throw (ex-info "Bundled workspace runtime checksum is missing or changed" {:entry relative})))
    (str path)))

(defn describe
  "Resolve an explicitly packaged runtime. Missing assets remain unavailable;
  neither PATH, the current project nor a user Python installation is consulted."
  []
  (if-let [payload (System/getenv "QI_AGENT_REPOSITORY_ROOT")]
    (try
      (let [root (fs/real-path payload)
            main-path (fs/path root "runtime-manifest.json")
            _ (when (or (fs/sym-link? main-path) (> (fs/size main-path) 16000000))
                (throw (ex-info "Invalid desktop manifest" {})))
            manifest (json/parse-string (slurp (str main-path)))
            files (get manifest "files")
            workspace-manifest (sealed-file! root files "workspace/workspace-manifest.json")
            _ (when (> (fs/size workspace-manifest) 16000000) (throw (ex-info "Oversized workspace manifest" {})))
            workspace (json/parse-string (slurp workspace-manifest))
            _ (when-not (and (= 1 (get workspace "schema")) (= "aarch64-apple-darwin" (get workspace "target")))
                (throw (ex-info "Unsupported workspace runtime" {})))]
        {:available? true :root (str root)
         :python-version (get workspace "python_version")
         :python (sealed-file! root files "workspace/python/bin/python3.12")
         :node (sealed-file! root files "bin/node")
         :helper (sealed-file! root files "src/qi/terminal_helper.py")
         :pnpm (sealed-file! root files "workspace/node_modules/pnpm/bin/pnpm.cjs")
         :office (sealed-file! root files "workspace/node_modules/@deepseek-ai/libreoffice-kit/package.json")
         :office-helper (sealed-file! root files "src/qi/office_preview.mjs")
         :bin (str (fs/path root "workspace/bin"))})
      (catch Throwable _ {:available? false :reason "The pinned desktop workspace runtime is missing, unsupported or changed; no host runtime was selected."}))
    {:available? false :reason "Workspace runtimes are available only in the packaged desktop payload."}))

(defn environment [runtime root]
  (when (:available? runtime)
    {"PATH" (str (:bin runtime) ":" (fs/path (:root runtime) "bin") ":/usr/bin:/bin:/usr/sbin:/sbin")
     "PYTHONNOUSERSITE" "1" "PYTHONDONTWRITEBYTECODE" "1"
     "NPM_CONFIG_USERCONFIG" "/dev/null" "NPM_CONFIG_GLOBALCONFIG" "/dev/null"
     "NPM_CONFIG_STORE_DIR" (str (fs/path root ".qi-agent/workspace-runtime/pnpm-store"))
     "NPM_CONFIG_OFFLINE" "true" "NPM_CONFIG_IGNORE_SCRIPTS" "true"
     "PNPM_HOME" (str (fs/path root ".qi-agent/workspace-runtime/pnpm-home"))}))
