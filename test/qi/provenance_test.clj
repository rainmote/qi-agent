(ns qi.provenance-test
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.test :refer [deftest is]]
            [qi.env :as env]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.provenance :as provenance]))

(deftest actual-source-sha-requires-a-clean-source-tree
  (let [root (fs/create-temp-dir {:prefix "qi-provenance-git-"})
        git! (fn [& args]
               (let [result @(process/process (into ["git" "-C" (str root)] args) {:out :string :err :string})]
                 (is (= 0 (:exit result)))))]
    (try
      (git! "init")
      (is (= "unavailable" (:source_status (provenance/source-facts root))))
      (fs/create-dirs (fs/path root "src"))
      (spit (str (fs/path root "src/code.clj")) "first")
      (git! "add" ".")
      (git! "-c" "user.name=fixture" "-c" "user.email=fixture@example.invalid" "commit" "-m" "fixture")
      (let [clean (provenance/source-facts root)]
        (is (= "clean" (:source_status clean)))
        (is (re-matches #"[a-f0-9]{40}" (:source_sha clean))))
      (spit (str (fs/path root "src/code.clj")) "changed")
      (is (= {:source_sha nil :source_status "dirty"} (provenance/source-facts root)))
      (spit (str (fs/path root "src/code.clj")) "first")
      (spit (str (fs/path root "src/extra.clj")) "untracked source")
      (is (= {:source_sha nil :source_status "dirty"} (provenance/source-facts root)))
      (finally (fs/delete-tree root)))))

(deftest entry-kind-is-explicit-and-effective-options-change-the-profile-hash
  (let [config {:plugins [{:ns 'qi.plugins.mock}]}
        facts (fn [environment profile options]
                (with-redefs [env/get #(get environment %)
                              provenance/source-root (constantly nil)]
                  (provenance/for-entry profile options)))]
    (is (= "fixture" (:sample_kind (facts {"QI_AGENT_SAMPLE_KIND" "production"} config {}))))
    (is (= "ci" (:sample_kind (facts {"CI" "true"} config {}))))
    (is (= "production" (:sample_kind (facts {} {} {}))))
    (is (= "unclassified" (:sample_kind (facts {"QI_AGENT_SAMPLE_KIND" "unclassified"} {} {}))))
    (is (not= (:profile_sha256 (facts {} config {}))
              (:profile_sha256 (facts {} config {:provider :other}))))
    (is (thrown? Exception (facts {"QI_AGENT_SAMPLE_KIND" "unknown"} config {})))))

(deftest session-source-markers-apply-only-to-new-events-and-drop-unapproved-fields
  (let [root (fs/create-temp-dir {:prefix "qi-provenance-session-"})
        file (str (fs/path root "legacy.jsonl"))
        legacy "{\"id\":\"old\",\"seq\":1,\"at\":\"2026-10-14T00:00:00Z\",\"type\":\"session/start\",\"data\":{\"session_id\":\"s\"}}\n"
        source {:sample_kind "fixture" :source_sha nil :source_status "dirty"
                :profile_sha256 (apply str (repeat 64 "a")) :secret "never persist"}]
    (try
      (spit file legacy)
      (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path file :provenance source}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)
                _ ((:append! store) "agent/run/start" {:run-id "r"})
                [old marker run] ((:events store))]
            (is (nil? (get-in old [:data :sample_kind])))
            (is (= "session/source" (:type marker)))
            (is (= "fixture" (get-in run [:data :sample_kind])))
            (is (= "s" (get-in run [:data :session_id])))
            (is (nil? (get-in marker [:data :secret]))))
          (finally (kernel/dispose-all! ctx))))
      (is (.startsWith (slurp file) legacy))
      (is (= "unclassified" (:sample_kind (provenance/sanitized nil))))
      (is (thrown? Exception (provenance/sanitized {:source_sha "not-a-hash"})))
      (finally (fs/delete-tree root)))))
