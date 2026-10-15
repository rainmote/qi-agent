(ns interaction-latency
  "Offline monotonic-clock measurements; never production latency evidence."
  (:require [cheshire.core :as json]
            [qi.cancellation :as cancellation]
            [qi.context-summary :as summary]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

(defn- ms [start end] (/ (- end start) 1000000.0))
(defn- answer [text] {:message {:role "assistant" :content text} :finish-reason "stop"})
(defn- await! [value label]
  (let [result (deref value 5000 ::timeout)]
    (when (= result ::timeout) (throw (ex-info "Latency fixture timed out" {:stage label})))
    result))

(defn sample! [scenario action index]
  (let [entered (promise) release (promise) calls (atom 0) summaries (atom 0) facts (atom [])
        blocked! (fn [token]
                   (deliver entered true)
                   (loop []
                     (cancellation/throw-if-cancelled! token)
                     (when-not (realized? release) (Thread/sleep 1) (recur))))
        profile {:scenario scenario :max-steps 6 :max-model-requests 32 :max-wall-ms 5000
                 :context-window 2048 :reserve-tokens 128 :max-source-chars 800}
        profile-hash (summary/sha256 (pr-str profile))
        generate (fn [request]
                   (if (= "LATENCY_FIXTURE_SUMMARY" (:system-prompt request))
                     (do (when (= 1 (swap! summaries inc)) (blocked! (:cancel-token request)))
                         (answer "bounded summary"))
                     (let [call (swap! calls inc)]
                       (when (and (= scenario "slow-model") (= call 1)) (blocked! (:cancel-token request)))
                       (if (and (= scenario "slow-tool") (= call 1))
                         {:message {:role "assistant" :tool_calls [{:id "slow-call" :type "function"
                                                                   :function {:name "slow_read" :arguments "{}"}}]}
                          :finish-reason "tool_calls"}
                         (answer "offline fixture complete")))))
        ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session
                         :config {:path nil :ephemeral true :provenance {:sample_kind "fixture" :source_sha nil
                                                                        :profile_sha256 profile-hash}}}
                        {:ns 'qi.plugins.mock :config {:generate generate}}
                        {:ns 'qi.plugins.context-manager
                         :config {:context-window 2048 :reserve-tokens 128 :retain-messages 1
                                  :max-source-chars 800 :summary-system-prompt "LATENCY_FIXTURE_SUMMARY"}}
                        {:ns 'qi.plugins.runtime :config (select-keys profile [:max-steps :max-model-requests :max-wall-ms])}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            session (kernel/require-service ctx :agent/session)
            fixture (kernel/plugin-context ctx :latency/fixture)]
        (kernel/on! fixture :session/event (fn [_ event] (swap! facts conj {:event event :monotonic_ns (System/nanoTime)})))
        (kernel/register-tool! fixture {:name "slow_read" :description "Offline gated read fixture"
                                   :parameters {:type "object" :properties {}} :execution-mode :parallel
                                   :execute (fn [_ options] (blocked! (:cancel-token options)) {:ok true :value "bounded"})})
        (when (= scenario "chunked-compaction")
          ((:append! store) "message" {:message {:role "user" :content (apply str (repeat 12000 "x"))}})
          ((:append! store) "message" {:message {:role "assistant" :content "old work"}}))
        (let [{:keys [result]} ((:submit! session) "current fixture instruction")]
          (when-not (deref entered 5000 false)
            (throw (ex-info "Latency fixture never entered its gated phase"
                            {:scenario scenario :action action :index index
                             :result (when (realized? result) (dissoc @result :value))
                             :terminal (last (filter #(= "agent/run/end" (:type %)) ((:events store))))})))
          (let [started (System/nanoTime)
                item (if (= action "steer") ((:steer! session) "new fixture constraint")
                         (do ((:abort! session)) nil))
                received (System/nanoTime)]
            (when (= action "steer") (Thread/sleep 50) (deliver release true))
            (await! result :native-terminal)
            (let [events ((:events store))
                  terminal (last (filter #(= "agent/run/end" (:type %)) events))
                  timed (fn [type id]
                          (some #(when (and (= type (get-in % [:event :type]))
                                            (or (nil? id) (= id (get-in % [:event :data :id])))) (:monotonic_ns %)) @facts))
                  terminal-at (timed "agent/run/end" nil)
                  consumed (when item (timed "queue/consumed" (:id item)))
                  chunks (filter #(= "context/compaction" (:type %)) events)
                  status (some-> (get-in terminal [:data :status]) name)]
              (assert (= (if (= action "cancel") "cancelled" "completed") status))
              (assert terminal-at)
              (when item (assert (:id item)) (assert consumed) (assert (<= received consumed)))
              (when (= scenario "chunked-compaction")
                (assert (seq chunks))
                (assert (some #(> (get-in % [:data :total-chunks] 0) 1) chunks))
                (when (= action "cancel") (assert (not-any? #(= "session/compaction" (:type %)) events))))
              {:scenario scenario :action action :index index :sample_kind "fixture" :profile_sha256 profile-hash
               :queue_item_id (:id item) :run_id (get-in terminal [:data :run-id]) :status status
               :received_ms (ms started received)
               :consumed_ms (when consumed (ms started consumed))
               :terminal_ms (ms started terminal-at)
               :compaction_requests @summaries :logical_requests (count (filter #(and (= "usage/request" (:type %))
                                                                                    (= "started" (some-> (get-in % [:data :status]) name))) events))}))))
      (finally (deliver release true) (kernel/dispose-all! ctx)))))

(defn summarize [values]
  (let [values (vec (sort (keep identity values))) n (count values)]
    {:n n :min_ms (first values) :max_ms (last values)
     :p95_ms (when (pos? n) (nth values (dec (int (Math/ceil (* n 0.95))))))}))

(defn experiment! [n]
  (when-not (= n 30) (throw (ex-info "Frozen interaction matrix requires thirty samples per group" {})))
  (let [rows (vec (for [scenario ["slow-model" "slow-tool" "chunked-compaction"] action ["steer" "cancel"] index (range n)]
                    (sample! scenario action index)))]
    {:schema_version 1 :scope "native-runtime-offline-fixtures" :clock "same-process-System.nanoTime"
     :model_calls 0 :production_samples 0 :cost_usd nil :runner_sha256 (summary/sha256 (slurp *file*))
     :samples rows
     :groups (vec (for [scenario ["slow-model" "slow-tool" "chunked-compaction"] action ["steer" "cancel"]
                       :let [group (filter #(and (= scenario (:scenario %)) (= action (:action %))) rows)]]
                   {:scenario scenario :action action :received (summarize (map :received_ms group))
                    :consumed (summarize (map :consumed_ms group)) :terminal (summarize (map :terminal_ms group))}))}))

(when (= *file* (System/getProperty "babashka.file"))
  (println (json/generate-string (experiment! 30))))
