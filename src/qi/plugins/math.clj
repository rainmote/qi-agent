(ns qi.plugins.math
  "Built-in offline arithmetic tool used by the mock example."
  (:require [qi.kernel :as kernel]))

(def plugin
  {:id :tools/math
   :description "Deterministic arithmetic tool."
   :start
   (fn [ctx _]
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
       :execute
       (fn [{:keys [operation a b]} _]
         {:result
          (case operation
            "add" (+ a b)
            "subtract" (- a b)
            "multiply" (* a b)
            "divide" (if (zero? b)
                       (throw (ex-info "Division by zero" {}))
                       (/ (double a) (double b))))})})
     nil)})
