(ns agent.plugins.clojure-repl
  "Model-facing Clojure tool backed by the configured execution REPL."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(defn- render-result [_ result]
  (str/join
   "\n"
   (remove
    str/blank?
    [(when-not (str/blank? (:stdout result))
       (str "stdout:\n" (:stdout result)))
     (when-not (str/blank? (:stderr result))
       (str "stderr:\n" (:stderr result)))
     (if (:ok result)
       (str "value:\n" (:value result))
       (str "error:\n" (:error result)))
     (when (:truncated result) "[output truncated]")])))

(def plugin
  {:id :tools/clojure-repl
   :description "Clojure evaluation tool using the configured REPL backend."
   :requires #{:execution/repl}
   :start
   (fn [ctx _config]
     (let [repl (kernel/require-service ctx :execution/repl)]
       (when (not= false (:available? repl))
         (kernel/register-tool!
          ctx
          {:name "bb_repl"
           :description
           (str "Evaluate Clojure in this agent's persistent "
                (case (:backend repl)
                  :jvm-clojure "native JVM Clojure"
                  :babashka "Babashka"
                  "Clojure")
                " REPL. Definitions "
                "remain available to later calls in this agent process. Use it "
                "for exact calculations and Clojure data transformations.")
           :parameters {:type "object"
                        :required ["code"]
                        :properties {"code" {:type "string"}}
                        :additionalProperties false}
           :output-schema
           {:type "object"
            :required ["ok" "backend" "namespace" "stdout" "stderr"
                       "truncated" "duration_ms"]
            :properties
            {"ok" {:type "boolean"}
             "backend" {:type "string"}
             "namespace" {:type "string"}
             "value" {:type "string"}
             "stdout" {:type "string"}
             "stderr" {:type "string"}
             "error" {:type "string"}
             "truncated" {:type "boolean"}
             "duration_ms" {:type "integer"}}
            :additionalProperties false}
           :execute (fn [{:keys [code]} _execution]
                      ((:eval! repl) code))
           :render render-result})))
     nil)})
