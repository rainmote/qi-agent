(ns qi.openai-integrity-test
  (:require [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.openai :as openai]
            [qi.streaming :as streaming]
            [babashka.fs :as fs]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(defn- frame [data] (str "data: " (json/generate-string data) "\n\n"))
(defn- delta [data] (frame {:choices [{:index 0 :delta data}]}))
(defn- terminal [reason] (frame {:choices [{:index 0 :delta {} :finish_reason reason}]}))
(def call {:index 0 :id "call-1" :type "function"
           :function {:name "probe" :arguments "{}"}})
(def config {:base-url "http://127.0.0.1:1/v1" :provider-id :deepseek
             :model "fixture" :api-key "synthetic-fixture-key"
             :extra-body {:thinking {:type "disabled"}}})

(defn- context [path]
  (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path path}}
                          {:ns 'qi.plugins.openai :config config}
                          {:ns 'qi.plugins.runtime :config {:max-retries 0 :max-steps 4}}]}))

(defn- response [ctx body & [request]]
  (with-redefs [http/post (fn [_ _] {:status 200 :body
                                    (java.io.ByteArrayInputStream. (.getBytes body "UTF-8"))})]
    (try {:value (openai/generate ctx config
                                 (merge {:messages [{:role "user" :content "fixture"}]} request))}
         (catch Throwable e {:error e}))))

(deftest incomplete-streams-never-complete-or-dispatch
  (doseq [[label body] [["empty" ""]
                       ["text without finish" (delta {:content "partial"})]
                       ["complete args without finish" (delta {:tool_calls [call]})]
                       ["partial args" (delta {:tool_calls [(assoc-in call [:function :arguments] "{")]})]
                       ["bare DONE" "data: [DONE]\n\n"]
                       ["DONE before finish" (str (delta {:tool_calls [call]}) "data: [DONE]\n\n" (terminal "tool_calls"))]
                       ["invalid DONE" "data: [DONE]broken\n\n"]
                       ["partial args with terminal" (str (delta {:tool_calls [(assoc-in call [:function :arguments] "{")]}) (terminal "tool_calls"))]
                       ["calls with stop" (str (delta {:tool_calls [call]}) (terminal "stop"))]]]
    (testing label
      (let [ctx (context nil) events (atom []) actions (atom 0) requests (atom 0)]
        (try
          (kernel/on! (kernel/plugin-context ctx :fixture/stream) :llm/stream
                      (fn [_ event] (swap! events conj event)))
          (kernel/register-tool! (kernel/plugin-context ctx :fixture/tool)
                                 {:name "probe" :description "Count a synthetic fixture action." :parameters {:type "object"}
                                  :execute (fn [_ _] (swap! actions inc) "done")})
          (with-redefs [http/post (fn [_ _]
                                  (swap! requests inc)
                                  {:status 200 :body (if (= 1 @requests) body
                                                       (str (delta {:content "done"}) (terminal "stop")))})]
            (let [result (try ((kernel/require-service ctx :agent/run) "fixture")
                              (catch Throwable e {:caught e}))]
              (is (:caught result) label)
              (is (zero? @actions) label)
              (is (= 1 @requests) label)
              (is (not-any? #(= :response/completed (:type %)) @events) label)
              (is (empty? (filter #(= "assistant" (:role %))
                                 ((:messages (kernel/require-service ctx :session/store))))) label)))
          (finally (kernel/dispose-all! ctx)))))))

(deftest terminal-eof-and-usage-tail-are-valid
  (let [ctx (context nil)]
    (try
      (doseq [suffix ["" "data: [DONE]\n\n"]]
        (let [r (:value (response ctx (str (delta {:content "ok"}) (terminal "stop")
                                            (frame {:choices [] :usage {:prompt_tokens 3 :completion_tokens 2}})
                                            suffix)))]
          (is (= "stop" (:finish-reason r)))
          (is (= "ok" (get-in r [:message :content])))
          (is (= {:prompt_tokens 3 :completion_tokens 2} (:usage r)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest output-limit-and-refusal-never-dispatch
  (doseq [[finish reason] [["length" :output-limit] ["content_filter" :provider-refusal]
                           ["refusal" :provider-refusal]]]
    (let [ctx (context nil)]
      (try
        (let [r (response ctx (str (delta {:tool_calls [call]}) (terminal finish)
                                   (frame {:choices [] :usage {:completion_tokens 7}})))]
          (is (= reason (:reason (ex-data (:error r)))))
          (is (= {:completion_tokens 7} (:usage (ex-data (:error r))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest reasoning-survives-two-tool-rounds-reopen-and-next-user
  (let [dir (fs/create-temp-dir {:prefix "qi-reasoning-replay-"})
        path (str (fs/path dir "session.jsonl")) requests (atom []) actions (atom 0)
        replies (atom [(str (delta {:reasoning_content "r1-"}) (delta {:reasoning_content "tail" :tool_calls [call]}) (terminal "tool_calls"))
                       (str (delta {:reasoning_content "r2" :tool_calls [(assoc call :id "call-2")]}) (terminal "tool_calls"))
                       (str (delta {:reasoning_content "r3" :content "first answer"}) (terminal "stop"))
                       (str (delta {:reasoning_content "r4" :content "next answer"}) (terminal "stop"))])]
    (try
      (with-redefs [http/post (fn [_ options]
                              (swap! requests conj (json/parse-string (:body options) true))
                              (let [body (first @replies)] (swap! replies subvec 1) {:status 200 :body body}))]
        (doseq [prompt ["first user" "next user"]]
          (let [ctx (context path)]
            (try
              (kernel/register-tool! (kernel/plugin-context ctx :fixture/tool)
                                     {:name "probe" :description "Count a synthetic fixture action." :parameters {:type "object"}
                                      :execute (fn [_ _] (swap! actions inc) "done")})
              (is (string? (:content ((kernel/require-service ctx :agent/run) prompt))))
              (finally (kernel/dispose-all! ctx)))))
        (is (= 2 @actions))
        (is (= ["r1-tail"] (mapv :reasoning_content (filter #(= "assistant" (:role %)) (:messages (nth @requests 1))))))
        (is (= ["r1-tail" "r2"] (mapv :reasoning_content (filter #(= "assistant" (:role %)) (:messages (nth @requests 2))))))
        (is (= ["r1-tail" "r2" "r3"] (mapv :reasoning_content (filter #(= "assistant" (:role %)) (:messages (nth @requests 3))))))
        (is (every? #(= "disabled" (get-in % [:thinking :type])) @requests))
        (is (= [nil nil "first answer"] (mapv :content (filter #(= "assistant" (:role %)) (:messages (nth @requests 3)))))))
      (finally (fs/delete-tree dir)))))

(deftest reasoning-is-not-sent-to-an-incompatible-provider-or-fabricated
  (let [ctx (context nil) captured (atom nil)]
    (try
      (with-redefs [http/post (fn [_ options]
                              (reset! captured (json/parse-string (:body options) true))
                              {:status 200 :body (str (delta {:content "ok"}) (terminal "stop"))})]
        (openai/generate ctx (assoc config :provider-id :other)
                         {:messages [{:role "assistant" :content "prior" :reasoning_content "private-fixture"}
                                     {:role "user" :content "next"}]})
        (is (not (contains? (first (:messages @captured)) :reasoning_content)))
        (openai/generate ctx config {:messages [{:role "assistant" :content "legacy"}]})
        (is (not (contains? (first (:messages @captured)) :reasoning_content))))
      (finally (kernel/dispose-all! ctx)))))

(deftest cancelled-completed-stream-cannot-return-a-late-answer
  (let [ctx (context nil) token (cancellation/create-token)]
    (try
      (kernel/on! (kernel/plugin-context ctx :fixture/cancel) :llm/stream
                  (fn [_ event] (when (= :text/delta (:type event)) (cancellation/cancel! token))))
      (is (:cancelled (ex-data (:error (response ctx (str (delta {:content "late"}) (terminal "stop"))
                                                {:cancel-token token})))))
      (finally (kernel/dispose-all! ctx)))))

(deftest loopback-http-sse-requires-a-terminal-before-eof
  (doseq [[finished? hold-open?] [[false false] [true false] [true true]]]
    (with-open [server (java.net.ServerSocket. 0 1 (java.net.InetAddress/getByName "127.0.0.1"))]
      (.setSoTimeout server 3000)
      (let [ctx (context nil) release (promise)
            task (future
                   (with-open [socket (.accept server)
                               reader (io/reader (.getInputStream socket))
                               output (.getOutputStream socket)]
                     (.setSoTimeout socket 3000)
                     (let [headers (loop [lines []]
                                     (let [line (.readLine reader)]
                                       (if (str/blank? line) lines (recur (conj lines line)))))
                           size (some #(when (str/starts-with? (str/lower-case %) "content-length:")
                                         (parse-long (str/trim (second (str/split % #":" 2))))) headers)]
                       (dotimes [_ (or size 0)] (.read reader))
                       (.write output (.getBytes "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" "UTF-8"))
                       (.write output (.getBytes (delta {:content "local fixture"}) "UTF-8"))
                       (.flush output)
                       (when finished?
                         (.write output (.getBytes (terminal "stop") "UTF-8"))
                         (.flush output))
                       (when hold-open?
                         (.write output (.getBytes "data: [DONE]\n\n" "UTF-8"))
                         (.flush output)
                         (deref release 3000 nil)))))]
        (try
          (let [request (future (try {:value (openai/generate ctx
                                               (assoc config :base-url (str "http://127.0.0.1:" (.getLocalPort server))
                                                             :timeout-ms 3000)
                                               {:messages [{:role "user" :content "fixture"}]})}
                       (catch Throwable e {:error e})))
                r (deref request 1000 ::timeout)]
            (is (not= ::timeout r))
            (deliver release true)
            (if finished?
              (is (= "local fixture" (get-in r [:value :message :content])))
              (is (= :provider-incomplete (:reason (ex-data (:error r))))))
            (is (not= ::timeout (deref task 3000 ::timeout))))
          (finally (deliver release true) (future-cancel task) (kernel/dispose-all! ctx)))))))

(deftest failed-streams-retain-known-usage-without-logging-response-data
  (let [usage {:prompt_tokens 9 :completion_tokens 2}
        secret "synthetic-private-marker"
        prefix (frame {:choices [] :usage usage})]
    (doseq [body [(str prefix (frame {:error {:message secret :key secret}}))
                 (str prefix "data: {\"" secret "\"\n\n")
                 (str prefix (terminal "stop") (delta {:content secret}))]]
      (let [ctx (context nil) events (atom [])]
        (try
          (kernel/on! (kernel/plugin-context ctx :fixture/errors) :llm/stream
                      (fn [_ e] (swap! events conj e)))
          (let [r (response ctx body) error (:error r)]
            (is (some? error))
            (is (= usage (:usage (ex-data error))))
            (is (not (str/includes? (str (ex-message error) (ex-data error) @events) secret)))
            (is (nil? (ex-cause error))))
          (finally (kernel/dispose-all! ctx)))))))

(deftest json-responses-have-the-same-terminal-and-privacy-contract
  (let [ctx (context nil) secret "synthetic-json-private-marker"]
    (try
      (doseq [body [(str "{\"" secret "\"")
                   (json/generate-string {:choices [{:message {:role "assistant" :content secret}}]})
                   (json/generate-string {:error {:message secret}})
                   (json/generate-string {:error {:message secret}
                                          :choices [{:finish_reason "tool_calls"
                                                     :message {:role "assistant" :tool_calls [call]}}]})]]
        (with-redefs [http/post (fn [_ _] {:status 200 :body body})]
          (let [error (try (openai/generate ctx config {:messages []}) nil (catch Throwable e e))]
            (is (some? error))
            (is (not (str/includes? (str (ex-message error) (ex-data error)) secret))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest stream-transport-failure-keeps-retry-classification-and-known-usage
  (let [ctx (context nil)]
    (try
      (with-redefs [streaming/consume-sse!
                    (fn [_ _ handler]
                      (handler {:choices [] :usage {:prompt_tokens 4}})
                      (throw (java.io.IOException. "synthetic-private-transport-detail")))]
        (let [error (:error (response ctx "fixture"))]
          (is (true? (:retryable (ex-data error))))
          (is (= {:prompt_tokens 4} (:usage (ex-data error))))
          (is (nil? (ex-cause error)))
          (is (not (str/includes? (str (ex-message error) (ex-data error)) "synthetic-private")))))
      (finally (kernel/dispose-all! ctx)))))
