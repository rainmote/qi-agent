(ns qi.plugin-manager-test
  (:require [babashka.process :as process]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing]]
            [qi.kernel :as kernel]
            [qi.plugin-package :as package]
            [qi.plugins.plugin-manager :as manager])
  (:import [java.nio.file Files]))

(defn- temp-dir [] (.getCanonicalPath (.toFile (Files/createTempDirectory "qi-plugin-test-" (make-array java.nio.file.attribute.FileAttribute 0)))))
(defn- clean! [root]
  (with-open [paths (Files/walk (.toPath (io/file root)) (make-array java.nio.file.FileVisitOption 0))]
    (doseq [path (reverse (vec (iterator-seq (.iterator paths))))] (Files/deleteIfExists path))))
(defn- bundle
  ([id version tool] (bundle id version tool {}))
  ([id version tool extra]
   (merge {:format 1 :id id :version version :name "Example" :description "Test package"
           :blueprint (pr-str {:description "Example Blueprint" :initial-state {"count" 0}
                              :tools [{:name tool :description "Return a version"
                                       :parameters {:type "object" :properties {} :additionalProperties false}
                                       :program [:literal version]}]})
           :ui [{:id "status" :slot "panel" :type "text" :title "Status" :data {:text version}}]}
          extra)))
(defn- write-bundle! [root name value]
  (let [file (io/file root name)] (spit file (pr-str value)) (str file)))
(defn- setup [root trusted? approval & [options]]
  (let [ctx (kernel/create-context) security (kernel/plugin-context ctx :test/security)]
    (kernel/register-service! security :project/trust {:trusted? (constantly trusted?)})
    (kernel/register-service! security :approval/request approval)
    [ctx (manager/create-manager ctx (merge {:user-dir (str (io/file root "user"))} options))]))
(defn- exec [manager args] ((:execute! manager) args {}))

(deftest package-lifecycle-persists-and-rolls-back
  (let [root (temp-dir) approvals (atom [])
        [ctx manager] (setup root true #(do (swap! approvals conj %) :allow))]
    (try
      (let [source (write-bundle! root "one.edn" (bundle "demo" "1.0.0" "demo_value"))]
        (is (false? (:enabled (exec manager {:action "install" :source source}))))
        (is (nil? (kernel/tool ctx "demo_value")))
        (is (:active (exec manager {:action "enable" :id "demo"})))
        (is (= "1.0.0" ((:execute (kernel/tool ctx "demo_value")) {} {})))
        (is (= "demo" (get-in ((:slots! manager)) [:slots 0 :package-id])))
        (let [second (write-bundle! root "two.edn" (bundle "demo" "2.0.0" "demo_value"))]
          (is (= "2.0.0" (:version (exec manager {:action "install" :source second}))))
          (is (= "2.0.0" ((:execute (kernel/tool ctx "demo_value")) {} {})))
          (is (= "1.0.0" (:version (exec manager {:action "rollback" :id "demo"}))))
          (is (= "1.0.0" ((:execute (kernel/tool ctx "demo_value")) {} {}))))
        ((:dispose! manager))
        (is (nil? (kernel/tool ctx "demo_value")))
        (let [[ctx2 manager2] (setup root true (constantly :allow))]
          (try
            (is (= "1.0.0" ((:execute (kernel/tool ctx2 "demo_value")) {} {})))
            (is (false? (:active (exec manager2 {:action "disable" :id "demo"}))))
            (is (:removed (exec manager2 {:action "remove" :id "demo"})))
            (is (empty? (:plugins ((:list! manager2)))))
            (finally ((:dispose! manager2)) (kernel/dispose-all! ctx2))))
        (is (= 4 (count @approvals))))
      (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root)))))

(deftest service-authorization-cannot-be-bypassed-by-direct-calls
  (doseq [[trusted? approval expected] [[false :allow #"trusted workspace"] [true :deny #"not approved"]]]
    (let [root (temp-dir) [ctx manager] (setup root trusted? (constantly approval))]
      (try
        (is (= [] (:plugins ((:list! manager)))))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo expected
                             (exec manager {:action "install" :source (write-bundle! root "input.edn" (bundle "demo" "1.0.0" "demo_value"))})))
        (is (not (.exists (io/file root "user"))))
        (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root))))))

(deftest invalid-upgrades-restore-runtime-and-persisted-pointer
  (let [root (temp-dir) [ctx manager] (setup root true (constantly :allow))]
    (try
      (exec manager {:action "install" :source (write-bundle! root "one.edn" (bundle "demo" "1.0.0" "demo_value"))})
      (exec manager {:action "enable" :id "demo"})
      (kernel/register-tool! (kernel/plugin-context ctx :test/other)
                            {:name "collision_tool" :description "occupied" :parameters {} :execute (fn [_ _] :ok)})
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"already registered"
                           (exec manager {:action "install" :source (write-bundle! root "two.edn" (bundle "demo" "2.0.0" "collision_tool"))})))
      (is (= "1.0.0" (:version ((:inspect! manager) {:id "demo"}))))
      (is (= "1.0.0" ((:execute (kernel/tool ctx "demo_value")) {} {})))
      (is (= :ok ((:execute (kernel/tool ctx "collision_tool")) {} {})))
      (with-redefs-fn {#'qi.plugins.plugin-manager/persist! (fn [_ _] (throw (ex-info "Injected persistence failure" {})))}
        #(is (thrown-with-msg? clojure.lang.ExceptionInfo #"persistence failure"
                              (exec manager {:action "install" :source (write-bundle! root "valid-upgrade.edn"
                                                         (bundle "demo" "3.0.0" "demo_value"))}))))
      (is (= "1.0.0" (:version ((:inspect! manager) {:id "demo"}))))
      (is (= "1.0.0" ((:execute (kernel/tool ctx "demo_value")) {} {})))
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"immutable"
                           (exec manager {:action "install" :source (write-bundle! root "changed.edn"
                             (assoc (bundle "demo" "1.0.0" "demo_value") :description "mutated"))})))
      (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root)))))

