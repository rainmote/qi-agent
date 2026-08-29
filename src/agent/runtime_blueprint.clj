(ns agent.runtime-blueprint
  "Compile bounded EDN programs into reversible, model-facing Kernel tools.

  Blueprints are data, not Clojure source. The compiler closes over a small
  capability-free operator table and never resolves symbols, Vars or classes."
  (:require [agent.kernel :as kernel]
            [agent.schema :as schema]
            [clojure.edn :as edn]
            [clojure.string :as str]))

(def default-limits
  {:max-source-chars 30000
   :max-tools 8
   :max-ast-nodes 512
   :max-depth 24
   :max-value-nodes 4096
   :max-collection-items 256
   :max-string-chars 50000
   :max-number-magnitude 1.0e15})

(def ^:private blueprint-keys
  #{:description :initial-state :tools})

(def ^:private tool-keys
  #{:name :description :parameters :output-schema :program})

(def ^:private schema-keys
  #{:type :description :properties :required :additionalProperties :items
    :enum :const :nullable :minimum :maximum :exclusiveMinimum
    :exclusiveMaximum :multipleOf :minLength :maxLength :minItems
    :maxItems :minProperties :maxProperties :uniqueItems})

(def ^:private common-schema-keys
  #{:type :description :enum :const :nullable})

(def ^:private type-schema-keys
  {"string" #{:minLength :maxLength}
   "number" #{:minimum :maximum :exclusiveMinimum :exclusiveMaximum :multipleOf}
   "integer" #{:minimum :maximum :exclusiveMinimum :exclusiveMaximum :multipleOf}
   "boolean" #{}
   "null" #{}
   "array" #{:items :minItems :maxItems :uniqueItems}
   "object" #{:properties :required :additionalProperties
               :minProperties :maxProperties}})

(def ^:private scalar-types
  #{"string" "number" "integer" "boolean" "null"})

(defn- fail! [message data]
  (throw (ex-info message (assoc data :type :runtime-blueprint/invalid))))

(defn- named-key [key]
  (cond
    (keyword? key) key
    (string? key) (keyword key)
    :else key))

(defn- normalized-keys [value]
  (set (map (comp named-key key) value)))

(defn- exact-keys! [value allowed path]
  (let [unknown (seq (remove allowed (normalized-keys value)))]
    (when unknown
      (fail! (str path " contains unsupported keys")
             {:path path :keys (vec (sort-by str unknown))}))))

(defn- field [value key]
  (if (contains? value key) (get value key) (get value (name key))))

(defn- finite-number? [value]
  (and (number? value)
       (let [number (double value)]
         (and (not (Double/isNaN number))
              (not (Double/isInfinite number))))))

(defn normalize-limits
  "Validate optional host-owned Blueprint resource limits."
  [overrides]
  (when-not (map? overrides)
    (fail! "Blueprint limits must be a map" {:limits overrides}))
  (let [unknown (seq (remove (set (keys default-limits)) (keys overrides)))]
    (when unknown
      (fail! "Blueprint limits contain unsupported keys"
             {:keys (vec (sort unknown))})))
  (let [limits (merge default-limits overrides)]
    (doseq [[key value] (dissoc limits :max-number-magnitude)]
      (when-not (pos-int? value)
        (fail! "Blueprint limits must be positive integers"
               {:key key :value value})))
    (when-not (and (finite-number? (:max-number-magnitude limits))
                   (pos? (:max-number-magnitude limits)))
      (fail! "Blueprint number magnitude limit must be positive and finite"
             {:value (:max-number-magnitude limits)}))
    limits))

(defn- bounded-value!
  ([value limits path]
   (bounded-value! value limits path (atom 0) 0))
  ([value limits path nodes depth]
   (when (> depth (:max-depth limits))
     (fail! (str path " exceeds the value depth limit") {:path path}))
   (when (> (swap! nodes inc) (:max-value-nodes limits))
     (fail! (str path " exceeds the value node limit") {:path path}))
   (cond
     (or (nil? value) (instance? Boolean value)) value

     (string? value)
     (do
       (when (> (count value) (:max-string-chars limits))
         (fail! (str path " exceeds the string length limit") {:path path}))
       value)

     (keyword? value) value

     (number? value)
     (do
       (when-not (and (finite-number? value)
                      (<= (Math/abs (double value))
                          (:max-number-magnitude limits)))
         (fail! (str path " contains an out-of-range number")
                {:path path :value value}))
       value)

     (map? value)
     (do
       (when (> (count value) (:max-collection-items limits))
         (fail! (str path " exceeds the map size limit") {:path path}))
       (doseq [[key nested] value]
         (when-not (or (string? key) (keyword? key))
           (fail! (str path " contains a non-string map key")
                  {:path path :key key}))
         (bounded-value! nested limits (str path "." (name key)) nodes
                         (inc depth)))
       value)

     (vector? value)
     (do
       (when (> (count value) (:max-collection-items limits))
         (fail! (str path " exceeds the vector size limit") {:path path}))
       (doseq [[index nested] (map-indexed vector value)]
         (bounded-value! nested limits (str path "[" index "]") nodes
                         (inc depth)))
       value)

     :else
     (fail! (str path " contains a value outside the Blueprint data model")
            {:path path :class (str (class value))}))))

(defn- property-name! [value path]
  (when-not (and (or (string? value) (keyword? value))
                 (re-matches #"[A-Za-z][A-Za-z0-9_-]{0,63}" (name value)))
    (fail! (str path " must be a safe property name")
           {:path path :value value}))
  (name value))

(declare validate-schema!)

(defn- validate-object-schema! [schema path limits]
  (let [properties (or (field schema :properties) {})
        required (or (field schema :required) [])]
    (when-not (map? properties)
      (fail! (str path ".properties must be a map") {:path path}))
    (when (> (count properties) 32)
      (fail! (str path " has too many properties") {:path path}))
    (doseq [[name nested] properties]
      (property-name! name (str path ".properties"))
      (validate-schema! nested (str path ".properties." (clojure.core/name name))
                        limits))
    (when-not (and (vector? required)
                   (every? #(or (string? %) (keyword? %)) required))
      (fail! (str path ".required must be a vector of property names")
             {:path path}))
    (let [known (set (map (comp name key) properties))
          missing (seq (remove known (map name required)))]
      (when missing
        (fail! (str path ".required refers to unknown properties")
               {:path path :properties (vec missing)})))
    (when-not (false? (field schema :additionalProperties))
      (fail! (str path " must set :additionalProperties false")
             {:path path}))))

(defn- validate-schema! [schema path limits]
  (when-not (map? schema)
    (fail! (str path " must be a JSON Schema map") {:path path}))
  (exact-keys! schema schema-keys path)
  (bounded-value! schema limits path)
  (let [type (field schema :type)]
    (when-not (or (contains? scalar-types type)
                  (= "object" type)
                  (= "array" type))
      (fail! (str path " has an unsupported or missing :type")
             {:path path :value type}))
    (exact-keys! schema (into common-schema-keys (get type-schema-keys type)) path)
    (when-let [description (field schema :description)]
      (when-not (and (string? description) (<= (count description) 500))
        (fail! (str path ".description must be a bounded string") {:path path})))
    (when-let [enum (field schema :enum)]
      (when-not (and (vector? enum) (seq enum) (<= (count enum) 64))
        (fail! (str path ".enum must be a non-empty bounded vector")
               {:path path})))
    (when (and (some? (field schema :nullable))
               (not (instance? Boolean (field schema :nullable))))
      (fail! (str path ".nullable must be boolean") {:path path}))
    (doseq [key [:minimum :maximum :exclusiveMinimum :exclusiveMaximum
                 :multipleOf]
            :let [value (field schema key)]
            :when (some? value)]
      (when-not (finite-number? value)
        (fail! (str path "." (name key) " must be a finite number")
               {:path path :value value})))
    (when (and (some? (field schema :multipleOf))
               (not (pos? (field schema :multipleOf))))
      (fail! (str path ".multipleOf must be positive") {:path path}))
    (doseq [key [:minLength :maxLength :minItems :maxItems
                 :minProperties :maxProperties]
            :let [value (field schema key)]
            :when (some? value)]
      (when-not (and (integer? value) (not (neg? value)))
        (fail! (str path "." (name key) " must be a non-negative integer")
               {:path path :value value})))
    (when (and (some? (field schema :uniqueItems))
               (not (instance? Boolean (field schema :uniqueItems))))
      (fail! (str path ".uniqueItems must be boolean") {:path path}))
    (case type
      "object" (validate-object-schema! schema path limits)
      "array" (let [items (field schema :items)]
                (when-not items
                  (fail! (str path ".items is required") {:path path}))
                (validate-schema! items (str path ".items") limits))
      nil))
  schema)

(defn- arity! [op arguments minimum maximum]
  (let [size (count arguments)]
    (when-not (<= minimum size maximum)
      (fail! (str op " expects "
                  (if (= minimum maximum) minimum (str minimum "-" maximum))
                  " arguments")
             {:operator op :argument-count size}))))

(defn- variable-name! [value kind]
  (when-not (and (string? value)
                 (re-matches #"[A-Za-z][A-Za-z0-9_-]{0,63}" value))
    (fail! (str kind " must be a safe variable name")
           {:value value :kind kind}))
  value)

(defn- require-number! [value op]
  (when-not (finite-number? value)
    (fail! (str op " requires finite numbers") {:operator op :value value}))
  value)

(defn- require-string! [value op]
  (when-not (string? value)
    (fail! (str op " requires strings") {:operator op :value value}))
  value)

(defn- require-sequential! [value op]
  (when-not (sequential? value)
    (fail! (str op " requires a sequential value")
           {:operator op :value value}))
  value)

(defn- result! [value env]
  (bounded-value! value (:limits env) "program result"))

(declare compile-expression)

(defn- compile-many [expressions scope depth nodes limits]
  (mapv #(compile-expression % scope (inc depth) nodes limits) expressions))

(defn- evaluate-many [compiled env]
  (mapv #(% env) compiled))

(defn- compiled-operation [op compiled apply-operation]
  (fn [env]
    (result! (apply-operation (evaluate-many compiled env)) env)))

(defn- compile-map [value scope depth nodes limits]
  (let [compiled (mapv (fn [[key nested]]
                         [key (compile-expression nested scope (inc depth)
                                                  nodes limits)])
                       value)]
    (fn [env]
      (result! (into (empty value)
                     (map (fn [[key run]] [key (run env)]))
                     compiled)
               env))))

(defn- compile-let [[bindings body :as arguments] scope depth nodes limits]
  (arity! :let arguments 2 2)
  (when-not (vector? bindings)
    (fail! ":let bindings must be a vector of [name expression] pairs"
           {:bindings bindings}))
  (loop [remaining bindings
         current-scope scope
         compiled []]
    (if-let [binding (first remaining)]
      (do
        (when-not (and (vector? binding) (= 2 (count binding)))
          (fail! ":let bindings must be [name expression] pairs"
                 {:binding binding}))
        (let [[name expression] binding
              name (variable-name! name "let binding")]
          (recur (next remaining)
                 (conj current-scope name)
                 (conj compiled
                       [name (compile-expression expression current-scope
                                                 (inc depth) nodes limits)]))))
      (let [run-body (compile-expression body current-scope (inc depth)
                                         nodes limits)]
        (fn [env]
          (let [next-env (reduce (fn [current [name run]]
                                   (assoc-in current [:vars name] (run current)))
                                 env compiled)]
            (run-body next-env)))))))

(defn- compile-map-form [[binding collection body :as arguments]
                         scope depth nodes limits filter?]
  (arity! (if filter? :filter :map) arguments 3 3)
  (let [binding (variable-name! binding "collection binding")
        run-collection (compile-expression collection scope (inc depth)
                                           nodes limits)
        run-body (compile-expression body (conj scope binding) (inc depth)
                                     nodes limits)]
    (fn [env]
      (let [values (vec (require-sequential! (run-collection env)
                                             (if filter? :filter :map)))
            _ (bounded-value! values (:limits env) "collection input")
            pairs (mapv (fn [value]
                          [value (run-body (assoc-in env [:vars binding] value))])
                        values)]
        (result! (if filter?
                   (mapv first (filter (comp boolean second) pairs))
                   (mapv second pairs))
                 env)))))

(defn- compile-reduce [[acc-name item-name initial collection body :as arguments]
                       scope depth nodes limits]
  (arity! :reduce arguments 5 5)
  (let [acc-name (variable-name! acc-name "reduce accumulator")
        item-name (variable-name! item-name "reduce item")
        run-initial (compile-expression initial scope (inc depth) nodes limits)
        run-collection (compile-expression collection scope (inc depth)
                                           nodes limits)
        run-body (compile-expression body (conj scope acc-name item-name)
                                     (inc depth) nodes limits)]
    (fn [env]
      (let [values (vec (require-sequential! (run-collection env) :reduce))
            _ (bounded-value! values (:limits env) "reduce input")]
        (reduce (fn [acc item]
                  (result! (run-body (-> env
                                         (assoc-in [:vars acc-name] acc)
                                         (assoc-in [:vars item-name] item)))
                           env))
                (run-initial env)
                values)))))

(defn- compile-state-operation [op arguments scope depth nodes limits]
  (let [compiled (compile-many arguments scope depth nodes limits)]
    (case op
      :state-get
      (do
        (arity! op arguments 1 2)
        (fn [env]
          (let [[key fallback] (evaluate-many compiled env)]
            (get @(:state env) key fallback))))

      :state-put
      (do
        (arity! op arguments 2 2)
        (fn [env]
          (let [[key value] (evaluate-many compiled env)]
            (when-not (or (string? key) (keyword? key))
              (fail! ":state-put key must be a string or keyword" {:key key}))
            (swap! (:state env)
                   (fn [current]
                     (bounded-value! (assoc current key value) (:limits env)
                                     "plugin state")))
            value)))

      :state-delete
      (do
        (arity! op arguments 1 1)
        (fn [env]
          (let [[key] (evaluate-many compiled env)]
            (swap! (:state env) dissoc key)
            true)))

      :state-snapshot
      (do
        (arity! op arguments 0 0)
        (fn [env] @(:state env))))))

(defn- compile-expression [expression scope depth nodes limits]
  (when (> depth (:max-depth limits))
    (fail! "Blueprint program exceeds the AST depth limit" {:depth depth}))
  (when (> (swap! nodes inc) (:max-ast-nodes limits))
    (fail! "Blueprint program exceeds the AST node limit"
           {:nodes @nodes}))
  (cond
    (map? expression) (compile-map expression scope depth nodes limits)

    (not (vector? expression))
    (do
      (bounded-value! expression limits "program literal")
      (constantly expression))

    (empty? expression)
    (fail! "Blueprint expression vectors must start with an operator" {})

    :else
    (let [[op & arguments] expression]
      (when-not (keyword? op)
        (fail! "Blueprint expression operator must be a keyword"
               {:operator op}))
      (case op
        :arg
        (do
          (arity! op arguments 1 1)
          (let [name (variable-name! (first arguments) "argument")]
            (fn [env]
              (let [args (:args env)
                    keyword-name (keyword name)]
                (if (contains? args keyword-name)
                  (get args keyword-name)
                  (get args name))))))

        :var
        (do
          (arity! op arguments 1 1)
          (let [name (variable-name! (first arguments) "variable")]
            (when-not (contains? scope name)
              (fail! (str "Unknown Blueprint variable: " name) {:name name}))
            (fn [env] (get-in env [:vars name]))))

        :literal
        (do
          (arity! op arguments 1 1)
          (bounded-value! (first arguments) limits "literal")
          (constantly (first arguments)))

        :vector
        (let [compiled (compile-many arguments scope depth nodes limits)]
          (fn [env] (result! (evaluate-many compiled env) env)))

        :if
        (do
          (arity! op arguments 3 3)
          (let [[condition then else]
                (compile-many arguments scope depth nodes limits)]
            (fn [env] ((if (condition env) then else) env))))

        :do
        (do
          (arity! op arguments 1 64)
          (let [compiled (compile-many arguments scope depth nodes limits)]
            (fn [env] (reduce (fn [_ run] (run env)) nil compiled))))

        :let (compile-let arguments scope depth nodes limits)
        :map (compile-map-form arguments scope depth nodes limits false)
        :filter (compile-map-form arguments scope depth nodes limits true)
        :reduce (compile-reduce arguments scope depth nodes limits)

        (:state-get :state-put :state-delete :state-snapshot)
        (compile-state-operation op arguments scope depth nodes limits)

        :not
        (do
          (arity! op arguments 1 1)
          (compiled-operation op (compile-many arguments scope depth nodes limits)
                              (fn [[value]] (not value))))

        :and
        (do
          (arity! op arguments 1 32)
          (let [compiled (compile-many arguments scope depth nodes limits)]
            (fn [env] (every? boolean (map #(% env) compiled)))))

        :or
        (do
          (arity! op arguments 1 32)
          (let [compiled (compile-many arguments scope depth nodes limits)]
            (fn [env] (boolean (some #(% env) compiled)))))

        (:= :not= :< :<= :> :>=)
        (do
          (arity! op arguments 2 2)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[left right]]
             (case op
               := (= left right)
               :not= (not= left right)
               :< (< (require-number! left op) (require-number! right op))
               :<= (<= (require-number! left op) (require-number! right op))
               :> (> (require-number! left op) (require-number! right op))
               :>= (>= (require-number! left op) (require-number! right op))))))

        (:+ :- :* :/ :min :max)
        (do
          (arity! op arguments (if (contains? #{:- :/} op) 1 2) 32)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [values]
             (let [numbers (mapv #(require-number! % op) values)]
               (case op
                 :+ (reduce + numbers)
                 :- (if (= 1 (count numbers)) (- (first numbers))
                        (reduce - numbers))
                 :* (reduce * numbers)
                 :/ (do
                      (when (some zero? (rest numbers))
                        (fail! "Division by zero" {:operator op}))
                      (if (= 1 (count numbers))
                        (/ 1.0 (double (first numbers)))
                        (reduce #(/ (double %1) (double %2)) numbers)))
                 :min (apply min numbers)
                 :max (apply max numbers))))))

        (:abs :count :first :last :keys :vals :distinct :sort :lower :upper :trim)
        (do
          (arity! op arguments 1 1)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[value]]
             (case op
               :abs (Math/abs (double (require-number! value op)))
               :count (count value)
               :first (first (require-sequential! value op))
               :last (last (require-sequential! value op))
               :keys (vec (keys (if (map? value) value
                                    (fail! ":keys requires a map" {:value value}))))
               :vals (vec (vals (if (map? value) value
                                    (fail! ":vals requires a map" {:value value}))))
               :distinct (vec (distinct (require-sequential! value op)))
               :sort (vec (sort (require-sequential! value op)))
               :lower (str/lower-case (require-string! value op))
               :upper (str/upper-case (require-string! value op))
               :trim (str/trim (require-string! value op))))))

        :str
        (do
          (arity! op arguments 1 32)
          (compiled-operation op (compile-many arguments scope depth nodes limits)
                              #(apply str %)))

        (:get :nth)
        (do
          (arity! op arguments 2 3)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[target key fallback]]
             (if (= op :get)
               (get target key fallback)
               (nth (vec (require-sequential! target op)) key fallback)))))

        :contains?
        (do
          (arity! op arguments 2 2)
          (compiled-operation op (compile-many arguments scope depth nodes limits)
                              (fn [[target key]] (contains? target key))))

        :assoc
        (do
          (arity! op arguments 3 3)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[target key value]]
             (assoc (if (associative? target) target
                        (fail! ":assoc requires an associative value"
                               {:value target}))
                    key value))))

        :dissoc
        (do
          (arity! op arguments 2 2)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[target key]]
             (dissoc (if (map? target) target
                         (fail! ":dissoc requires a map" {:value target})) key))))

        :merge
        (do
          (arity! op arguments 2 16)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [values]
             (when-not (every? map? values)
               (fail! ":merge requires maps" {:values values}))
             (apply merge values))))

        :conj
        (do
          (arity! op arguments 2 32)
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [[target & values]]
             (when-not (or (vector? target) (map? target))
               (fail! ":conj requires a vector or map" {:value target}))
             (apply conj target values))))

        (:join :split :replace)
        (do
          (arity! op arguments (if (= op :replace) 3 2)
                  (if (= op :replace) 3 2))
          (compiled-operation
           op (compile-many arguments scope depth nodes limits)
           (fn [values]
             (case op
               :join (let [[separator items] values]
                       (str/join (require-string! separator op)
                                 (require-sequential! items op)))
               :split (let [[value separator] values]
                        (vec (str/split (require-string! value op)
                                        (re-pattern
                                         (java.util.regex.Pattern/quote
                                          (require-string! separator op))))))
               :replace (let [[value match replacement] values]
                          (str/replace (require-string! value op)
                                       (require-string! match op)
                                       (require-string! replacement op)))))))

        (fail! (str "Unsupported Blueprint operator: " op)
               {:operator op})))))

(defn- compile-tool [tool index limits nodes]
  (when-not (map? tool)
    (fail! "Blueprint tools must be maps" {:index index}))
  (exact-keys! tool tool-keys (str "tools[" index "]"))
  (let [name (field tool :name)
        description (field tool :description)
        parameters (field tool :parameters)
        output-schema (field tool :output-schema)
        program (field tool :program)]
    (when-not (and (string? name)
                   (re-matches #"[a-z][a-z0-9_]{2,63}" name))
      (fail! "Blueprint tool name must contain 3-64 lowercase letters, digits, or underscores"
             {:index index :name name}))
    (when-not (and (string? description) (not (str/blank? description))
                   (<= (count description) 500))
      (fail! "Blueprint tool description must contain 1-500 characters"
             {:index index}))
    (validate-schema! parameters (str "tools[" index "].parameters") limits)
    (when-not (= "object" (field parameters :type))
      (fail! "Blueprint tool parameters must use an object schema"
             {:index index}))
    (when output-schema
      (validate-schema! output-schema (str "tools[" index "].output-schema")
                        limits))
    {:name name
     :description description
     :parameters parameters
     :output-schema output-schema
     :run (compile-expression program #{} 0 nodes limits)}))

(defn parse-blueprint
  "Parse and compile one bounded EDN Blueprint source string."
  ([source] (parse-blueprint source default-limits))
  ([source limits]
   (let [limits (normalize-limits limits)]
     (when-not (string? source)
       (fail! "Blueprint source must be an EDN string" {}))
     (when (or (str/blank? source)
               (> (count source) (:max-source-chars limits)))
       (fail! "Blueprint source is blank or exceeds its configured limit"
              {:max-source-chars (:max-source-chars limits)}))
     (let [blueprint (try
                       (edn/read-string
                        {:readers {}
                         :default (fn [tag _]
                                    (fail! "Tagged literals are not supported"
                                           {:tag tag}))}
                        source)
                       (catch clojure.lang.ExceptionInfo error (throw error))
                       (catch Throwable error
                         (fail! (str "Blueprint EDN could not be parsed: "
                                     (ex-message error)) {})))]
       (when-not (map? blueprint)
         (fail! "Blueprint source must contain a map" {}))
       (exact-keys! blueprint blueprint-keys "blueprint")
       (let [description (field blueprint :description)
             initial-state (or (field blueprint :initial-state) {})
             tools (field blueprint :tools)
             nodes (atom 0)]
         (when-not (and (string? description) (not (str/blank? description))
                        (<= (count description) 500))
           (fail! "Blueprint :description must contain 1-500 characters" {}))
         (when-not (map? initial-state)
           (fail! "Blueprint :initial-state must be a map" {}))
         (bounded-value! initial-state limits "initial-state")
         (when-not (and (vector? tools) (seq tools)
                        (<= (count tools) (:max-tools limits)))
           (fail! "Blueprint :tools must be a non-empty bounded vector"
                  {:max-tools (:max-tools limits)}))
         (let [compiled-tools (mapv #(compile-tool %1 %2 limits nodes)
                                    tools (range))
               duplicate (->> compiled-tools (map :name) frequencies
                              (some (fn [[name count]] (when (> count 1) name))))]
           (when duplicate
             (fail! (str "Blueprint contains duplicate tool: " duplicate)
                    {:tool duplicate}))
           {:description description
            :initial-state initial-state
            :tools compiled-tools
            :limits limits
            :ast-nodes @nodes}))))))

(defn public-summary [blueprint]
  {:description (:description blueprint)
   :tools (mapv #(select-keys % [:name :description :parameters :output-schema])
                (:tools blueprint))
   :ast-nodes (:ast-nodes blueprint)})

(defn install!
  "Register a compiled Blueprint as one reversible Kernel plugin."
  [ctx owner blueprint state]
  (let [plugin-ctx (kernel/plugin-context ctx owner)]
    (try
      (doseq [{:keys [run output-schema] :as tool} (:tools blueprint)]
        (kernel/register-tool!
         plugin-ctx
         (cond-> {:name (:name tool)
                  :description (:description tool)
                  :parameters (:parameters tool)
                  :strict true
                  :execution-mode :sequential
                  :execute (fn [arguments execution]
                             (bounded-value! arguments (:limits blueprint)
                                             "tool arguments")
                             (let [draft (atom @state)
                                   env {:args arguments
                                        :execution execution
                                        :state draft
                                        :vars {}
                                        :limits (:limits blueprint)}
                                   value (result! (run env) env)
                                   _ (when output-schema
                                       (schema/validate!
                                        output-schema value
                                        "Blueprint tool returned invalid output"))
                                   next-state (bounded-value!
                                               @draft (:limits blueprint)
                                               "plugin state")]
                               ;; Generated tools are sequential. Commit their
                               ;; draft only after the program and output
                               ;; schema both succeed, so failures are atomic.
                               (reset! state next-state)
                               value))}
           (:output-schema tool) (assoc :output-schema (:output-schema tool)))))
      (kernel/mark-loaded!
       ctx {:id owner
            :namespace 'agent.runtime-blueprint
            :description (:description blueprint)})
      {:id owner}
      (catch Throwable error
        (kernel/dispose-plugin! ctx owner)
        (throw error)))))
