(ns qi.plugins.lsp-tools
  "Model and user-facing adapters for the read-only LSP runtime."
  (:require [qi.kernel :as kernel]
            [clojure.string :as str]))

(def ^:private actions
  ["status" "capabilities" "diagnostics" "definition" "references"
   "hover" "document_symbols" "workspace_symbols" "implementation"
   "type_definition"])

(defn- render-location [{:keys [path uri external range]}]
  (let [start (:start range)]
    (str (or path uri "unknown")
         (when start (str ":" (:line start) ":" (:column start)))
         (when external " [external]"))))

(defn- render-result [_ result]
  (cond
    (:locations result)
    (if (seq (:locations result))
      (str/join "\n" (map render-location (:locations result)))
      "No locations found.")

    (contains? result :items)
    (if (seq (:items result))
      (str/join "\n" (map pr-str (:items result)))
      "No results.")

    (:hover result) (if-let [hover (:hover result)] (pr-str hover) "No hover information.")
    :else (pr-str result)))

(def plugin
  {:id :tools/lsp
   :description "Read-only semantic code navigation backed by configured LSP servers."
   :requires #{:lsp/runtime}
   :start
   (fn [ctx _config]
     (let [runtime (kernel/require-service ctx :lsp/runtime)]
       (kernel/register-tool!
        ctx
        {:name "lsp_query"
         :description
         (str "Query a configured Language Server for semantic code intelligence. "
              "Use status to inspect server availability. File actions lazily start "
              "the nearest project server and synchronize current text first. "
              "For definition, references, hover, implementation, and type_definition, "
              "provide a 1-based line and the exact symbol text on that line; occurrence "
              "selects repeated symbols. This tool is read-only.")
         :parameters
         {:type "object"
          :required ["action"]
          :properties
          {"action" {:type "string" :enum actions}
           "file" {:type "string"
                   :description "Workspace-relative source file. Required except for status."}
           "line" {:type "integer" :minimum 1
                   :description "1-based line for position queries."}
           "symbol" {:type "string"
                     :description "Exact symbol text on the requested line."}
           "occurrence" {:type "integer" :minimum 1 :default 1}
           "query" {:type "string"
                    :description "Workspace symbol search text."}
           "timeout_ms" {:type "integer" :minimum 1
                         :description "Optional per-request timeout."}}
          :additionalProperties false}
         :output-schema {:type "object"}
         :execute (fn [arguments execution]
                    ((:query! runtime) arguments execution))
         :render render-result})
       (kernel/register-command!
        ctx
        {:name "lsp"
         :description "Show LSP status or restart active language servers."
         :execute
         (fn [argument _execution]
           (case (str/lower-case (str/trim argument))
             "" ((:status runtime))
             "status" ((:status runtime))
             "reload" ((:reload! runtime))
             {:error "Usage: /lsp [status|reload]"}))}))
     nil)})
