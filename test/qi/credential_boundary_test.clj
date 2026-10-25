(ns qi.credential-boundary-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.secure-files :as secure]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]))

(defn- provider [id]
  {:id id :name id :protocol "openai-responses"
   :baseUrl (str "https://" id ".example/v1")
   :models [{:id (str id "-model")}]})

(defn- write-settings! [file providers]
  (spit file (json/generate-string {:version 1 :providers providers}))
  (fs/set-posix-file-permissions file "rw-------"))

(defn- boot [file]
  (plugin/boot! {:plugins [{:ns 'qi.plugins.model-registry}
                          {:ns 'qi.plugins.auth-store}
                          {:ns 'qi.plugins.provider-settings :config {:path (str file)}}]}))

(defn- outcome [run]
  (try {:value (run)} (catch Throwable error {:error error})))

(defn- insecure-credentials? [error]
  (boolean (some #(= :insecure-credentials (:code (ex-data %)))
                 (take-while some? (iterate ex-cause error)))))

(defn- swapped-settings-are-refused [replacement]
  (let [directory (fs/create-temp-dir {:prefix "qi-private-read-"})
        file (io/file (str directory) "providers.json")
        other (io/file (str directory) "replacement.json")
        original secure/assert-owner-file!
        replaced (atom false)
        ctx (atom nil)]
    (try
      (write-settings! file [(assoc (provider "before") :apiKey "before-fixture-key")])
      (write-settings! other [(assoc (provider "after") :apiKey "after-fixture-key")])
      (let [result (with-redefs [secure/assert-owner-file!
                                (fn [path]
                                  (let [validated (original path)]
                                    (when (compare-and-set! replaced false true)
                                      (fs/delete file)
                                      (case replacement
                                        :symlink (fs/create-sym-link file other)
                                        :public-file (do (fs/move other file)
                                                         (fs/set-posix-file-permissions file "rw-r--r--"))))
                                    validated))]
                     (outcome #(reset! ctx (boot file))))]
        (is @replaced "the race must occur after a successful owner-only check")
        (is (insecure-credentials? (:error result)) "a replacement must fail the private-file boundary before registering credentials")
        (is (nil? @ctx) "no provider registry may be accepted from the replacement"))
      (finally
        (when @ctx (kernel/dispose-all! @ctx))
        (fs/delete-tree directory)))))

(deftest provider-settings-refuses-a-link-inserted-after-ownership-check
  (swapped-settings-are-refused :symlink))

(deftest provider-settings-rechecks-permissions-after-file-replacement
  (swapped-settings-are-refused :public-file))

(deftest a-keyless-custom-responses-provider-does-not-break-boot-or-reload
  (let [directory (fs/create-temp-dir {:prefix "qi-keyless-settings-"})
        file (io/file (str directory) "providers.json")
        configured (assoc (provider "configured") :apiKey "configured-fixture-key")
        ctx (atom nil)]
    (try
      (write-settings! file [configured])
      (reset! ctx (boot file))
      (write-settings! file [configured (provider "keyless")])
      (let [result (outcome #((:reload! (kernel/require-service @ctx :provider/settings))))]
        (is (nil? (:error result)) "missing custom credentials must not invalidate the complete catalog")
        (let [registry (kernel/require-service @ctx :llm/registry)]
          (is (= "configured-model" (:model ((:select! registry) :configured))))
          (when-not (:error result)
            (is (= #{"configured-model" "keyless-model"} (set (map :model ((:providers registry)))))))))
      (kernel/dispose-all! @ctx)
      (reset! ctx nil)
      (let [result (outcome #(reset! ctx (boot file)))]
        (is (nil? (:error result)) "persisted keyless providers must not prevent later worker startup"))
      (finally (when @ctx (kernel/dispose-all! @ctx)) (fs/delete-tree directory)))))

(deftest settings-responses-never-fall-back-to-host-credentials
  ;; A synthetic environment key makes an accidental getenv fallback observable
  ;; even on CI hosts with no credentials. HTTP remains an in-process stub.
  (let [directory (fs/create-temp-dir {:prefix "qi-keyless-environment-"})
        program
        (pr-str
         '(do
            (require '[qi.kernel :as k] '[qi.plugins.openai-responses :as responses]
                     '[babashka.http-client :as http] '[cheshire.core :as json])
            (let [ctx (k/create-context) auth-calls (atom 0) requests (atom [])
                  config {:model "fixture" :base-url "http://127.0.0.1:1/v1"
                          :credential-source :settings :allow-custom-endpoint true
                          :stream false :max-retries 0}]
              (assert (= "host-environment-fixture" (System/getenv "OPENAI_API_KEY")))
              (k/register-service! (k/plugin-context ctx :test/auth) :auth/store
                                   {:resolve! (fn [_] (swap! auth-calls inc) {:api-key "host-store-fixture"})})
              (try
                (with-redefs [http/post (fn [url options]
                                         (swap! requests conj [url (get-in options [:headers "authorization"])])
                                         {:status 200 :body (json/generate-string
                                                            {:id "fixture" :status "completed" :model "fixture"
                                                             :output [{:type "message" :role "assistant"
                                                                       :content [{:type "output_text" :text "done"}]}]})})]
                  (let [missing (mapv (fn [key]
                                        (try (responses/generate ctx (assoc config :api-key key) {:messages []})
                                             :accepted
                                             (catch clojure.lang.ExceptionInfo error (:code (ex-data error)))))
                                      [nil "" "   "])
                        before (count @requests)
                        explicit (responses/generate ctx (assoc config :api-key "maintenance-broker") {:messages []})]
                    (print (json/generate-string {:missing missing :before before :auth-calls @auth-calls
                                                 :requests @requests :content (get-in explicit [:message :content])}))))
                (finally (k/dispose-all! ctx))))))
        child (process/process ["bb" "--classpath" "src:plugins" "-e" program]
                               {:out :string :err :string
                                :env {"PATH" (System/getenv "PATH") "HOME" (str directory)
                                      "LANG" "C.UTF-8" "OPENAI_API_KEY" "host-environment-fixture"}})]
    (try
      (let [result (deref child 10000 ::timeout)]
        (is (not= ::timeout result) "the isolated offline probe must finish")
        (when-not (= ::timeout result)
          (is (zero? (:exit result)) (:err result))
          (when (zero? (:exit result))
            (let [report (json/parse-string (:out result) true)]
              (is (= ["missing-credentials" "missing-credentials" "missing-credentials"] (:missing report)))
              (is (zero? (:before report)))
              (is (zero? (:auth-calls report)))
              (is (= [["http://127.0.0.1:1/v1/responses" "Bearer maintenance-broker"]] (:requests report)))
              (is (= "done" (:content report)))))))
      (finally
        (when (.isAlive (:proc child))
          (process/destroy-tree child)
          (when-not (.waitFor (:proc child) 1 java.util.concurrent.TimeUnit/SECONDS)
            (.destroyForcibly (:proc child))))
        (is (.waitFor (:proc child) 3 java.util.concurrent.TimeUnit/SECONDS) "the fixture process must exit during cleanup")
        (fs/delete-tree directory)))))
