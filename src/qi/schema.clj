(ns qi.schema
  "JSON-Schema boundary validator used by model-facing tools."
  (:require [clojure.set :as set]
            [clojure.string :as str]))

(defn- field [m k]
  (if (contains? m k) (get m k) (get m (name k))))

(defn- value-at [m property]
  (let [keyword-key (keyword property)]
    (if (contains? m keyword-key) (get m keyword-key) (get m property))))

(defn- present? [m property]
  (or (contains? m property) (contains? m (keyword property))))

(defn- one-type? [expected value]
  (case expected
    "object" (map? value)
    "array" (sequential? value)
    "string" (string? value)
    "number" (number? value)
    "integer" (integer? value)
    "boolean" (instance? Boolean value)
    "null" (nil? value)
    true))

(defn- json-type? [expected value]
  (if (sequential? expected)
    (boolean (some #(one-type? % value) expected))
    (one-type? expected value)))

(declare errors)

(defn- object-errors [schema value path]
  (if-not (map? value)
    []
    (let [properties (or (field schema :properties) {})
          required (set (map name (or (field schema :required) [])))
          property-names (set (map (comp name key) properties))
          value-names (set (map (comp name key) value))
          missing (set/difference required value-names)
          unknown (when (false? (field schema :additionalProperties))
                    (set/difference value-names property-names))
          size (count value)]
      (vec
       (concat
        (map #(str path "." % " is required") (sort missing))
        (map #(str path "." % " is not allowed") (sort unknown))
        (when-let [minimum (field schema :minProperties)]
          (when (< size minimum)
            [(str path " must have at least " minimum " properties")]))
        (when-let [maximum (field schema :maxProperties)]
          (when (> size maximum)
            [(str path " must have at most " maximum " properties")]))
        (mapcat (fn [[property property-schema]]
                  (let [property-name (name property)]
                    (when (present? value property-name)
                      (errors property-schema
                              (value-at value property-name)
                              (str path "." property-name)))))
                properties))))))

(defn- array-errors [schema value path]
  (if-not (sequential? value)
    []
    (let [items (field schema :items)
          size (count value)]
      (vec
       (concat
        (when (and items (map? items))
          (mapcat (fn [[index item]]
                    (errors items item (str path "[" index "]")))
                  (map-indexed vector value)))
        (when-let [minimum (field schema :minItems)]
          (when (< size minimum)
            [(str path " must have at least " minimum " items")]))
        (when-let [maximum (field schema :maxItems)]
          (when (> size maximum)
            [(str path " must have at most " maximum " items")]))
        (when (and (true? (field schema :uniqueItems))
                   (not= size (count (distinct value))))
          [(str path " items must be unique")]))))))

(defn- string-errors [schema value path]
  (if-not (string? value)
    []
    (concat
     (when-let [minimum (field schema :minLength)]
       (when (< (count value) minimum)
         [(str path " is shorter than " minimum)]))
     (when-let [maximum (field schema :maxLength)]
       (when (> (count value) maximum)
         [(str path " is longer than " maximum)]))
     (when-let [pattern (field schema :pattern)]
       (when-not (re-find (re-pattern pattern) value)
         [(str path " does not match " pattern)]))
     (case (field schema :format)
       "email" (when-not (re-matches #"[^@\s]+@[^@\s]+\.[^@\s]+" value)
                 [(str path " must be an email")])
       "uri" (try
               (java.net.URI. value)
               []
               (catch Throwable _ [(str path " must be a URI")]))
       "date-time" (try
                     (java.time.OffsetDateTime/parse value)
                     []
                     (catch Throwable _ [(str path " must be a date-time")]))
       []))))

(defn- number-errors [schema value path]
  (if-not (number? value)
    []
    (concat
     (when-let [minimum (field schema :minimum)]
       (when (< value minimum) [(str path " must be >= " minimum)]))
     (when-let [maximum (field schema :maximum)]
       (when (> value maximum) [(str path " must be <= " maximum)]))
     (when-let [minimum (field schema :exclusiveMinimum)]
       (when (<= value minimum) [(str path " must be > " minimum)]))
     (when-let [maximum (field schema :exclusiveMaximum)]
       (when (>= value maximum) [(str path " must be < " maximum)]))
     (when-let [divisor (field schema :multipleOf)]
       (when-not (zero? (mod value divisor))
         [(str path " must be a multiple of " divisor)])))))

(defn- combination-errors [schema value path]
  (let [one-of (field schema :oneOf)
        any-of (field schema :anyOf)
        all-of (field schema :allOf)
        one-count (when one-of
                    (count (filter empty? (map #(errors % value path) one-of))))]
    (concat
     (when (and one-of (not= 1 one-count))
       [(str path " must match exactly one oneOf schema")])
     (when (and any-of (not-any? empty? (map #(errors % value path) any-of)))
       [(str path " must match at least one anyOf schema")])
     (when all-of (mapcat #(errors % value path) all-of)))))

(defn errors
  ([schema value] (errors schema value "$"))
  ([schema value path]
   (let [expected (field schema :type)
         enum-values (field schema :enum)
         nullable? (true? (field schema :nullable))
         type-valid? (or (and nullable? (nil? value))
                         (json-type? expected value))]
     (vec
      (concat
       (when-not type-valid?
         [(str path " must be " expected)])
       (when (and (or (contains? schema :const)
                      (contains? schema "const"))
                  (not= value (field schema :const)))
         [(str path " must equal " (pr-str (field schema :const)))])
       (when (and enum-values (not (some #{value} enum-values)))
         [(str path " must be one of " (pr-str enum-values))])
       (when type-valid?
         (concat
          (combination-errors schema value path)
          (cond
            (map? value) (object-errors schema value path)
            (sequential? value) (array-errors schema value path)
            (string? value) (string-errors schema value path)
            (number? value) (number-errors schema value path)
            :else []))))))))

(defn validate!
  ([schema value] (validate! schema value "Schema validation failed"))
  ([schema value message]
   (let [problems (errors schema value)]
     (when (seq problems)
       (throw (ex-info message {:errors problems :value value})))
     value)))
