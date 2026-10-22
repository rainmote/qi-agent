(ns qi.tool-images-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.anthropic :as anthropic]
            [qi.plugins.chatgpt :as chatgpt]
            [qi.plugins.openai :as openai]
            [qi.plugins.openai-responses :as responses]
            [qi.tool-images :as images]
            [babashka.fs :as fs]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(def ^:private screenshot
  {:type :image :url "data:image/png;base64,AQIDBA==" :detail "auto"})

(defn- tool-call [id]
  {:id id :type "function"
   :function {:name "computer_screenshot" :arguments "{}"}})

(defn- request-with-images []
  {:messages [{:role "user" :content "Inspect the screen."}
              {:role "assistant" :content nil
               :tool_calls [(tool-call "first") (tool-call "second")]}
              {:role "tool" :tool_call_id "first" :content "1280 x 720"
               :images [screenshot]}
              {:role "tool" :tool_call_id "second" :content "Completed"}]})

(def ^:private responses-result
  {:id "reply" :status "completed" :model "fixture"
   :output [{:type "message" :role "assistant"
             :content [{:type "output_text" :text "done"}]}]})

(defn- fake-auth-context []
  (let [ctx (kernel/create-context)]
    (kernel/register-service!
     (kernel/plugin-context ctx :test/auth) :auth/store
     {:resolve! (fn [_] {:api-key "offline-fixture"
                        :access-token "offline-fixture" :account-id "test"})})
    ctx))

(defn- capture-request [run response]
  (let [captured (atom nil)
        ctx (fake-auth-context)]
    (try
      (with-redefs [http/post
                    (fn [_ options]
                      (reset! captured (json/parse-string (:body options) true))
                      {:status 200 :body (json/generate-string response)})]
        (run ctx))
      @captured
      (finally (kernel/dispose-all! ctx)))))

(deftest chat-completions-images-follow-the-entire-tool-batch
  (let [body (capture-request
              #(openai/generate % {:base-url "https://offline.invalid/v1"
                                     :model "vision-fixture" :stream false
                                     :supports-images? true}
                                (request-with-images))
              {:choices [{:finish_reason "stop" :message {:role "assistant" :content "done"}}]})
        messages (:messages body)]
    (is (= ["user" "assistant" "tool" "tool" "user"] (mapv :role messages)))
    (is (= ["first" "second"] (mapv :tool_call_id (subvec messages 2 4))))
    (is (= "1280 x 720" (get-in messages [2 :content])))
    (is (every? #(not (contains? % :images)) messages))
    (is (= (:url screenshot) (get-in messages [4 :content 1 :image_url :url])))
    (is (str/includes? (get-in messages [4 :content 0 :text]) "first"))
    (is (not (str/includes? (get-in messages [2 :content]) "base64")))))

(deftest responses-routes-use-multimodal-function-outputs
  (doseq [[route run]
          [[:openai #(responses/generate % {:model "fixture" :stream false}
                                            (request-with-images))]
           [:chatgpt #(#'chatgpt/generate % {:model "fixture"}
                                         {:config {} :client (atom nil)}
                                         (request-with-images))]]]
    (testing (name route)
      (let [body (capture-request run responses-result)
            outputs (filterv #(= "function_call_output" (:type %)) (:input body))]
        (is (= ["first" "second"] (mapv :call_id outputs)))
        (is (= [{:type "input_text" :text "1280 x 720"}
                {:type "input_image" :image_url (:url screenshot) :detail "auto"}]
               (:output (first outputs))))
        (is (= "Completed" (:output (second outputs))))
        (is (not-any? :images (:input body)))))))

(deftest anthropic-images-stay-in-the-corresponding-tool-results
  (let [request (update-in (request-with-images) [:messages 3] assoc :is-error true)
        body (capture-request
              #(anthropic/generate % {:base-url "https://offline.invalid"
                                        :model "fixture"} request)
              {:content [{:type "text" :text "done"}]})
        results (get-in body [:messages 2 :content])]
    (is (= 3 (count (:messages body))))
    (is (= ["first" "second"] (mapv :tool_use_id results)))
    (is (= {:type "text" :text "1280 x 720"}
           (get-in results [0 :content 0])))
    (is (= {:type "image" :source {:type "base64" :media_type "image/png"
                                    :data "AQIDBA=="}}
           (get-in results [0 :content 1])))
    (is (true? (:is_error (second results))))))