(deftest system-packages-are-read-only-and-dependencies-are-exact
  (let [root (temp-dir) system (io/file root "system") _ (.mkdir system)
        _ (write-bundle! (str system) "core.edn" (bundle "system-demo" "1.0.0" "system_value"))
        [ctx manager] (setup root true (constantly :allow) {:system-dirs [(str system)]})]
    (try
      (is (:read-only ((:inspect! manager) {:id "system-demo"})))
      (is (some? (kernel/tool ctx "system_value")))
      (doseq [action ["enable" "disable" "remove" "rollback"]]
        (is (thrown-with-msg? clojure.lang.ExceptionInfo #"read-only" (exec manager {:action action :id "system-demo"}))))
      (exec manager {:action "install" :source (write-bundle! root "dependent.edn"
                             (bundle "dependent" "1.0.0" "dependent_value" {:requires [{:id "base-demo" :version "1.0.0"}]}))})
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"dependency" (exec manager {:action "enable" :id "dependent"})))
      (exec manager {:action "install" :source (write-bundle! root "base.edn" (bundle "base-demo" "1.0.0" "base_value"))})
      (exec manager {:action "enable" :id "base-demo"})
      (exec manager {:action "enable" :id "dependent"})
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"dependent" (exec manager {:action "disable" :id "base-demo"})))
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"dependent"
                           (exec manager {:action "install" :source (write-bundle! root "base2.edn" (bundle "base-demo" "2.0.0" "base_value"))})))
      (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root)))))

