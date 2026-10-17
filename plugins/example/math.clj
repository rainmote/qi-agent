(ns example.math
  "An out-of-tree plugin: its namespace lives on the `plugins/` classpath."
  (:require [qi.kernel :as kernel]))

(defn- calculate [{:keys [operation a b]}]
  (case operation
    "add" (+ a b)
    "subtract" (- a b)
    "multiply" (* a b)
    "divide" (if (zero? b)
               (throw (ex-info "Division by zero" {}))
               (/ (double a) (double b)))))

(def plugin
  {:id :tools/example-math
   :description "Example external arithmetic tool plugin."
   :start
   (fn [ctx _config]
     (kernel/register-tool!
      ctx
      {:name "calculate"
       :description "Perform one arithmetic operation on two numbers."
       :parameters {:type "object"
                    :required ["operation" "a" "b"]
                    :properties {"operation" {:type "string"
                                               :enum ["add" "subtract"
                                                      "multiply" "divide"]}
                                 "a" {:type "number"}
                                 "b" {:type "number"}}
                    :additionalProperties false}
       :output-schema {:type "object"
                       :required ["result"]
                       :properties {"result" {:type "number"}}
                       :additionalProperties false}
       :execute (fn [arguments _execution]
                  {:result (calculate arguments)})})
     nil)})
