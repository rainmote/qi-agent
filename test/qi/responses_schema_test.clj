(ns qi.responses-schema-test
  (:require [babashka.fs :as fs]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.test :refer [deftest is testing]]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.runtime-blueprint :as blueprint]
            [qi.schema :as schema]))

(def optional-schema
  {:type "object" :additionalProperties false
   :properties {:options {:type "object" :additionalProperties false
                         :properties {:label {:type "string"}}}}})

(deftest responses-preserve-optional-tool-arguments-on-the-wire
  (doseq [provider ['qi.plugins.openai-responses 'qi.plugins.chatgpt]]
    (testing (str provider)
      (let [root (fs/real-path (fs/create-temp-dir {:prefix "qi-responses-schema-"}))
            auth-file (str (fs/path root "auth.json"))
            captured (atom nil)]
        (try
          (spit auth-file (json/generate-string
                          {:auth_mode "chatgpt"
                           :tokens {:access_token "fixture-token" :account_id "fixture-account"}}))
          (with-redefs [http/post
                        (fn [_ options]
                          (reset! captured (json/parse-string (:body options) true))
                          {:status 200
                           :body (str "data: " (json/generate-string
                                                {:type "response.completed"
                                                 :response {:id "fixture-response" :status "completed"
                                                            :output [{:type "message" :role "assistant"
                                                                      :content [{:type "output_text" :text "ok"}]}]}})
                                      "\n\n")})]
            (let [ctx (plugin/boot!
                       {:plugins
                        [{:ns provider :config {:api-key "fixture-key" :auth-file auth-file
                                                :check-permissions false :model "gpt-5.6-sol"}}
                         {:ns 'qi.plugins.plugin-manager :config {:user-dir (str (fs/path root "packages"))}}
                         {:ns 'qi.plugins.runtime-inspect}
                         {:ns 'qi.plugins.runtime-lab}
                         {:ns 'qi.plugins.presets :config {:system-roots [] :user-root (str (fs/path root "presets"))}}
                         {:ns 'qi.plugins.preset-author}]})]
              (try
                (blueprint/install!
                 ctx :fixture/blueprint
                 (blueprint/parse-blueprint
                  (pr-str {:description "Nested optional argument fixture"
                           :tools [{:name "optional_blueprint" :description "Return a constant"
                                    :parameters optional-schema :program [:literal "ok"]}]}))
                 (atom {}))
                (let [tool-ctx (kernel/plugin-context ctx :fixture/tools)]
                  (doseq [[name strict] [["default_tool" nil] ["explicit_tool" false]]]
                    (kernel/register-tool!
                     tool-ctx (cond-> {:name name :description name :parameters optional-schema
                                      :execute (fn [_ _] "ok")}
                                (some? strict) (assoc :strict strict)))))
                (let [tools (kernel/tool-schemas ctx)
                      generate (kernel/require-service ctx :llm/generate)]
                  (is (= "ok" (get-in (generate {:system-prompt "fixture" :messages [{:role "user" :content "hello"}]
                                                :tools tools}) [:message :content])))
                  (let [wire (into {} (map (juxt :name identity) (:tools @captured)))]
                    ;; These real tools intentionally allow omitted fields. Requiring
                    ;; nullable placeholders would change local argument semantics.
                    (doseq [name ["plugin_manage" "runtime_inspect" "runtime_plugin"
                                  "preset_inspect" "preset_author" "optional_blueprint"
                                  "default_tool" "explicit_tool"]]
                      (is (false? (:strict (wire name))) name))
                    (is (true? (:strict (wire "preset_guide"))) "Explicit compatible strict schema stays strict")
                    (is (= [] (get-in wire ["preset_guide" :parameters :required])))
                    (doseq [tool tools]
                      (is (= (json/parse-string (json/generate-string (get-in tool [:function :parameters])) true)
                             (:parameters (wire (get-in tool [:function :name]))))
                          "Wire encoding must not rewrite required fields, types or nested properties"))
                    (let [parameters (:parameters (wire "plugin_manage"))]
                      (is (empty? (schema/errors parameters {:action "list"})))
                      (is (seq (schema/errors parameters {:action "list" :id nil})))
                      (is (seq (schema/errors parameters {:id "missing-action"})))
                      (is (seq (schema/errors parameters {:action "list" :unknown true}))))))
                (finally (kernel/dispose-all! ctx)))))
          (finally (fs/delete-tree root)))))))
