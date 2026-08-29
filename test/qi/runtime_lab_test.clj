(ns qi.runtime-lab-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [clojure.test :refer [deftest is testing]]))

(def lab-config
  {:plugins [{:ns 'qi.plugins.runtime-inspect}
             {:ns 'qi.plugins.runtime-lab
              :config {:allow [{:ns 'qi.plugins.math}]
                       :blueprints {:enabled true}}}]})

(def greeting-v1
  (pr-str
   {:description "A stateful greeting tool."
    :initial-state {"calls" 0}
    :tools
    [{:name "greet_person"
      :description "Greet one person and return the durable call count."
      :parameters {:type "object"
                   :additionalProperties false
                   :properties {"name" {:type "string" :maxLength 100}}
                   :required ["name"]}
      :program
      [:let [["next" [:+ [:state-get "calls" 0] 1]]]
       [:do
        [:state-put "calls" [:var "next"]]
        {:message [:str "Hello, " [:arg "name"] "!"]
         :calls [:var "next"]}]]}]}))

(def greeting-v2
  (pr-str
   {:description "An updated stateful greeting tool."
    :tools
    [{:name "greet_person"
      :description "Greet one person using the updated package."
      :parameters {:type "object"
                   :additionalProperties false
                   :properties {"name" {:type "string" :maxLength 100}}
                   :required ["name"]}
      :program
      [:let [["next" [:+ [:state-get "calls" 0] 1]]]
       [:do
        [:state-put "calls" [:var "next"]]
        {:message [:str "Welcome, " [:upper [:arg "name"]] "!"]
         :calls [:var "next"]}]]}]}))

(deftest runtime-lab-activates-and-rolls-back-an-allowlisted-core-plugin
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))]
        (is (= {:plugins [{:namespace "qi.plugins.math" :status "inactive"}]}
               (execute {:action "status"} {})))
        (is (= {:namespace "qi.plugins.math"
                :plugin-id ":tools/math"
                :status "active"}
               (execute {:action "activate" :namespace "qi.plugins.math"} {})))
        (is (= "calculate" (:name (kernel/tool ctx "calculate"))))
        (is (some #(= ":tools/math" (:id %))
                  (:plugins ((:execute (kernel/tool ctx "runtime_inspect"))
                             {:action "summary"} {}))))
        (is (= "active"
               (:status (execute {:action "activate" :namespace "qi.plugins.math"} {}))))
        (is (= {:namespace "qi.plugins.math"
                :plugin-id ":tools/math"
                :status "inactive"}
               (execute {:action "deactivate" :namespace "qi.plugins.math"} {})))
        (is (nil? (kernel/tool ctx "calculate")))
        (is (= "inactive"
               (:status (execute {:action "deactivate" :namespace "qi.plugins.math"} {})))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest runtime-lab-rejects-unlisted-plugins-and-cleans-up-active-effects
  (let [ctx (plugin/boot! lab-config)
        execute (:execute (kernel/tool ctx "runtime_plugin"))]
    (testing "the model cannot provide arbitrary namespaces or config"
      (is (thrown-with-msg? clojure.lang.ExceptionInfo
                            #"Plugin is not allowlisted"
                            (execute {:action "activate"
                                      :namespace "qi.plugins.tools"} {}))))
    (execute {:action "activate" :namespace "qi.plugins.math"} {})
    (is (some? (kernel/tool ctx "calculate")))
    (kernel/dispose-all! ctx)
    (is (nil? (kernel/tool ctx "calculate")))
    (is (nil? (kernel/tool ctx "runtime_plugin")))))

(deftest runtime-lab-supports-immutable-package-versions-and-rollback
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))
            first-package (execute {:action "define"
                                    :idPrefix "math"
                                    :namespace "qi.plugins.math"
                                    :name "Math v1"
                                    :purpose "Add an audited calculator."} {})
            plugin-id (:plugin-id first-package)]
        (is (= "pkg-1" (:package-id first-package)))
        (is (= "defined" (:status first-package)))
        (is (= "running"
               (:status (execute {:action "run"
                                  :pluginId plugin-id
                                  :packageId "pkg-1"} {}))))
        (is (some? (kernel/tool ctx "calculate")))
        (let [second-package
              (execute {:action "define"
                        :pluginId plugin-id
                        :namespace "qi.plugins.math"
                        :name "Math v2"
                        :purpose "Replace the calculator with a new immutable package."} {})]
          (is (= "pkg-2" (:package-id second-package)))
          (is (= "running"
                 (:status (execute {:action "update"
                                    :pluginId plugin-id
                                    :packageId "pkg-2"} {}))))
          (is (= "pkg-2"
                 (:current-package-id
                  (execute {:action "inspect" :pluginId plugin-id} {}))))
          (is (= "stopped"
                 (:status (execute {:action "stop" :pluginId plugin-id} {}))))
          (is (nil? (kernel/tool ctx "calculate")))
          (is (= "running"
                 (:status (execute {:action "run"
                                    :pluginId plugin-id
                                    :packageId "pkg-1"} {}))))
          (is (= "pkg-1"
                 (:current-package-id
                  (execute {:action "inspect" :pluginId plugin-id} {}))))
          (is (= "undefined"
                 (:status (execute {:action "undefine"
                                    :pluginId plugin-id} {}))))
          (is (empty? (:plugins (execute {:action "inspect"} {}))))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest runtime-lab-records-package-diagnostics-without-advancing-current
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))]
        (execute {:action "activate" :namespace "qi.plugins.math"} {})
        (let [{:keys [plugin-id package-id]}
              (execute {:action "define"
                        :idPrefix "math"
                        :namespace "qi.plugins.math"
                        :name "Conflicting math"
                        :purpose "Exercise failed activation diagnostics."} {})]
          (is (thrown-with-msg?
               clojure.lang.ExceptionInfo #"already loaded"
               (execute {:action "run" :pluginId plugin-id
                         :packageId package-id} {})))
          (let [inspection (execute {:action "inspect"
                                     :pluginId plugin-id
                                     :packageId package-id} {})]
            (is (nil? (:current-package-id inspection)))
            (is (re-find #"already loaded"
                         (get-in inspection [:package :diagnostic :message]))))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest runtime-lab-compiles-stateful-edn-blueprints-and-hot-updates-them
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))
            first-package (execute {:action "define"
                                    :idPrefix "greeter"
                                    :name "Greeter v1"
                                    :purpose "Create a session-local greeting tool."
                                    :source greeting-v1} {})
            plugin-id (:plugin-id first-package)]
        (is (= "blueprint" (:kind first-package)))
        (is (= ["greet_person"] (:tools first-package)))
        (is (= "running"
               (:status (execute {:action "run"
                                  :pluginId plugin-id
                                  :packageId "pkg-1"} {}))))
        (is (= {:message "Hello, Ada!" :calls 1}
               ((:execute (kernel/tool ctx "greet_person")) {:name "Ada"} {})))
        (let [second-package (execute {:action "define"
                                      :pluginId plugin-id
                                      :name "Greeter v2"
                                      :purpose "Hot-update the greeting behavior."
                                      :source greeting-v2} {})]
          (is (= "pkg-2" (:package-id second-package)))
          (is (= "running"
                 (:status (execute {:action "update"
                                    :pluginId plugin-id
                                    :packageId "pkg-2"} {}))))
          (is (= {:message "Welcome, ADA!" :calls 2}
                 ((:execute (kernel/tool ctx "greet_person"))
                  {:name "Ada"} {})))
          (let [inspection (execute {:action "inspect"
                                     :pluginId plugin-id
                                     :packageId "pkg-2"} {})]
            (is (= greeting-v2 (get-in inspection [:package :source])))
            (is (= ["greet_person"] (get-in inspection [:package :tools]))))
          (let [failed-package
                (execute {:action "define"
                          :pluginId plugin-id
                          :name "Conflicting package"
                          :purpose "Verify hot-update rollback."
                          :source (pr-str {:description "conflict"
                                           :tools [{:name "runtime_plugin"
                                                    :description "must not replace host"
                                                    :parameters {:type "object"
                                                                 :properties {}
                                                                 :required []
                                                                 :additionalProperties false}
                                                    :program {:ok true}}]})}
                         {})]
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo #"already registered"
                 (execute {:action "update"
                           :pluginId plugin-id
                           :packageId (:package-id failed-package)} {})))
            (is (= "pkg-2"
                   (:current-package-id
                    (execute {:action "inspect" :pluginId plugin-id} {}))))
            (is (= {:message "Welcome, GRACE!" :calls 3}
                   ((:execute (kernel/tool ctx "greet_person"))
                    {:name "Grace"} {}))))
          (is (= "stopped"
                 (:status (execute {:action "stop" :pluginId plugin-id} {}))))
          (is (nil? (kernel/tool ctx "greet_person")))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest runtime-lab-blueprints-reject-code-capabilities-and-restore-on-conflict
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))]
        (testing "symbols and unknown host operators never reach a Clojure evaluator"
          (is (thrown-with-msg?
               clojure.lang.ExceptionInfo #"outside the Blueprint data model"
               (execute {:action "define"
                         :idPrefix "unsafe"
                         :name "Unsafe"
                         :purpose "Attempt symbol resolution."
                         :source (pr-str {:description "unsafe"
                                          :tools [{:name "unsafe_tool"
                                                   :description "unsafe"
                                                   :parameters {:type "object"
                                                                :properties {}
                                                                :required []
                                                                :additionalProperties false}
                                                   :program 'clojure.core/slurp}]})}
                        {})))
          (is (thrown-with-msg?
               clojure.lang.ExceptionInfo #"Unsupported Blueprint operator"
               (execute {:action "define"
                         :idPrefix "unsafe"
                         :name "Unsafe"
                         :purpose "Attempt Java interop."
                         :source (pr-str {:description "unsafe"
                                          :tools [{:name "unsafe_tool"
                                                   :description "unsafe"
                                                   :parameters {:type "object"
                                                                :properties {}
                                                                :required []
                                                                :additionalProperties false}
                                                   :program [:java/new "java.io.File"]}]})}
                        {}))))
        (testing "a package that collides with a host tool cannot replace it"
          (let [{:keys [plugin-id]}
                (execute {:action "define"
                          :idPrefix "collision"
                          :name "Collision"
                          :purpose "Exercise Kernel ownership isolation."
                          :source (pr-str {:description "collision"
                                           :tools [{:name "runtime_plugin"
                                                    :description "must not replace host"
                                                    :parameters {:type "object"
                                                                 :properties {}
                                                                 :required []
                                                                 :additionalProperties false}
                                                    :program {:ok true}}]})}
                         {})]
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo #"already registered"
                 (execute {:action "run" :pluginId plugin-id
                           :packageId "pkg-1"} {})))
            (is (= "runtime_plugin" (:name (kernel/tool ctx "runtime_plugin"))))))
        (testing "state commits only after output validation succeeds"
          (let [{:keys [plugin-id package-id]}
                (execute
                 {:action "define"
                  :idPrefix "atomic"
                  :name "Atomic state"
                  :purpose "Verify transactional Blueprint state."
                  :source
                  (pr-str
                   {:description "transactional state"
                    :initial-state {"count" 0}
                    :tools
                    [{:name "invalid_increment"
                      :description "Mutate a draft and then fail its output schema."
                      :parameters {:type "object" :properties {} :required []
                                   :additionalProperties false}
                      :output-schema {:type "string"}
                      :program [:do [:state-put "count" 1] {:count 1}]}
                     {:name "read_atomic_count"
                      :description "Read the committed count."
                      :parameters {:type "object" :properties {} :required []
                                   :additionalProperties false}
                      :output-schema {:type "integer"}
                      :program [:state-get "count" 0]}]})}
                 {})]
            (execute {:action "run" :pluginId plugin-id
                      :packageId package-id} {})
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo #"invalid output"
                 ((:execute (kernel/tool ctx "invalid_increment")) {} {})))
            (is (= 0 ((:execute (kernel/tool ctx "read_atomic_count")) {} {}))))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest runtime-blueprint-collection-forms-are-lexical-and-bounded
  (let [ctx (plugin/boot! lab-config)]
    (try
      (let [execute (:execute (kernel/tool ctx "runtime_plugin"))
            source
            (pr-str
             {:description "Summarize positive numbers."
              :tools
              [{:name "summarize_positive"
                :description "Filter positive values, label them, and calculate their sum."
                :parameters {:type "object"
                             :properties
                             {"values" {:type "array"
                                        :items {:type "number"}
                                        :maxItems 32}}
                             :required ["values"]
                             :additionalProperties false}
                :program
                [:let [["positive" [:filter "number" [:arg "values"]
                                    [:> [:var "number"] 0]]]]
                 {:count [:count [:var "positive"]]
                  :labels [:map "number" [:var "positive"]
                           [:str "n=" [:var "number"]]]
                  :sum [:reduce "total" "number" 0 [:var "positive"]
                        [:+ [:var "total"] [:var "number"]]]}]}]})
            {:keys [plugin-id package-id]}
            (execute {:action "define"
                      :idPrefix "summary"
                      :name "Positive summary"
                      :purpose "Exercise bounded collection forms."
                      :source source} {})]
        (execute {:action "run" :pluginId plugin-id
                  :packageId package-id} {})
        (is (= {:count 3 :labels ["n=1" "n=2" "n=4"] :sum 7}
               ((:execute (kernel/tool ctx "summarize_positive"))
                {:values [-3 1 2 0 4]} {}))))
      (finally
        (kernel/dispose-all! ctx)))))
