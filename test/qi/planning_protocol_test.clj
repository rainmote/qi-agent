(ns qi.planning-protocol-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]))

(defn- wait-for [messages predicate]
  (loop [left 300]
    (if-let [message (some #(when (predicate %) %) @messages)]
      message
      (if (zero? left) (throw (ex-info "RPC fixture timed out" {:received @messages}))
          (do (Thread/sleep 10) (recur (dec left)))))))

(deftest real-worker-resolves-an-interaction-while-plan-submit-is-pending
  (let [directory (fs/create-temp-dir {:prefix "qi-planning-rpc-"})
        config (str (fs/path directory "agent.edn"))
        _ (spit config
                (pr-str {:plugins [{:ns 'qi.plugins.session :config {:path (str (fs/path directory "session.jsonl"))}}
                                   {:ns 'qi.plugins.mock :config {:responses []}}
                                   {:ns 'qi.plugins.durable-state :config {:root (str directory)}}
                                   {:ns 'qi.plugins.runtime}
                                   {:ns 'qi.plugins.remote-registry}
                                   {:ns 'qi.plugins.remote-interaction :config {:timeout-ms 10000}}
                                   {:ns 'qi.plugins.planning}]}))
        process (.start (doto (ProcessBuilder.
                              ^java.util.List [(str (fs/which "bb")) "-cp"
                                              (str/join java.io.File/pathSeparator
                                                        (map #(str (fs/absolutize %)) ["src" "plugins"]))
                                              "-m" "qi.cli" "--config" config "--mode" "rpc"])
                          (.directory (io/file (str directory)))))
        writer (io/writer (.getOutputStream process))
        messages (atom [])
        reader-task (future
                      (with-open [reader (io/reader (.getInputStream process))]
                        (doseq [line (line-seq reader)]
                          (when-not (str/blank? line) (swap! messages conj (json/parse-string line true))))))
        errors (future (slurp (.getErrorStream process)))
        send! (fn [id method params]
                (.write writer (str (json/generate-string {:id id :method method :params params}) "\n"))
                (.flush writer))
        response #(wait-for messages (fn [entry] (and (= "response" (:type entry)) (= % (:id entry)))))]
    (try
      (let [ready (wait-for messages #(= "ready" (:type %)))]
        (is (some #{"planning.submit"} (:methods ready))))
      (send! "create" "planning.create" {:title "Review then act" :steps [{:id "one" :title "Inspect"}]})
      (is (true? (:ok (response "create"))))
      (send! "submit" "planning.submit" {:expected_revision 0})
      (let [request (wait-for messages #(= "interaction/request" (:event %)))
            interaction-id (get-in request [:data :id])]
        (is (string? interaction-id))
        (is (not-any? #(= "submit" (:id %)) @messages))
        (send! "show-pending" "planning.show" {})
        (is (= "awaiting_approval" (get-in (response "show-pending") [:result :plan :status])))
        (send! "resolve" "interaction.resolve" {:id interaction-id :decision "allow"})
        (is (true? (:ok (response "resolve"))))
        (is (= "approved" (get-in (response "submit") [:result :plan :status]))))
      ;; Repeated cancellation uses the real shared session writer, so an
      ;; accidental Future interruption cannot hide behind a stub append!.
      (doseq [round (range 6)]
        (send! (str "before-" round) "planning.show" {})
        (let [revision (get-in (response (str "before-" round)) [:result :plan :revision])
              seen-ids (set (keep #(when (= "interaction/request" (:event %)) (get-in % [:data :id])) @messages))]
          (send! (str "pause-" round) "planning.pause" {:expected_revision revision})
          (is (true? (:ok (response (str "pause-" round)))))
          (send! (str "pending-" round) "planning.submit" {:expected_revision (inc revision)})
          (let [request (wait-for messages #(and (= "interaction/request" (:event %))
                                                 (not (contains? seen-ids (get-in % [:data :id])))))]
            (send! (str "while-pending-" round) "planning.show" {})
            (is (= "awaiting_approval" (get-in (response (str "while-pending-" round)) [:result :plan :status])))
            (send! (str "cancel-prompt-" round) "planning.pause" {:expected_revision (+ revision 2)})
            (is (true? (:ok (response (str "cancel-prompt-" round)))))
            (is (false? (:ok (response (str "pending-" round)))))
            (is (get-in (wait-for messages #(and (= "interaction/resolved" (:event %))
                                                 (= (get-in request [:data :id]) (get-in % [:data :id]))))
                        [:data :cancelled])))))
      (send! "shutdown" "shutdown" {})
      (is (true? (:ok (response "shutdown"))))
      (is (.waitFor process 3 java.util.concurrent.TimeUnit/SECONDS))
      (is (= 0 (.exitValue process)) (deref errors 1000 "stderr unavailable"))
      (finally
        (try (.close writer) (catch Throwable _))
        (when (.isAlive process) (.destroyForcibly process))
        (.waitFor process 3 java.util.concurrent.TimeUnit/SECONDS)
        (deref reader-task 1000 nil)
        (fs/delete-tree directory)))))