(deftest package-boundaries-reject-executable-path-and-schema-attacks
  (let [valid (bundle "safe-demo" "1.0.0" "safe_value")
        parse #(package/parse-bundle (.getBytes (pr-str %) "UTF-8"))]
    (doseq [invalid [(assoc valid :id "../escape") (assoc valid :install "rm -rf")
                     (assoc valid :namespace 'arbitrary.code)
                     (assoc valid :requires [{:id "another" :version "*"}])
                     (assoc valid :ui [{:id "frame" :slot "panel" :type "html" :title "Oops" :data {:html "<script>"}}])
                     (assoc-in valid [:ui 0 :data] {:text "safe" :onclick "arbitrary()"})
                     (assoc-in valid [:ui 0 :data] {:text {:nested "wrong"}})
                     (assoc valid :blueprint "{:description \"bad\" :tools []}")]]
      (is (thrown? clojure.lang.ExceptionInfo (parse invalid))))
    (is (thrown? clojure.lang.ExceptionInfo (package/parse-bundle (.getBytes "#=(System/exit 0)" "UTF-8"))))
    (is (thrown? clojure.lang.ExceptionInfo (package/parse-bundle (.getBytes (str (pr-str valid) " {}") "UTF-8"))))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"SHA-256 pin" (package/read-source {:source "https://example.com/plugin.edn"})))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"scheme" (package/read-source {:source "file:///etc/passwd"})))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"commit hash"
                         (package/read-source {:source "git+https://example.com/repo.git" :sha256 (apply str (repeat 64 "a")) :commit "main" :path "plugin.edn"})))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo #"safe relative"
                         (package/read-source {:source "git+https://example.com/repo.git" :sha256 (apply str (repeat 64 "a"))
                                               :commit (apply str (repeat 40 "a")) :path "../plugin.edn"})))))

(deftest integrity-and-symlink-validation
  (let [root (temp-dir) source (write-bundle! root "package.edn" (bundle "safe-demo" "1.0.0" "safe_value"))
        link (io/file root "linked.edn")]
    (try
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"integrity"
                           (package/read-source {:source source :sha256 (apply str (repeat 64 "0"))})))
      (Files/createSymbolicLink (.toPath link) (.toPath (io/file source))
                                (make-array java.nio.file.attribute.FileAttribute 0))
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"Symbolic" (package/read-source {:source (str link)})))
      (let [[ctx manager] (setup root true (constantly :allow))]
        (try
          (let [receipt (exec manager {:action "install" :source source})
                object (io/file root "user" "objects" (str (:sha256 receipt) ".edn"))]
            (spit object "{}")
            (is (thrown? clojure.lang.ExceptionInfo (exec manager {:action "enable" :id "safe-demo"})))
            (is (nil? (kernel/tool ctx "safe_value"))))
          (finally ((:dispose! manager)) (kernel/dispose-all! ctx))))
      (finally (clean! root)))))

(deftest approval-pins-reviewed-content-and-racing-updates-are-rejected
  (let [root (temp-dir) source (write-bundle! root "input.edn" (bundle "demo" "1.0.0" "demo_value"))
        approval (atom (fn [_] :allow))
        [ctx manager] (setup root true #(@approval %))]
    (try
      (reset! approval (fn [request]
                        (is (re-find #"[a-f0-9]{64}" (get-in request [:target :command])))
                        (spit source (pr-str (bundle "demo" "2.0.0" "demo_value")))
                        :allow))
      (is (= "1.0.0" (:version (exec manager {:action "install" :source source}))))
      (reset! approval (fn [_] :allow))
      (let [[ctx2 manager2] (setup root true (constantly :allow))]
        (try
          (reset! approval (fn [_] (exec manager2 {:action "install" :source source}) :allow))
          (is (thrown-with-msg? clojure.lang.ExceptionInfo #"changed while awaiting approval"
                               (exec manager {:action "enable" :id "demo"})))
          (is (nil? (kernel/tool ctx "demo_value")))
          (finally ((:dispose! manager2)) (kernel/dispose-all! ctx2))))
      (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root)))))

(deftest plan-gate-is-rechecked-after-approval-and-service-arguments-are-validated
  (let [root (temp-dir) allowed (atom true) [ctx manager] (setup root true (fn [_] (reset! allowed false) :allow))
        source (write-bundle! root "input.edn" (bundle "demo" "1.0.0" "demo_value"))]
    (try
      (kernel/register-service! (kernel/plugin-context ctx :test/plan) :planning/runtime
                                {:permitted? (fn [_ _] @allowed)})
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"Plan mode"
                           (exec manager {:action "install" :source source})))
      (is (not (.exists (io/file root "user"))))
      (is (thrown? clojure.lang.ExceptionInfo
                   (exec manager {:action "install" :source source :expected-current nil})))
      (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root)))))

