(ns qi.context-integrity-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.remote-api]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]))

(defn- answer [text] {:message {:role "assistant" :content text} :finish-reason "stop"})

(defn- context [generate config]
  (plugin/boot!
   {:plugins [{:ns 'qi.plugins.session}
              {:ns 'qi.plugins.model-registry}
              {:ns 'qi.plugins.mock :config {:generate generate :context-window 128000}}
              {:ns 'qi.plugins.context-manager
               :config (merge {:context-window 10000 :reserve-tokens 1000
                               :retain-messages 1} config)}]}))

(defn- append! [store messages]
  (doseq [message messages] ((:append! store) "message" {:message message})))

(defn- caught [f]
  (try (f) nil (catch clojure.lang.ExceptionInfo error (ex-data error))))

(deftest summary-requests-retain-run-and-chunk-identity
  (let [ctx (context (constantly (answer "summary")) {:max-source-chars 1200})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)]
        (append! store [{:role "user" :content (apply str (repeat 4000 "x"))}
                        {:role "user" :content "current"}])
        ((:compact! manager) {:force true :run-id "run-parent"})
        (let [records (map :data (filter #(and (= "usage/request" (:type %))
                                              (= :completed (get-in % [:data :status]))) ((:events store))))]
          (is (> (count records) 1))
          (is (every? #(= "run-parent" (:run-id %)) records))
          (is (every? :compaction-id records))
          (is (= 1 (count (set (map :compaction-id records)))))
          (is (= (range (count records)) (map :chunk-index records)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest automatic-compaction-uses-the-original-run-budget-and-preserves-history-on-exhaustion
  (let [ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                        {:ns 'qi.plugins.model-registry}
                        {:ns 'qi.plugins.mock :config {:context-window 2048 :generate (constantly (answer "summary"))}}
                        {:ns 'qi.plugins.context-manager :config {:context-window 2048 :reserve-tokens 128
                                                                :retain-messages 1 :max-source-chars 2000}}
                        {:ns 'qi.plugins.runtime :config {:max-model-requests 2}}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            run (kernel/require-service ctx :agent/run)
            history {:role "user" :content (apply str (repeat 12000 "x"))}]
        (append! store [history])
        (is (= :request-budget (:reason (caught #(run "current instruction")))))
        (let [events ((:events store))
              run-id (get-in (first (filter #(= "agent/run/start" (:type %)) events)) [:data :run-id])
              requests (map :data (filter #(= "usage/request" (:type %)) events))]
          (is (= 4 (count requests)))
          (is (every? #(= run-id (:run-id %)) requests))
          (is (every? #(= :compaction (:purpose %)) requests))
          (is (not-any? #(= "session/compaction" (:type %)) events))
          (is (= history (first ((:messages store)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest summary-covers-late-constraints-and-tool-arguments-beyond-the-old-prefix
  (let [requests (atom [])
        ctx (context (fn [request]
                       (swap! requests conj request)
                       (answer (if (str/includes? (get-in request [:messages 0 :content]) "TAIL-CONSTRAINT")
                                 "Keep TAIL-CONSTRAINT" "Earlier work"))) {})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)
            history [{:role "user" :content (str (apply str (repeat 60000 "x")) "TAIL-CONSTRAINT")}
                     {:role "assistant" :content "executing"
                      :tool_calls [{:id "batch-a" :function {:name "read" :arguments "{\"path\":\"must-keep.txt\"}"}}]}
                     {:role "tool" :tool_call_id "batch-a" :content "key result"}
                     {:role "user" :content "current exact instruction"}]]
        (append! store history)
        (is (:compacted ((:compact! manager) {:force true})))
        (is (> (count @requests) 1))
        (let [source (apply str (map #(get-in % [:messages 0 :content]) @requests))
              checkpoint (last ((:events store)))
              coverage (get-in checkpoint [:data :coverage])]
          (is (str/includes? source "TAIL-CONSTRAINT"))
          (is (str/includes? source (get-in history [0 :content])))
          (is (str/includes? source "must-keep.txt"))
          (is (str/includes? source "batch-a"))
          (is (= (count source) (:source-chars coverage)))
          (is (= 3 (:message-count coverage)))
          (is (= 64 (count (:sha256 coverage))))
          (is (= 0 (:start (first (:chunks coverage)))))
          (is (= (count source) (:end (last (:chunks coverage)))))
          (is (every? true? (map #(= (:end %1) (:start %2))
                                 (:chunks coverage) (rest (:chunks coverage)))))
          (is (str/includes? (:content (first ((:messages store)))) "TAIL-CONSTRAINT")))
        (is (= (last history) (last ((:messages store)))))
        (is (= history (mapv #(get-in % [:data :message])
                            (filter #(= "message" (:type %)) ((:events store)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest failed-or-incomplete-summary-does-not-commit-a-lossy-fallback
  (doseq [response [(fn [_] (throw (ex-info "summary offline" {})))
                    (constantly (answer ""))
                    (constantly (assoc (answer "partial") :finish-reason "length"))]]
    (let [ctx (context response {})]
      (try
        (let [store (kernel/require-service ctx :session/store)
              manager (kernel/require-service ctx :context/manager)
              history [{:role "user" :content (str (apply str (repeat 9000 "x")) "TAIL")}
                       {:role "user" :content "current"}]]
          (append! store history)
          (is (= :summary-failed (:reason (caught #((:compact! manager) {:force true})))))
          (is (= history ((:messages store))))
          (is (not-any? #(= "session/compaction" (:type %)) ((:events store)))))
        (finally (kernel/dispose-all! ctx))))))

(deftest budgeting-resolves-the-provider-and-counts-the-entire-request
  (let [ctx (context (constantly (answer "unused")) {})]
    (try
      (let [manager (kernel/require-service ctx :context/manager)
            registry (kernel/require-service ctx :llm/registry)
            budget! (:budget! manager)
            request {:system-prompt (apply str (repeat 4000 "s"))
                     :tools [{:name "large-schema" :description (apply str (repeat 4000 "t"))}]
                     :messages [{:role "user" :content [{:type :text :text (apply str (repeat 600000 "m"))}
                                                       {:type :image :url "data:image/png;base64,AQIDBA=="}]}]}]
        ((:register! registry) {:id :large :context-window 1000000 :generate (constantly (answer "unused"))})
        ((:alias! registry) :large-alias :large)
        (is (fn? budget!))
        (when budget!
          (let [small (budget! request)]
            (is (= 128000 (:context-window small)))
            (is (false? (:fits? small)))
            (is (> (:system-tokens small) 900))
            (is (> (:tool-tokens small) 900))
            (is (> (:message-tokens small) 154000))
            (is (= (:used-tokens small) (+ (:system-tokens small) (:tool-tokens small) (:message-tokens small)))))
          (is (:fits? (budget! (assoc request :options {:provider :large-alias}))))
          ((:select! registry) :large)
          (is (= 1000000 (:context-window (budget! request))))
          (is (= 300000 (:reserve-tokens (budget! (assoc request :options {:max_output_tokens 300000})))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest unfit-prefix-and-current-instruction-fail-before-any-model-call
  (doseq [request [{:system-prompt (apply str (repeat 520000 "s")) :messages [{:role "user" :content "current"}]}
                   {:tools [{:description (apply str (repeat 520000 "t"))}] :messages [{:role "user" :content "current"}]}
                   {:messages [{:role "user" :content (apply str (repeat 520000 "m"))}]}]]
    (let [calls (atom 0) ctx (context (fn [_] (swap! calls inc) (answer "lossy")) {})]
      (try
        (let [store (kernel/require-service ctx :session/store)
              manager (kernel/require-service ctx :context/manager)]
          (append! store (:messages request))
          (is (= :context_unfit (:code (caught #((:prepare! manager) request)))))
          (is (zero? @calls))
          (is (= (:messages request) ((:messages store)))))
        (finally (kernel/dispose-all! ctx))))))

(deftest oversized-summary-is-rejected-before-checkpoint-commit
  (let [ctx (context (constantly (answer (apply str (repeat 520000 "s")))) {})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)
            history [{:role "user" :content (apply str (repeat 520000 "x"))}
                     {:role "user" :content "current"}]]
        (append! store history)
        (is (= :context_unfit (:code (caught #((:prepare! manager) {:messages history})))))
        (is (= history ((:messages store))))
        (is (not-any? #(= "session/compaction" (:type %)) ((:events store)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest manual-compaction-refuses-prefix-truncation
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session
                                     :config {:retain-messages 1 :max-summary-chars 30}}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            history [{:role "user" :content (str (apply str (repeat 100 "x")) "TAIL")}
                     {:role "user" :content "current"}]]
        (append! store history)
        (is (= :summary-too-large (:reason ((:compact! store)))))
        (is (= history ((:messages store)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest later-chunk-failure-does-not-commit-the-earlier-summary
  (let [calls (atom 0)
        ctx (context (fn [_]
                       (if (= 2 (swap! calls inc)) (throw (ex-info "second chunk failed" {}))
                           (answer "first fragment"))) {:max-source-chars 40})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            manager (kernel/require-service ctx :context/manager)
            history [{:role "user" :content (apply str (repeat 90 "x"))}
                     {:role "user" :content "current"}]]
        (append! store history)
        (is (= :summary-failed (:reason (caught #((:compact! manager) {:force true})))))
        (is (= 2 @calls))
        (is (= history ((:messages store)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest compactor-requests-have-a-budget-and-call-limit-of-their-own
  (doseq [[window max-calls expected] [[900 64 :compacted] [128000 1 :summary-call-limit]]]
    (let [requests (atom [])
          ctx (context (fn [r] (swap! requests conj r) (answer "fragment"))
                       {:reserve-tokens 100 :max-source-chars 300 :max-summary-calls max-calls})]
      (try
        (let [store (kernel/require-service ctx :session/store)
              registry (kernel/require-service ctx :llm/registry)
              manager (kernel/require-service ctx :context/manager)
              history [{:role "user" :content (apply str (repeat 6000 "x"))}
                       {:role "user" :content "current"}]]
          ((:upsert! registry) (assoc ((:current registry)) :context-window window))
          (append! store history)
          (if (= expected :compacted)
            (do
              (is (:compacted ((:compact! manager) {:force true})))
              (is (> (count @requests) 1))
              (is (every? #(:fits? ((:budget! manager) %)) @requests)))
            (do
              (is (= expected (:reason (caught #((:compact! manager) {:force true})))))
              (is (empty? @requests))
              (is (= history ((:messages store)))))))
        (finally (kernel/dispose-all! ctx))))))

(deftest budget-checks-middleware-and-ui-reports-the-dispatched-request
  (doseq [oversized? [false true]]
    (let [calls (atom []) ui (atom nil) holder (atom nil)
          ctx (context (fn [request]
                         (swap! calls conj request)
                         (reset! ui (#'qi.plugins.remote-api/context-status @holder))
                         (answer "done")) {})]
      (reset! holder ctx)
      (try
        (plugin/load-plugin! ctx {:ns 'qi.plugins.runtime :config {:system-prompt "original"}})
        (kernel/intercept! (kernel/plugin-context ctx :test/request-hook) :llm/request
                           (fn [_ request next]
                             (next (assoc request :system-prompt (apply str (repeat (if oversized? 520000 4000) "s"))))))
        (if oversized?
          (do
            (is (= :context_unfit (:code (caught #((kernel/require-service ctx :agent/run) "current")))))
            (is (empty? @calls)))
          (do
            (is (= "done" (:content ((kernel/require-service ctx :agent/run) "current"))))
            (let [budget ((:budget! (kernel/require-service ctx :context/manager)) (first @calls))]
              (is (= (:used-tokens budget) (:used_tokens @ui))))
            (is (= :last-request (:basis @ui)))
            (is (> (:system_tokens @ui) 900))))
        (finally (kernel/dispose-all! ctx))))))

(deftest provider-overflow-with-no-discardable-history-is-not-replayed
  (let [calls (atom 0)
        ctx (context (fn [_] (swap! calls inc) (throw (ex-info "context overflow" {:context-overflow true}))) {})]
    (try
      (plugin/load-plugin! ctx {:ns 'qi.plugins.runtime})
      (is (= :context_unfit (:code (caught #((kernel/require-service ctx :agent/run) "current exact instruction")))))
      (is (= 1 @calls))
      (is (= [{:role "user" :content "current exact instruction"}]
             ((:messages (kernel/require-service ctx :session/store)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest selection-changing-during-compaction-cannot-switch-the-budgeted-provider
  (let [holder (atom nil) calls (atom 0)
        ctx (context (fn [_]
                       (swap! calls inc)
                       ((:select! (kernel/require-service @holder :llm/registry)) :large)
                       (answer "compressed history")) {:reserve-tokens 100})]
    (reset! holder ctx)
    (try
      (let [registry (kernel/require-service ctx :llm/registry)
            manager (kernel/require-service ctx :context/manager)
            store (kernel/require-service ctx :session/store)
            history [{:role "user" :content (apply str (repeat 6000 "x"))}
                     {:role "user" :content "current"}]]
        ((:upsert! registry) (assoc ((:current registry)) :context-window 1000))
        ((:register! registry) {:id :large :context-window 1000000
                               :generate (fn [_] (throw (Exception. "Wrong provider")))})
        (append! store history)
        (let [prepared ((:prepare! manager) {:messages history})]
          (is (> @calls 1))
          (is (= :large (:id ((:current registry)))))
          (is (= :mock (get-in prepared [:options :provider])))
          (is (= 1000 (:context-window ((:budget! manager) prepared))))))
      (finally (kernel/dispose-all! ctx)))))
