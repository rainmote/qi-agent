(ns qi.web-test
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing]]))

(defn- delete-tree! [file]
  (when (.exists ^java.io.File file)
    (doseq [child (reverse (file-seq file))]
      (.delete ^java.io.File child))))

(deftest session-events-have-stable-cursors-and-subscriptions
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "qi-agent-web-session-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        path (str (io/file directory "session.jsonl"))
        ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.session :config {:path path}}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)
            observed (atom [])
            dispose ((:subscribe! store) #(swap! observed conj %))
            event ((:append! store) "message"
                   {:message {:role "user" :content "hello"}})]
        (is (= 1 (:seq (first ((:events store))))))
        (is (= 2 (:seq event)))
        (is (= [event] ((:events-after store) 1)))
        (is (= [event] @observed))
        (dispose)
        ((:append! store) "step/start" {:step 1})
        (is (= 1 (count @observed))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest remote-registry-validates-and-unregisters-methods
  (let [ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.remote-registry}]})]
    (try
      (let [registry (kernel/require-service ctx :remote/registry)
            dispose
            ((:register! registry)
             {:method "demo.echo"
              :description "Echo a value."
              :params-schema {:type "object" :required ["value"]
                              :properties {"value" {:type "string"}}
                              :additionalProperties false}
              :result-schema {:type "object"}
              :handler (fn [{:keys [value]}] {:value value})})]
        (is (= {:value "ok"} ((:invoke! registry) "demo.echo" {:value "ok"})))
        (is (thrown-with-msg? clojure.lang.ExceptionInfo
                              #"Invalid remote method parameters"
                              ((:invoke! registry) "demo.echo" {})))
        (dispose)
        (is (nil? ((:method registry) "demo.echo"))))
      (finally (kernel/dispose-all! ctx)))))

(deftest remote-interactions-resolve-without-consuming-rpc-input
  (let [ctx (plugin/boot!
             {:plugins [{:ns 'qi.plugins.remote-registry}
                        {:ns 'qi.plugins.remote-interaction
                         :config {:timeout-ms 2000}}]})]
    (try
      (let [prompt (kernel/require-service ctx :ui/prompt)
            registry (kernel/require-service ctx :remote/registry)
            result (future
                     ((:select! prompt)
                      {:title "Approve?" :message "target"
                       :items [{:label "Allow" :value :allow}
                               {:label "Deny" :value :deny}]
                       :default :deny}))]
        (loop [attempt 0]
          (when (and (< attempt 50)
                     (empty? ((:invoke! registry) "interaction.list" {})))
            (Thread/sleep 10)
            (recur (inc attempt))))
        (let [request (first ((:invoke! registry) "interaction.list" {}))]
          (is (string? (:id request)))
          (is (= true
                 (:resolved ((:invoke! registry) "interaction.resolve"
                             {:id (:id request) :decision "allow"}))))
          (is (= :allow (deref result 1000 :timeout)))))
      (finally (kernel/dispose-all! ctx)))))
