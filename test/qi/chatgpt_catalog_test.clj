(ns qi.chatgpt-catalog-test
  (:require [babashka.fs :as fs]
         [babashka.http-client :as http]
         [cheshire.core :as json]
         [clojure.java.io :as io]
         [clojure.test :refer [deftest is testing run-tests]]
         [qi.kernel :as kernel]
         [qi.plugin :as plugin]
         [qi.plugins.auth-store]
         [qi.plugins.chatgpt]
         [qi.plugins.model-registry]
         [qi.plugins.provider-settings]))

(def model-a
  {:id "catalog-fixture-a" :name "Catalog fixture A"
   :contextWindow 500000 :thinkingLevels ["low" "high"]
   :defaultThinkingLevel "low"})

(def model-b
  {:id "catalog-fixture-b" :name "Catalog fixture B"
   :contextWindow 272000 :thinkingLevels ["none" "minimal" "xhigh" "max"]
   :defaultThinkingLevel "xhigh"})

(def expected-auth
  {:access-token "fixture-only-access-token"
   :account-id "fixture-only-account"})

(defn write-owner-json! [file value]
  (spit file (str (json/generate-string value) "\n"))
  (fs/set-posix-file-permissions file "rw-------"))

(defn write-catalog! [file models]
  (write-owner-json!
   file
   {:version 1
    :providers [{:id "chatgpt" :name "ChatGPT subscription fixture"
                 :protocol "chatgpt-subscription"
                 :baseUrl "https://chatgpt.com/backend-api/codex"
                 :models models}]}))

