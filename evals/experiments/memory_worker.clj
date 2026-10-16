(ns memory-worker
  "No tools or credentials. Only captured model inputs and a loopback broker relay."
  (:require [cheshire.core :as json] [babashka.http-client :as http]
            [clojure.string :as str] [qi.kernel :as kernel] [qi.generation :as generation]))

(defn emit! [value] (println (json/generate-string value)) (flush))
(defn bytes [text] (alength (.getBytes (str text) "UTF-8")))
(defn run! []
  (let [config (json/parse-string (slurp "run-config.json") true)
        plan (json/parse-string (slurp "plan.json") true)
        ctx (kernel/create-context) owner (kernel/plugin-context ctx :memory-experiment)
        run-id (str (random-uuid))
        store {:session-id (str (random-uuid))
               :append! (fn [type data]
                          (let [event {:id (str (random-uuid)) :at (str (java.time.Instant/now)) :type type :data data}]
                            (with-open [out (java.io.FileOutputStream. "generation.jsonl" true)]
                              (.write out (.getBytes (str (json/generate-string event) "\n") "UTF-8"))
                              (.flush out) (.force (.getChannel out) true))
                            (emit! {:type "generation-event" :event event}) event))}]
    (kernel/register-service! owner :session/store store)
    (kernel/register-service! owner :llm/registry {:current (fn [] {:id (:provider config) :model (:model config)})})
    (kernel/register-service!
      owner :llm/generate
      (fn [request]
        (when (seq (:tools request)) (throw (ex-info "Memory experiment tools are forbidden" {:code :tools-forbidden})))
        (let [accounting (:accounting request)
              body (json/generate-string
                     {:model (:model config) :instructions (:system-prompt request)
                      :input (mapv #(select-keys % [:role :content]) (:messages request))
                      :tools [] :max_output_tokens (:max_output_tokens config)})]
          (when (> (bytes body) (:max_input_bytes config))
            (throw (ex-info "Input byte limit" {:code :input-limit})))
          (let [response (http/post (str (System/getenv "QI_MAINTENANCE_BROKER_URL") "/responses")
                                   {:headers {"content-type" "application/json"
                                              "x-qi-request-id" (:request_id accounting)
                                              "x-qi-run-id" (:run-id accounting)
                                              "x-qi-purpose" (name (:purpose accounting))}
                                    :body body :throw false :timeout (:max_wall_ms config)})
                value (json/parse-string (:body response) true)
                text (->> (:output value) (filter #(= "message" (:type %)))
                          (mapcat :content) (filter #(= "output_text" (:type %))) (map :text) (str/join "\n"))]
            (when (or (not= 200 (:status response)) (not= "completed" (:status value))
                      (str/blank? text) (> (bytes text) (:max_output_bytes config)))
              (throw (ex-info "Incomplete or bounded provider output" {:code :provider-output :usage (:usage value)})))
            {:message {:role "assistant" :content text} :finish-reason "stop" :usage (:usage value)
             :native_request_id (:request_id accounting)}))))
    (binding [generation/*run* (generation/run-budget run-id {:max-model-requests (:max_requests config)
                                                             :max-wall-ms (:max_wall_ms config)})]
      (let [call! (fn [id purpose request]
                    (try
                      (let [response (generation/generate! ctx request {:purpose purpose :attempt 0 :operation-id id})]
                        (emit! {:type "request-result" :request_id id :status "completed" :finish_reason "stop"
                                :native_request_id (:native_request_id response) :usage (:usage response)
                                :text (get-in response [:message :content])})
                        (get-in response [:message :content]))
                      (catch Throwable error
                        (emit! {:type "request-result" :request_id id :status "failed" :error_code (or (:code (ex-data error)) :request-failed)})
                        (throw error))))]
        (doseq [arm (:arms plan)]
          (let [summaries (mapv #(call! (:request_id %) :compaction (:request %)) (:requests arm))
                recall (:recall arm)]
            (call! (:request_id recall) :main
                   {:system-prompt (:system_prompt recall) :tools []
                    :messages [{:role "system" :content (str "Previous conversation summary:\n" (str/join "\n\n" summaries))}
                               {:role "user" :content "Report the current decisions from the preceding history."}]})))))
    (emit! {:type "terminal" :status "completed"})))

(try (run!)
     (catch Throwable error (emit! {:type "terminal" :status "failed" :error_code (or (:code (ex-data error)) :worker-failed)})
       (System/exit 1)))