(deftest anthropic-user-images-use-the-same-image-encoding
  (let [body (capture-request
              #(anthropic/generate % {:base-url "https://offline.invalid" :model "fixture"}
                                   {:messages [{:role "user" :content [screenshot]}]})
              {:content [{:type "text" :text "done"}]})]
    (is (= "image" (get-in body [:messages 0 :content 0 :type])))
    (is (= "AQIDBA==" (get-in body [:messages 0 :content 0 :source :data])))))

(deftest image-capabilities-are-explicit-and-consistent
  (let [ctx (kernel/create-context)
        config {:base-url "https://offline.invalid/v1" :model "fixture"}]
    (is (= #{:text} (:input-modalities (openai/provider-entry ctx config))))
    (is (= #{:text :image}
           (:input-modalities (openai/provider-entry ctx (assoc config :supports-images? true)))))
    (is (= #{:text :image}
           (:input-modalities (anthropic/provider-entry ctx config))))
    (is (= #{:text}
           (:input-modalities (anthropic/provider-entry ctx (assoc config :supports-images? false)))))
    (is (= #{:text :image} (images/input-modalities {:input-modalities ["text" "image"]} #{})))
    (is (= #{:text} (images/input-modalities {:input-modalities #{:text :image}
                                             :supports-images? false} #{})))))

(deftest unsupported-tool-images-fail-before-auth-or-http
  (let [ctx (kernel/create-context)
        attempted (atom false)]
    (with-redefs [http/post (fn [& _] (reset! attempted true) (throw (Exception. "network")))]
      (doseq [run [#(openai/generate ctx {:model "text-fixture"} (request-with-images))
                   #(responses/generate ctx {:model "text-fixture" :supports-images? false}
                                        (request-with-images))
                   #(anthropic/generate ctx {:model "text-fixture" :input-modalities #{:text}}
                                        (request-with-images))
                   #(#'chatgpt/generate ctx {:model "text-fixture" :supports-images? false}
                                        {} (request-with-images))]]
        (let [error (try (run) nil (catch Throwable error error))]
          (is (= :image (:unsupported-modality (ex-data error))))
          (is (false? (:retryable (ex-data error))))
          (is (str/includes? (ex-message error) "image-capable"))))
      (is (false? @attempted)))))

(deftest malformed-images-do-not-expose-payload-in-errors
  (doseq [image [{:url "data:text/html;base64,c2VjcmV0"}
                 {:url "file:///private/screenshot.png"}
                 {:data "secret-image-bytes"}]]
    (let [error (try (images/responses-image image) nil (catch Throwable error error))]
      (is (true? (:unsupported-image (ex-data error))))
      (is (not (str/includes? (str (ex-message error) (ex-data error)) "secret"))))))

(defn- context-profile [generate config]
  {:plugins [{:ns 'qi.plugins.session}
             {:ns 'qi.plugins.mock :config {:generate generate}}
             {:ns 'qi.plugins.context-manager
              :config (merge {:context-window 100000 :reserve-tokens 1000
                              :retain-messages 1 :image-token-budget 2048}
                             config)}]})

(deftest image-budget-does-not-count-base64-as-text
  (let [ctx (plugin/boot! (context-profile (constantly {}) {}))]
    (try
      (let [manager (kernel/require-service ctx :context/manager)
            estimate! (:estimate! manager)
            small (:messages (request-with-images))
            large (assoc-in small [2 :images 0 :url]
                            (str "data:image/png;base64," (apply str (repeat 100000 "A"))))
            text-only (update small 2 dissoc :images)]
        (is (= (estimate! small) (estimate! large)))
        (is (<= 2048 (- (estimate! small) (estimate! text-only)) 2100))
        (is (= 2048 (:image-token-budget manager)))
        (is (= 2 (images/image-count
                   [{:content [screenshot]} {:images [screenshot]}]))))
      (finally (kernel/dispose-all! ctx)))))

(deftest semantic-compaction-omits-image-bytes-and-preserves-newer-images
  (let [captured (atom nil)
        ctx (plugin/boot!
             (context-profile
              (fn [request]
                (reset! captured request)
                {:message {:role "assistant" :content "Screen inspected."}})
              {}))]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)
            old [{:role "user" :content [{:type :text :text "old task"} screenshot]}
                 {:role "assistant" :tool_calls [(tool-call "old")]}
                 {:role "tool" :tool_call_id "old" :content "old screenshot"
                  :images [screenshot]}]
            newest {:role "user" :content [{:type :text :text "new task"} screenshot]}]
        (doseq [message (conj old newest)]
          ((:append! store) "message" {:message message}))
        (is (:compacted ((:compact! manager) {:force true})))
        (let [source (get-in @captured [:messages 0 :content])]
          (is (str/includes? source "old task"))
          (is (str/includes? source "old screenshot"))
          (is (str/includes? source "omitted"))
          (is (not (str/includes? source "AQIDBA")))
          (is (not (str/includes? source "data:image"))))
        (is (= newest (last ((:messages store))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest tool-images-survive-runtime-and-durable-session-reload
  (let [directory (fs/create-temp-dir {:prefix "qi-tool-images-"})
        path (str (fs/path directory "session.jsonl"))
        requests (atom [])
        ctx (plugin/boot!
             {:plugins
              [{:ns 'qi.plugins.session :config {:path path :fsync? false}}
               {:ns 'qi.plugins.mock
                :config {:generate
                         (fn [request]
                           (swap! requests conj request)
                           (if (= 1 (count @requests))
                             {:message {:role "assistant" :tool_calls [(tool-call "screen")]}
                              :finish-reason "tool_calls"}
                             {:message {:role "assistant" :content "done"}
                              :finish-reason "stop"}))}}
               {:ns 'qi.plugins.runtime :config {:max-steps 3}}]})]
    (try
      (kernel/register-tool!
       (kernel/plugin-context ctx :test/image-tool)
       {:name "computer_screenshot" :description "Offline screenshot fixture"
        :parameters {:type "object" :properties {}}
        :execute (fn [_ _] {:image screenshot :width 1280})
        :render (fn [_ _] "Screenshot width: 1280")
        :result-images (fn [_ value] [(:image value)])})
      (is (= "done" (:content ((kernel/require-service ctx :agent/run) "Inspect"))))
      (let [tool (last (get-in @requests [1 :messages]))]
        (is (= "tool" (:role tool)))
        (is (= [screenshot] (:images tool)))
        (is (= "Screenshot width: 1280" (:content tool))))
      (kernel/dispose-all! ctx)
      (let [reopened (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}]})]
        (try
          (let [tool (first (filter #(= "tool" (:role %))
                                    ((:messages (kernel/require-service reopened :session/store)))))]
            (is (= (:url screenshot) (get-in tool [:images 0 :url])))
            (is (= "Screenshot width: 1280" (:content tool)))
            (is (= "input_image" (get-in (images/responses-output tool) [1 :type]))))
          (finally (kernel/dispose-all! reopened))))
      (finally
        (kernel/dispose-all! ctx)
        (fs/delete-tree directory)))))

(deftest failed-semantic-compaction-keeps-the-original-images-and-history
  (let [ctx (plugin/boot!
             (context-profile (fn [_] (throw (Exception. "Offline compactor failure"))) {}))]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)]
        (doseq [message [{:role "user" :content [{:type :text :text "Inspect this"} screenshot]}
                         {:role "assistant" :content "Inspected"}
                         {:role "user" :content "Continue"}]]
          ((:append! store) "message" {:message message}))
        (let [before ((:messages store))]
          (is (thrown-with-msg? clojure.lang.ExceptionInfo #"original context was preserved"
                               ((:compact! manager) {:force true})))
          (is (= before ((:messages store))))
          (is (= screenshot (get-in ((:messages store)) [0 :content 1])))
          (is (not-any? #(= "session/compaction" (:type %)) ((:events store))))))
      (finally (kernel/dispose-all! ctx)))))
