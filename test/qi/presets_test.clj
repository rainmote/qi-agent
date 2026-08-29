(ns qi.presets-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing]]))

(defn- delete-tree! [directory]
  (when (.exists (io/file directory))
    (doseq [file (reverse (file-seq (io/file directory)))]
      (.delete file))))

(defn- api-fn [symbol]
  (try
    (requiring-resolve symbol)
    (catch Throwable _ nil)))

(defn- write-preset! [root id metadata config]
  (let [directory (io/file root id)]
    (.mkdirs directory)
    (spit (io/file directory "preset.edn") metadata)
    (when config
      (spit (io/file directory "agent.edn") config))
    directory))

(deftest registry-discovers-system-and-user-presets
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)]
    (if (and create-registry list-presets)
      (let [root (.toFile (java.nio.file.Files/createTempDirectory
                           "qi-agent-presets-"
                           (make-array java.nio.file.attribute.FileAttribute 0)))
            system-root (io/file root "system")
            user-root (io/file root "user")]
        (try
          (write-preset! system-root "standard"
                         (pr-str {:name "Standard" :description "Built in" :order 1})
                         "{:plugins []}")
          (write-preset! user-root "my-debug"
                         (pr-str {:name "My Debug" :description "Local preset"})
                         "{:plugins []}")
          (let [registry (create-registry
                          {:system-roots [(str system-root)]
                           :user-root (str user-root)})
                presets (list-presets registry)]
            (is (= ["standard" "my-debug"] (mapv :id presets)))
            (is (= [:system :user] (mapv :trust presets)))
            (is (every? #(string? (:config-path %)) presets))
            (is (every? #(nil? (:broken %)) presets)))
          (finally
            (delete-tree! root))))
      (is false "qi.presets registry API is not implemented"))))

(deftest registry-keeps-broken-user-presets-visible-and-system-ids-win
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)]
    (if (and create-registry list-presets)
      (let [root (.toFile (java.nio.file.Files/createTempDirectory
                           "qi-agent-presets-broken-"
                           (make-array java.nio.file.attribute.FileAttribute 0)))
            system-root (io/file root "system")
            user-root (io/file root "user")]
        (try
          (write-preset! system-root "standard" "{:name \"System\"}" "{:plugins []}")
          (write-preset! user-root "standard" "{:name \"Shadow\"}" "{:plugins []}")
          (write-preset! user-root "broken" "{:name \"Broken\"}" nil)
          (write-preset! user-root "bad-edn" "{:name \"Bad EDN\"}" "{:plugins [")
          (write-preset! user-root "oversized" (apply str (repeat 65537 "x")) "{:plugins []}")
          (write-preset! user-root "../invalid" "{:name \"Invalid\"}" "{:plugins []}")
          (let [presets (list-presets
                         (create-registry {:system-roots [(str system-root)]
                                           :user-root (str user-root)}))]
            (is (= ["standard" "bad-edn" "broken" "oversized"] (mapv :id presets)))
            (is (= "System" (:name (first presets))))
            (is (= :system (:trust (first presets))))
            (is (string? (:broken (second presets))))
            (is (= "agent.edn is missing" (:broken (nth presets 2))))
            (is (= "preset.edn is too large" (:broken (nth presets 3)))))
          (finally
            (delete-tree! root))))
      (is false "qi.presets registry API is not implemented"))))

(deftest registry-keeps-invalid-metadata-visible-without-crashing-sort
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-metadata" (make-array java.nio.file.attribute.FileAttribute 0)))
        user-root (io/file root "user")]
    (try
      (write-preset! user-root "bad-meta" "{:name 42 :order \"first\"}" "{:plugins []}")
      (let [preset (first (list-presets
                           (create-registry {:user-root (str user-root)})))]
        (is (= "bad-meta" (:id preset)))
        (is (= "bad-meta" (:name preset)))
        (is (= "preset.edn :name must be a non-blank string"
               (:broken preset))))
      (finally
        (delete-tree! root)))))

(deftest registry-ignores-symbolic-link-aliases
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-presets-symlink" (make-array java.nio.file.attribute.FileAttribute 0)))
        user-root (io/file root "user")]
    (try
      (write-preset! user-root "real" "{:name \"Real\"}" "{:plugins []}")
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file user-root "alias"))
       (.toPath (io/file user-root "real"))
       (make-array java.nio.file.attribute.FileAttribute 0))
      (is (= ["real"]
             (mapv :id (list-presets
                        (create-registry {:user-root (str user-root)})))))
      (finally
        (delete-tree! root)))))