(deftest cancelled-or-disposed-manager-never-applies-an-approved-late-mutation
  (doseq [kind [:cancel :dispose]]
    (let [root (temp-dir) holder (atom nil) token (qi.cancellation/create-token)
          [ctx manager] (setup root true (fn [_]
                                          (if (= kind :cancel) (qi.cancellation/cancel! token)
                                              ((:dispose! @holder)))
                                          :allow))
          source (write-bundle! root "input.edn" (bundle "demo" "1.0.0" "demo_value"))]
      (reset! holder manager)
      (try
        (is (thrown? clojure.lang.ExceptionInfo
                     ((:execute! manager) {:action "install" :source source} {:cancel-token token})))
        (is (not (.exists (io/file root "user"))))
        (is (nil? (kernel/tool ctx "demo_value")))
        (finally ((:dispose! manager)) (kernel/dispose-all! ctx) (clean! root))))))

(deftest pinned-remote-transports-preserve-bytes-and-do-not-use-ambient-config
  (let [manifest (assoc (bundle "remote-demo" "1.0.0" "remote_value") :description "中文内容")
        content (pr-str manifest) bytes (.getBytes content "UTF-8") digest (package/sha256 bytes)
        commit (apply str (repeat 40 "a")) calls (atom [])
        real-process process/process
        target (fn [url] {:url url :host "example.test" :port 443 :address "1.1.1.1"})
        run (fn [argv options]
              (swap! calls conj [argv options])
              (real-process ["/usr/bin/printf" "%s"
                             (cond
                               (= "/usr/bin/curl" (first argv)) (str content "\n200")
                               (some #{"rev-parse"} argv) (str commit "\n")
                               (some #{"cat-file"} argv) (str (alength bytes) "\n")
                               (some #{"show"} argv) content
                               :else "")]
                            options))]
    (with-redefs-fn {#'qi.plugin-package/remote-target! target #'process/process run}
      (fn []
        (is (= digest (:sha256 (package/read-source {:source "https://example.test/plugin.edn" :sha256 digest}))))
        (is (= digest (:sha256 (package/read-source {:source "git+https://example.test/repo.git"
                                                     :commit commit :path "plugin.edn" :sha256 digest}))))))
    (is (= "-q" (get-in @calls [0 0 1])))
    (is (some #{"example.test:443:1.1.1.1"} (get-in @calls [0 0])))
    (doseq [[argv options] (rest @calls)]
      (is (some #{"http.curloptResolve=example.test:443:1.1.1.1"} argv))
      (is (= "/dev/null" (get-in options [:env "GIT_CONFIG_GLOBAL"])))
      (is (some #{"core.hooksPath=/dev/null"} argv)))
    (with-redefs-fn {#'qi.plugin-package/remote-target! target
                    #'process/process (fn [_ options]
                                        (real-process ["/usr/bin/printf" "%s" (str content "\n302")] options))}
      #(is (thrown-with-msg? clojure.lang.ExceptionInfo #"HTTP 200"
                            (package/read-source {:source "https://example.test/plugin.edn" :sha256 digest}))))))

(deftest remote-destination-parser-rejects-local-and-ambiguous-hosts-before-transport
  (doseq [source ["https://127.0.0.1/plugin.edn" "https://[fc00::1]/plugin.edn"
                  "https://0177.0.0.1/plugin.edn" "https://user:pass@example.com/plugin.edn"
                  "https://example.com:8443/plugin.edn"]]
    (is (thrown? clojure.lang.ExceptionInfo
                 (package/read-source {:source source :sha256 (apply str (repeat 64 "a"))})))))
