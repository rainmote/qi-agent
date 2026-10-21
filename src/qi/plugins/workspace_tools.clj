(ns qi.plugins.workspace-tools
  "Pinned desktop Office assets through the existing ExecutionWorld and gates."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [qi.kernel :as kernel]
            [qi.workspace-runtime :as runtime]))

(defn quote-argument [value]
  (str "'" (str/replace (str value) "'" "'\\''") "'"))

(def plugin
  {:id :tools/workspace-runtime
   :requires #{:execution/world :tool/policy :project/trust}
   :start
   (fn [ctx _]
     (let [world (kernel/require-service ctx :execution/world)]
       (when (and (get-in world [:workspace-runtime :available?]) (contains? (:capabilities world) :process))
         (kernel/register-tool!
          ctx {:name "office_preview"
               :description "Convert an authorized workspace Office document to a new PDF using the pinned native engine. Input stays unchanged, existing outputs are never replaced; no host runtime or WASM fallback."
               :parameters {:type "object" :additionalProperties false :required ["path" "output"]
                            :properties {:path {:type "string" :minLength 1 :maxLength 4096}
                                         :output {:type "string" :minLength 1 :maxLength 4096}}}
               :requires-trust true :requires-approval true :execution-mode :sequential
               :uncertain-on-cancel true :stop-batch-on-error true
               :execute (fn [{:keys [path output]} execution]
                          (let [trust (kernel/require-service ctx :project/trust)
                                _ (kernel/require-service ctx :tool/policy)
                                _ (when-not ((:trusted? trust)) (throw (ex-info "Office conversion requires a trusted project" {})))
                                assets (runtime/describe)
                                _ (when-not (:available? assets) (throw (ex-info (:reason assets) {})))
                                source ((:resolve! world) path)
                                destination ((:resolve-write! world) output)
                                _ (when (fs/exists? destination) (throw (ex-info "Office output already exists" {})))
                                command (str/join " " (map quote-argument [(:node assets) (:office-helper assets) (:root world) source destination]))
                                result ((:spawn! world) {:command command :cwd "." :timeout-ms 30000 :cancel-token (:cancel-token execution)})]
                            (when-not (zero? (:exit-code result)) (throw (ex-info "Office conversion failed or outcome is unconfirmed; inspect output before retry" {:uncertain true})))
                            (json/parse-string (str/trim (:stdout result)) true)))})))
     nil)})