(defn model-by-name [registry name]
  (some #(when (= name (:model %)) %) ((:providers registry))))

(defn fake-completion [model]
  (json/generate-string
   {:id "fixture-response" :status "completed" :model model
    :output [{:id "fixture-message" :type "message" :role "assistant"
              :content [{:type "output_text" :text "fixture ok"}]}]
    :usage {:input_tokens 2 :output_tokens 2 :total_tokens 4}}))

(deftest subscription-catalog-controls-runtime-and-preserves-auth
  (let [directory (fs/create-temp-dir {:prefix "qi-chatgpt-catalog-regression-"})
        auth-file (io/file (str directory) "auth.json")
        settings-file (io/file (str directory) "providers.json")
        requests (atom [])]
    (try
      (write-owner-json!
       auth-file
       {:auth_mode "chatgpt"
        :tokens {:access_token (:access-token expected-auth)
                 :account_id (:account-id expected-auth)
                 :refresh_token "fixture-refresh-never-resolved"}})
      (write-catalog! settings-file [model-a model-b])
      (with-redefs
       [http/get (fn [& _] (throw (ex-info "Fixture forbids network GET" {})))
        http/post
        (fn [url options]
          (let [body (json/parse-string (:body options) true)]
            (swap! requests conj {:url url :headers (:headers options)
                                  :timeout (:timeout options) :version (:version options)
                                  :body body})
            {:status 200 :body (fake-completion (:model body))}))]
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'qi.plugins.model-registry :config {:default-provider :chatgpt}}
                     {:ns 'qi.plugins.auth-store}
                     {:ns 'qi.plugins.chatgpt
                      :config {:model (:id model-a)
                               :auth-file (str auth-file)
                               :timeout-ms 43210
                               :http-version :http1.1
                               :transport-retries 0
                               :extra-body {:reasoning {:effort "medium"}}}}
                     {:ns 'qi.plugins.provider-settings
                      :config {:path (str settings-file)}}]})]
          (try
            (let [registry (kernel/require-service ctx :llm/registry)
                  auth (kernel/require-service ctx :auth/store)
                  settings (kernel/require-service ctx :provider/settings)
                  entries ((:providers registry))
                  second-model (model-by-name registry (:id model-b))]
              (testing "Both catalog models become distinct selectable subscription entries"
                (is (= #{(:id model-a) (:id model-b)} (set (map :model entries))))
                (is (= 2 (count entries)))
                (is (= :chatgpt-subscription (:provider second-model)))
                (is (= "Catalog fixture B" (:display-name second-model)))
                (is (= 272000 (:context-window second-model)))
                (is (= [:none :minimal :xhigh :max] (:thinking-levels second-model)))
                (is (= :xhigh (:default-thinking-level second-model)))
                (is (= expected-auth ((:resolve! auth) :chatgpt)))
                (is (= :codex-auth-cache (:source (first ((:providers auth)))))))

              ;; On the old source the meaningful model/metadata assertions above
              ;; fail. Dependent operations are guarded so absence is not hidden by
              ;; an unrelated "provider not registered" error.
              (when second-model
                (testing "Selecting the second model honors its catalog default"
                  (let [selected ((:select! registry) (:id second-model))]
                    (is (= (:id model-b) (:model selected)))
                    (is (= :xhigh (:thinking-level selected)))))
                (testing "Generation uses the selected subscription model and reasoning"
                  ((:select-thinking! registry) :max)
                  (let [response ((:generate registry)
                                  {:system-prompt "Fixture-only system prompt"
                                   :messages [{:role "user" :content "Fixture request"}]
                                   :tools []})
                        request (first @requests)]
                    (is (= 1 (count @requests)))
                    (is (= "https://chatgpt.com/backend-api/codex/responses" (:url request)))
                    (is (= (:id model-b) (get-in request [:body :model])))
                    (is (= "max" (get-in request [:body :reasoning :effort])))
                    (is (= "Bearer fixture-only-access-token" (get-in request [:headers "authorization"])))
                    (is (= "fixture-only-account" (get-in request [:headers "chatgpt-account-id"])))
                    (is (= 43210 (:timeout request)) "catalog reconciliation preserves profile transport timeout")
                    (is (= :http1.1 (:version request)))
                    (is (= "fixture ok" (get-in response [:message :content])))))
                (testing "Catalog reload preserves selection and supported effort by model identity"
                  (write-catalog! settings-file
                                  [(assoc model-b :name "Catalog fixture B refreshed"
                                          :contextWindow 400000
                                          :thinkingLevels ["minimal" "max"]
                                          :defaultThinkingLevel "minimal")
                                   model-a])
                  (let [report ((:reload! settings))
                        selected ((:current registry))]
                    (is (= 2 (:models report)))
                    (is (= (:id model-b) (:model selected)))
                    (is (= (:id second-model) (:id selected)))
                    (is (= 400000 (:context-window selected)))
                    (is (= "Catalog fixture B refreshed" (:display-name selected)))
                    (is (= :max (:thinking-level selected)))
                    (is (= :minimal (:default-thinking-level selected)))
                    (is (= expected-auth ((:resolve! auth) :chatgpt)))))
                (testing "Unsupported prior effort falls back to the new model default"
                  (write-catalog! settings-file
                                  [model-a (assoc model-b
                                                  :thinkingLevels ["minimal" "xhigh"]
                                                  :defaultThinkingLevel "minimal")])
                  (let [report ((:reload! settings))
                        selected ((:current registry))]
                    (is (= (:id model-b) (:model selected)))
                    (is (= :minimal (:thinking-level selected)))
                    (is (seq (:warnings report)))
                    (is (= expected-auth ((:resolve! auth) :chatgpt)))))
                (testing "No discovery, inference replay or credential mutation during reload"
                  (is (= 1 (count @requests)))
                  (is (= "fixture-refresh-never-resolved"
                         (get-in (json/parse-string (slurp auth-file) true)
                                 [:tokens :refresh_token]))))))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree directory)))))

(defn write-json! [file value]
  (spit file (json/generate-string value))
  (fs/set-posix-file-permissions file "rw-------"))

(deftest catalog-without-supported-effort-does-not-invent-reasoning
  (let [directory (fs/create-temp-dir {:prefix "qi-catalog-no-reasoning-"})
        auth-file (io/file (str directory) "auth.json")
        settings-file (io/file (str directory) "providers.json")
        posts (atom [])]
    (try
      (write-json! auth-file {:auth_mode "chatgpt"
                              :tokens {:access_token "fixture-no-reasoning-token"
                                       :account_id "fixture-no-reasoning-account"}})
      (write-json! settings-file
                   {:version 1
                    :providers [{:id "chatgpt" :name "ChatGPT fixture"
                                 :protocol "chatgpt-subscription"
                                 :baseUrl "https://chatgpt.com/backend-api/codex"
                                 :models [{:id "fixture-empty-efforts" :name "Filtered empty efforts"
                                           :thinkingLevels []}
                                          {:id "fixture-omitted-efforts" :name "Omitted effort metadata"}]}]})
      (with-redefs
       [http/get (fn [& _] (throw (ex-info "Fixture forbids network GET" {})))
        http/post (fn [_ options]
                    (let [body (json/parse-string (:body options) true)]
                      (swap! posts conj body)
                      {:status 200 :body (json/generate-string
                                          {:id "fixture-response" :status "completed" :model (:model body)
                                           :output [{:id "fixture-message" :type "message" :role "assistant"
                                                     :content [{:type "output_text" :text "fixture ok"}]}]})}))]
        (let [ctx (plugin/boot!
                   {:plugins [{:ns 'qi.plugins.model-registry :config {:default-provider :chatgpt}}
                              {:ns 'qi.plugins.auth-store}
                              {:ns 'qi.plugins.chatgpt
                               :config {:model "fixture-empty-efforts" :auth-file (str auth-file)
                                        :transport-retries 0
                                        :extra-body {:reasoning {:effort "medium" :summary "auto"}
                                                     :text {:verbosity "low"}}}}
                              {:ns 'qi.plugins.provider-settings :config {:path (str settings-file)}}]})]
          (try
            (let [registry (kernel/require-service ctx :llm/registry)]
              (is (= 2 (count ((:providers registry)))))
              (doseq [model ["fixture-empty-efforts" "fixture-omitted-efforts"]]
                (testing model
                  (let [entry (some #(when (= model (:model %)) %) ((:providers registry)))]
                    (is (some? entry))
                    (when entry
                      ((:select! registry) (:id entry))
                      (is (= [] (:thinking-levels entry)))
                      (is (nil? (:default-thinking-level entry)))
                      (is (nil? (:thinking-level ((:current registry)))))
                      ((:generate registry) {:system-prompt "Fixture" :messages [{:role "user" :content "fixture"}] :tools []})
                      (is (= model (:model (last @posts))))
                      (is (not (contains? (last @posts) :reasoning))
                          "no supported effort means no inherited profile reasoning request")
                      (is (= {:verbosity "low"} (:text (last @posts)))
                          "unrelated profile request options remain intact")))))
              (is (= 2 (count @posts))))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree directory)))))

(def vectors (json/parse-string (slurp "test/fixtures/chatgpt-identity-vectors.json") true))
(def identity-fn (ns-resolve 'qi.plugins.chatgpt 'auth-identity))

(deftest runtime-identity-matches-shared-cross-language-vectors
  (is (some? identity-fn) "runtime exposes the private identity implementation for fixture review")
  (when identity-fn
    (doseq [vector vectors]
      (is (= (:identity vector)
             (identity-fn {:access-token (:accessToken vector)
                           :account-id (:accountId vector)}))
          (:name vector)))))

(defn write-auth! [file vector]
  (write-json! file {:auth_mode "chatgpt"
                     :tokens {:access_token (:accessToken vector)
                              :account_id (:accountId vector)}}))

(defn catalog-model [id]
  {:id id :name id :contextWindow 272000
   :thinkingLevels ["low" "xhigh"] :defaultThinkingLevel "low"})

(defn write-identity-catalog! [file identity models]
  (write-json! file {:version 1 :chatGptCatalogIdentity identity
                     :providers [{:id "chatgpt" :name "ChatGPT fixture"
                                  :protocol "chatgpt-subscription"
                                  :baseUrl "https://chatgpt.com/backend-api/codex"
                                  :models models}]}))

(def request {:system-prompt "Fixture only" :messages [{:role "user" :content "fixture"}] :tools []})

(deftest account-change-blocks-old-catalog-before-dispatch-and-reconciles-reload
  (let [directory (fs/create-temp-dir {:prefix "qi-catalog-account-isolation-"})
        auth-file (io/file (str directory) "auth.json")
        settings-file (io/file (str directory) "providers.json")
        account-a (first vectors)
        account-b (second vectors)
        posts (atom [])]
    (try
      (write-auth! auth-file account-a)
      (write-identity-catalog! settings-file (:identity account-a)
                      [(catalog-model "fixture-a-one") (catalog-model "fixture-a-two")])
      (with-redefs
       [http/get (fn [& _] (throw (ex-info "Fixture forbids network GET" {})))
        http/post (fn [url options]
                    (let [body (json/parse-string (:body options) true)]
                      (swap! posts conj {:url url :headers (:headers options) :body body})
                      {:status 200 :body (json/generate-string
                                          {:id "fixture-response" :status "completed" :model (:model body)
                                           :output [{:id "fixture-message" :type "message" :role "assistant"
                                                     :content [{:type "output_text" :text "fixture ok"}]}]})}))]
        (let [ctx (plugin/boot!
                   {:plugins [{:ns 'qi.plugins.model-registry :config {:default-provider :chatgpt}}
                              {:ns 'qi.plugins.auth-store}
                              {:ns 'qi.plugins.chatgpt :config {:model "fixture-a-one"
                                                              :auth-file (str auth-file)
                                                              :transport-retries 0}}
                              {:ns 'qi.plugins.provider-settings :config {:path (str settings-file)}}]})]
          (try
            (let [registry (kernel/require-service ctx :llm/registry)
                  auth (kernel/require-service ctx :auth/store)
                  settings (kernel/require-service ctx :provider/settings)
                  original (some #(when (= "fixture-a-two" (:model %)) %) ((:providers registry)))]
              (is (= ["fixture-a-one" "fixture-a-two"] (mapv :model ((:providers registry)))))
              (is (some? original))
              (when original
                ((:select! registry) (:id original))
                ((:generate registry) request)
                (is (= 1 (count @posts)))
                (is (= "fixture-a-two" (get-in (first @posts) [:body :model])))
                (write-auth! auth-file account-b)
                (testing "Same workspace account but changed JWT subject invalidates catalog"
                  (let [outcome (try ((:generate registry) request) :sent
                                     (catch clojure.lang.ExceptionInfo error
                                       {:code (:code (ex-data error)) :message (ex-message error)}))]
                    (is (= :catalog-account-changed (:code outcome)))
                    (is (= 1 (count @posts)) "reject before any HTTP POST")
                    (is (not (.contains (str outcome) (:accessToken account-a))))
                    (is (not (.contains (str outcome) (:accessToken account-b))))
                    (is (= {:access-token (:accessToken account-b) :account-id (:accountId account-b)}
                           ((:resolve! auth) :chatgpt)))))
                (testing "Reload removes old account's models, including original built-in alias"
                  ((:reload! settings))
                  (is (empty? ((:providers registry))))
                  (is (nil? ((:current registry))))
                  (is (= :codex-auth-cache (:source (first ((:providers auth))))))
                  (is (= 1 (count @posts))))
                (testing "Fresh matching catalog restores only the new account's models"
                  (write-identity-catalog! settings-file (:identity account-b) [(catalog-model "fixture-b-one")])
                  ((:reload! settings))
                  (is (= ["fixture-b-one"] (mapv :model ((:providers registry)))))
                  (is (= "fixture-b-one" (:model ((:current registry)))))
                  ((:generate registry) request)
                  (is (= 2 (count @posts)))
                  (is (= "fixture-b-one" (get-in (last @posts) [:body :model])))
                  (is (= (str "Bearer " (:accessToken account-b))
                         (get-in (last @posts) [:headers "authorization"]))))))
            (finally (kernel/dispose-all! ctx)))))
      (finally (fs/delete-tree directory)))))