(deftest registry-reports-symbolic-link-config-as-broken
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-config-symlink" (make-array java.nio.file.attribute.FileAttribute 0)))
        user-root (io/file root "user")
        outside (io/file root "outside-agent.edn")]
    (try
      (write-preset! user-root "linked" "{:name \"Linked\"}" nil)
      (spit outside "{:plugins []}")
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file user-root "linked" "agent.edn"))
       (.toPath outside)
       (make-array java.nio.file.attribute.FileAttribute 0))
      (is (= "agent.edn must be a regular non-symbolic-link file"
             (:broken (first (list-presets
                              (create-registry {:user-root (str user-root)}))))))
      (finally
        (delete-tree! root)))))

(deftest registry-resolves-and-reads-only-healthy-known-presets
  (let [create-registry (api-fn 'qi.presets/create-registry)
        resolve-preset (api-fn 'qi.presets/resolve-preset)
        read-preset (api-fn 'qi.presets/read-preset)]
    (if (and create-registry resolve-preset read-preset)
      (let [root (.toFile (java.nio.file.Files/createTempDirectory
                           "qi-agent-presets-resolve-"
                           (make-array java.nio.file.attribute.FileAttribute 0)))
            user-root (io/file root "user")]
        (try
          (write-preset! user-root "working" "{:name \"Working\"}"
                         "{:plugins [{:ns qi.plugins.session}]}")
          (write-preset! user-root "broken" "{:name \"Broken\"}" nil)
          (let [registry (create-registry {:user-root (str user-root)})]
            (is (= "working" (:id (resolve-preset registry "working"))))
            (is (= {:plugins [{:ns 'qi.plugins.session}]}
                   (read-preset registry "working")))
            (is (= :unknown-preset
                   (:type (ex-data
                           (try (resolve-preset registry "missing")
                                (catch clojure.lang.ExceptionInfo error error))))))
            (is (= :broken-preset
                   (:type (ex-data
                           (try (resolve-preset registry "broken")
                                (catch clojure.lang.ExceptionInfo error error)))))))
          (finally
            (delete-tree! root))))
      (is false "preset resolve/read API is not implemented"))))

(deftest materialization-returns-a-validated-immutable-config-value
  (let [create-registry (api-fn 'qi.presets/create-registry)
        materialize-preset (api-fn 'qi.presets/materialize-preset)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-presets-materialize-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        user-root (io/file root "user")]
    (try
      (write-preset! user-root "working" "{:name \"Working\"}" "{:plugins []}")
      (let [registry (create-registry {:user-root (str user-root)})
            result (materialize-preset registry "working")]
        (is (= "working" (:id result)))
        (is (= {:plugins []} (edn/read-string (:config result))))
        (spit (io/file user-root "working" "agent.edn") "{:plugins [false]}")
        (is (= :preset-validation-failed
               (:type (ex-data
                       (try (materialize-preset registry "working")
                            (catch clojure.lang.ExceptionInfo error error)))))))
      (finally
        (delete-tree! root)))))

(deftest registry-copies-whole-presets-and-deletes-only-user-copies
  (let [create-registry (api-fn 'qi.presets/create-registry)
        copy-preset! (api-fn 'qi.presets/copy-preset!)
        delete-preset! (api-fn 'qi.presets/delete-preset!)
        list-presets (api-fn 'qi.presets/list-presets)]
    (if (every? some? [create-registry copy-preset! delete-preset! list-presets])
      (let [root (.toFile (java.nio.file.Files/createTempDirectory
                           "qi-agent-presets-copy-"
                           (make-array java.nio.file.attribute.FileAttribute 0)))
            system-root (io/file root "system")
            user-root (io/file root "user")
            source (write-preset! system-root "standard"
                                  "{:name \"Standard\" :description \"Base\" :order 1 :id \"forged\" :trust :system :directory \"/tmp/forged\" :config-path \"/tmp/forged.edn\"}"
                                  "{:plugins []}")]
        (try
          (.mkdirs (io/file source "skills" "example"))
          (spit (io/file source "skills" "example" "SKILL.md") "reference")
          (let [registry (create-registry {:system-roots [(str system-root)]
                                           :user-root (str user-root)})
                copied (copy-preset! registry "standard" "my-agent" "My Agent")]
            (is (= "my-agent" (:id copied)))
            (is (= :user (:trust copied)))
            (is (= "reference"
                   (slurp (io/file user-root "my-agent" "skills" "example" "SKILL.md"))))
            (is (= {:name "My Agent" :description "Base"}
                   (read-string (slurp (io/file user-root "my-agent" "preset.edn")))))
            (is (= :preset-exists
                   (:type (ex-data
                           (try (copy-preset! registry "standard" "my-agent" nil)
                                (catch clojure.lang.ExceptionInfo error error))))))
            (is (= :user
                   (:trust (copy-preset! registry "my-agent" "second-copy" nil))))
            (is (= :system-preset-read-only
                   (:type (ex-data
                           (try (delete-preset! registry "standard")
                                (catch clojure.lang.ExceptionInfo error error))))))
            (is (true? (delete-preset! registry "my-agent")))
            (is (true? (delete-preset! registry "second-copy")))
            (is (= ["standard"] (mapv :id (list-presets registry)))))
          (finally
            (delete-tree! root))))
      (is false "preset copy/delete API is not implemented"))))

(deftest registry-updates-only-user-presets-after-validating-the-complete-candidate
  (let [create-registry (api-fn 'qi.presets/create-registry)
        copy-preset! (api-fn 'qi.presets/copy-preset!)
        read-source (api-fn 'qi.presets/read-preset-source)
        update-preset! (api-fn 'qi.presets/update-preset!)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-presets-update-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        system-root (io/file root "system")
        user-root (io/file root "user")]
    (try
      (write-preset! system-root "standard"
                     "{:name \"Standard\" :description \"Base\"}"
                     "{:plugins []}")
      (let [registry (create-registry {:system-roots [(str system-root)]
                                       :user-root (str user-root)})]
        (copy-preset! registry "standard" "mine" "Mine")
        (is (= :system-preset-read-only
               (:type (ex-data
                       (try (update-preset! registry "standard" {:name "Nope"})
                            (catch clojure.lang.ExceptionInfo error error))))))
        (let [before (:config (read-source registry "mine"))]
          (is (= :preset-validation-failed
                 (:type (ex-data
                         (try (update-preset! registry "mine"
                                              {:config "{:plugins [false]}"})
                              (catch clojure.lang.ExceptionInfo error error))))))
          (is (= before (:config (read-source registry "mine")))))
        (let [result (update-preset!
                      registry "mine"
                      {:name "My Agent"
                       :description "Custom"
                       :config "{:plugins [{:ns qi.plugins.session :config {:ephemeral true}}]}"})
              source (read-source registry "mine")]
          (is (= "mine" (:id result)))
          (is (= :structural (get-in result [:validation :mode])))
          (is (= {:name "My Agent" :description "Custom"}
                 (:metadata source)))
          (is (= {:plugins [{:ns 'qi.plugins.session
                             :config {:ephemeral true}}]}
                 (edn/read-string (:config source))))))
      (finally
        (delete-tree! root)))))

(deftest creator-preset-tools-close-the-authoring-loop
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-author-tools-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        system-root (io/file root "system")
        user-root (io/file root "user")]
    (try
      (write-preset! system-root "standard" "{:name \"Standard\"}"
                     "{:plugins []}")
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'qi.plugins.presets
                    :config {:system-roots [(str system-root)]
                             :user-root (str user-root)}}
                   {:ns 'qi.plugins.preset-author}]})]
        (try
          (let [guide (:execute (kernel/tool ctx "preset_guide"))
                inspect (:execute (kernel/tool ctx "preset_inspect"))
                author (:execute (kernel/tool ctx "preset_author"))]
            (is (seq (:workflow (guide {} {}))))
            (is (= ["standard"]
                   (mapv :id (:presets (inspect {:action "list"} {})))))
            (is (= "mine"
                   (:id (author {:action "copy" :from "standard"
                                 :id "mine" :name "Mine"} {}))))
            (is (= :structural
                   (get-in (author {:action "update" :id "mine"
                                    :description "Ready"
                                    :config "{:plugins []}"} {})
                           [:validation :mode])))
            (is (= "Ready"
                   (get-in (inspect {:action "read" :id "mine"} {})
                           [:metadata :description])))
            (is (true? (:deleted
                        (author {:action "delete" :id "mine"} {})))))
          (finally
            (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! root)))))

(deftest registry-validates-a-preset-by-booting-and-disposing-it
  (let [create-registry (api-fn 'qi.presets/create-registry)
        validate-preset! (api-fn 'qi.presets/validate-preset!)]
    (if (and create-registry validate-preset!)
      (let [root (.toFile (java.nio.file.Files/createTempDirectory
                           "qi-agent-presets-validate-"
                           (make-array java.nio.file.attribute.FileAttribute 0)))
            user-root (io/file root "user")]
        (try
          (write-preset! user-root "valid" "{:name \"Valid\"}"
                         "{:plugins [{:ns qi.plugins.session :config {:ephemeral true}}]}")
          (write-preset! user-root "invalid" "{:name \"Invalid\"}"
                         "{:plugins [{:ns missing.plugin}]}")
          (let [registry (create-registry {:user-root (str user-root)})
                result (validate-preset! registry "valid" {:mount? true})]
            (is (true? (:valid result)))
            (is (= :mount (:mode result)))
            (is (= [:session/append-only] (:plugins result)))
            (is (= :preset-validation-failed
                   (:type (ex-data
                           (try (validate-preset! registry "invalid" {:mount? true})
                                (catch clojure.lang.ExceptionInfo error error)))))))
          (finally
            (delete-tree! root))))
      (is false "preset validation API is not implemented"))))

(deftest preset-validation-is-structural-by-default
  (let [create-registry (api-fn 'qi.presets/create-registry)
        validate-preset! (api-fn 'qi.presets/validate-preset!)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-safe-validation" (make-array java.nio.file.attribute.FileAttribute 0)))
        system-root (io/file root "system")
        starts (atom 0)
        fixture-ns 'qi.presets-validation-fixture]
    (try
      (let [namespace (create-ns fixture-ns)]
        (intern namespace 'plugin
                {:id :test/safe-validation
                 :requires #{}
                 :provides #{}
                 :start (fn [_ _] (swap! starts inc) nil)}))
      (write-preset! system-root "safe" "{:name \"Safe\"}"
                     "{:plugins [{:ns qi.presets-validation-fixture}]}")
      (let [result (validate-preset!
                    (create-registry {:system-roots [(str system-root)]}) "safe")]
        (is (:valid result))
        (is (= :structural (:mode result)))
        (is (= [:test/safe-validation] (:plugins result)))
        (is (zero? @starts)))
      (finally
        (remove-ns fixture-ns)
        (delete-tree! root)))))

(deftest structural-validation-rejects-falsey-specs-and-non-map-config
  (let [create-registry (api-fn 'qi.presets/create-registry)
        validate-preset! (api-fn 'qi.presets/validate-preset!)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-structure" (make-array java.nio.file.attribute.FileAttribute 0)))
        user-root (io/file root "user")]
    (try
      (write-preset! user-root "nil-first" "{}"
                     "{:plugins [nil {:ns qi.plugins.session}]}")
      (write-preset! user-root "false-first" "{}"
                     "{:plugins [false {:ns qi.plugins.session}]}")
      (write-preset! user-root "bad-config" "{}"
                     "{:plugins [{:ns qi.plugins.session :config \"bad\"}]}")
      (let [registry (create-registry {:user-root (str user-root)})]
        (doseq [id ["nil-first" "false-first" "bad-config"]]
          (is (= :preset-validation-failed
                 (:type (ex-data
                         (try (validate-preset! registry id)
                              (catch clojure.lang.ExceptionInfo error error)))))))
        (is (= :preset-validation-failed
               (:type (ex-data
                       (try (validate-preset! registry "bad-config" {:mount? true})
                            (catch clojure.lang.ExceptionInfo error error)))))))
      (finally
        (delete-tree! root)))))

(deftest copy-preset-rejects-excessive-empty-directories
  (let [create-registry (api-fn 'qi.presets/create-registry)
        copy-preset! (api-fn 'qi.presets/copy-preset!)
        root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-preset-copy-limit" (make-array java.nio.file.attribute.FileAttribute 0)))
        system-root (io/file root "system")
        user-root (io/file root "user")]
    (try
      (write-preset! system-root "standard" "{:name \"Standard\"}" "{:plugins []}")
      (doseq [index (range 513)]
        (.mkdirs (io/file system-root "standard" "skills" (str index))))
      (let [error (try
                    (copy-preset! (create-registry {:system-roots [(str system-root)]
                                                    :user-root (str user-root)})
                                  "standard" "copy")
                    nil
                    (catch clojure.lang.ExceptionInfo error error))]
        (is (= :preset-copy-limit (:type (ex-data error))))
        (is (not (.exists (io/file user-root "copy")))))
      (finally
        (delete-tree! root)))))

(deftest shipped-creator-preset-is-a-standard-superset
  (let [create-registry (api-fn 'qi.presets/create-registry)
        list-presets (api-fn 'qi.presets/list-presets)
        read-preset (api-fn 'qi.presets/read-preset)
        validate-preset! (api-fn 'qi.presets/validate-preset!)
        registry (create-registry {:system-roots [(str (io/file "presets"))]
                                   :user-root (str (io/file "target" "missing-user-presets"))})
        listed (list-presets registry)
        standard (read-preset registry "standard")
        creator (read-preset registry "creator")
        standard-ns (mapv :ns (:plugins standard))
        creator-ns (mapv :ns (:plugins creator))
        creator-resources (some #(when (= 'qi.plugins.resources (:ns %)) %)
                                (:plugins creator))
        creator-lab (some #(when (= 'qi.plugins.runtime-lab (:ns %)) %)
                          (:plugins creator))
        creator-runtime (some #(when (= 'qi.plugins.runtime (:ns %)) %)
                              (:plugins creator))]
    (is (= ["standard" "creator"] (mapv :id listed)))
    (is (every? nil? (map :broken listed)))
    (is (= (into (set standard-ns)
                 ['qi.plugins.runtime-inspect 'qi.plugins.runtime-lab
                  'qi.plugins.preset-author])
           (set creator-ns)))
    (is (= (+ 3 (count standard-ns)) (count creator-ns)))
    (is (= 1 (count (filter #{'qi.plugins.runtime-inspect} creator-ns))))
    (is (= 1 (count (filter #{'qi.plugins.runtime-lab} creator-ns))))
    (is (= 1 (count (filter #{'qi.plugins.preset-author} creator-ns))))
    (is (= ["presets/creator/skills"]
           (get-in creator-resources [:config :skills :bundled-directories])))
    (is (.isFile (io/file "presets" "creator" "skills"
                          "creating-agent-presets" "SKILL.md")))
    (is (.isFile (io/file "presets" "creator" "skills"
                          "creating-runtime-blueprints" "SKILL.md")))
    (is (true? (get-in creator-lab [:config :blueprints :enabled])))
    (is (re-find #"runtime_inspect"
                 (get-in creator-runtime [:config :append-system-prompt])))
    (is (re-find #"runtime_plugin"
                 (get-in creator-runtime [:config :append-system-prompt])))
    (is (re-find #"creating-runtime-blueprints"
                 (get-in creator-runtime [:config :append-system-prompt])))
    (is (re-find #"preset_guide"
                 (get-in creator-runtime [:config :append-system-prompt])))
    (is (= {:valid true :mode :structural :id "creator"}
           (select-keys (validate-preset! registry "creator")
                        [:valid :mode :id])))))

(deftest preset-service-publishes-reversible-registry-api
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "qi-agent-presets-plugin-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        system-root (io/file root "system")
        user-root (io/file root "user")]
    (try
      (write-preset! system-root "standard" "{:name \"Standard\"}" "{:plugins []}")
      (try
        (require 'qi.plugins.presets)
        (let [ctx (plugin/boot!
                   {:plugins [{:ns 'qi.plugins.presets
                               :config {:system-roots [(str system-root)]
                                        :user-root (str user-root)}}]})]
          (try
            (let [service (kernel/require-service ctx :agent/presets)]
              (is (= ["standard"] (mapv :id ((:list service)))))
              (is (= "standard" (:id ((:resolve service) "standard"))))
              (is (= :structural (:mode ((:validate! service) "standard"))))
              (is (= :mount (:mode ((:validate! service) "standard" {:mount? true})))))
            (finally
              (kernel/dispose-all! ctx)))
          (is (nil? (kernel/service ctx :agent/presets))))
        (catch java.io.FileNotFoundException _
          (is false "qi.plugins.presets is not implemented")))
      (finally
        (delete-tree! root)))))

(deftest preset-plugin-finds-shipped-presets-away-from-the-launch-directory
  (let [original (System/getProperty "user.dir")
        elsewhere (.toFile (java.nio.file.Files/createTempDirectory
                             "qi-agent-preset-cwd-"
                             (make-array java.nio.file.attribute.FileAttribute 0)))]
    (try
      (System/setProperty "user.dir" (str elsewhere))
      (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.presets}]})]
        (try
          (is (some #(= "standard" (:id %))
                    ((:list (kernel/require-service ctx :agent/presets)))))
          (finally
            (kernel/dispose-all! ctx))))
      (finally
        (System/setProperty "user.dir" original)
        (delete-tree! elsewhere)))))
