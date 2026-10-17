(ns qi.web-tools-test
  (:require [cheshire.core :as json]
            [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [org.httpkit.server :as server]
            [qi.cancellation :as cancellation]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.plugins.web-tools :as web])
  (:import [java.net InetAddress URI]))

(defn fixture [& [config]]
  (let [ctx (kernel/create-context) owner (kernel/plugin-context ctx :test/web)]
    (kernel/register-service! owner :project/trust {:trusted? (constantly true)})
    (plugin/load-all! ctx [{:ns 'qi.plugins.policy} {:ns 'qi.plugins.remote-registry}
                          {:ns 'qi.plugins.web-tools :config (or config {})}])
    {:ctx ctx :runtime (kernel/service ctx :web/runtime)}))
(defn data-of [f] (try (f) nil (catch Throwable e (ex-data e))))

(deftest rejects-non-public-and-special-addresses
  (doseq [address ["0.0.0.0" "10.0.0.1" "127.0.0.1" "169.254.169.254" "172.16.1.1" "192.168.1.1"
                   "100.64.0.1" "192.0.2.1" "198.18.0.1" "198.51.100.1" "203.0.113.1" "224.0.0.1"
                   "::" "::1" "fd00::1" "fe80::1" "::ffff:127.0.0.1" "2002:7f00:1::" "2001:db8::1"]]
    (is (false? (web/public-address? (InetAddress/getByName address))) address))
  (is (web/public-address? (InetAddress/getByName "8.8.8.8")))
  (is (web/public-address? (InetAddress/getByName "2606:4700:4700::1111"))))

(deftest unsafe-urls-never-start-network-request
  (let [{:keys [ctx runtime]} (fixture) requests (atom 0)]
    (try
      (with-redefs [web/pinned-request! (fn [& _] (swap! requests inc))]
        (doseq [url ["file:///etc/passwd" "http://localhost/a" "http://127.0.0.1/a" "http://2130706433/a"
                     "http://0177.0.0.1/a" "http://0x7f.0.0.1/a" "http://127.1/a" "http://127.0.0.1./a"
                     "http://169.254.169.254/latest" "http://[::1]/a" "http://u:p@example.com/a"
                     "http://example.com/#x" "https://example.com\nInjected: yes"]]
          (is (some? (data-of #((:fetch! runtime) url {}))) url)))
      (is (zero? @requests))
      (finally (kernel/dispose-all! ctx)))))

(deftest curl-cannot-reinterpret-octal-host-around-pinning
  (let [requests (atom 0)
        stop (server/run-server (fn [_] (swap! requests inc) {:status 200 :body "private"}) {:ip "127.0.0.1" :port 0})
        port (:local-port (meta stop))]
    (try
      (doseq [host ["0177.0.0.1" "0x7f.0.0.1" "127.1" "2130706433" "127.0.0.1."]]
        (is (= :unsafe-url
               (:web/error (data-of #(web/pinned-request!
                                     {:url (str "http://" host ":" port "/") :host host :port port :address "192.0.2.1"}
                                     {:curl-path "/usr/bin/curl" :timeout-ms 500 :max-response-bytes 2048})))) host))
      (is (zero? @requests))
      (finally (stop)))))

(deftest html-removes-active-and-hidden-content
  (let [text (web/html-text "<html><head><title>head-secret</title></head><body><h1>Visible</h1><script>alert('secret')</script><style>hidden</style><div hidden>private</div><p aria-hidden='true'>concealed</p><div style='display:none'>buried</div><template>template-secret</template><iframe>frame-secret</iframe><p>Read &amp; cite <b>this</b>.</p></body></html>")]
    (is (str/includes? text "Visible"))
    (is (str/includes? text "Read & cite this."))
    (doseq [hidden ["secret" "hidden" "private" "concealed" "buried"]]
      (is (not (str/includes? text hidden))))))

(deftest mock-http-fetch-uses-pinned-target-and-rejects-redirect
  (let [requests (atom [])
        stop (server/run-server (fn [request]
                                  (swap! requests conj request)
                                  (case (:uri request)
                                    "/redirect" {:status 302 :headers {"location" "http://127.0.0.1/secret"} :body "redirect"}
                                    "/huge" {:status 200 :headers {"content-type" "text/plain"} :body (apply str (repeat 3000 "x"))}
                                    {:status 200 :headers {"content-type" "text/html"} :body "<h1>Fixture</h1><script>do-not-display</script><p>source</p>"}))
                                {:ip "127.0.0.1" :port 0})
        port (:local-port (meta stop))
        base (str "http://fixture.example.com:" port)
        {:keys [ctx runtime]} (fixture {:max-response-bytes 2048 :max-output-chars 130})]
    (try
      ;; Only this test replaces DNS validation; the real curl request still
      ;; uses --resolve, sends the named Host, and never follows Location.
      (with-redefs [web/resolve-public-url (fn [url] {:url url :host "fixture.example.com" :port port :address "127.0.0.1"})]
        (let [result ((:fetch! runtime) (str base "/") {})]
          (is (= 200 (:status result)))
          (is (str/includes? (:text result) "External untrusted"))
          (is (not (str/includes? (:text result) "do-not-display")))
          (is (= (str "fixture.example.com:" port) (get-in (first @requests) [:headers "host"]))))
        (is (= :redirect (:web/error (data-of #((:fetch! runtime) (str base "/redirect") {})))))
        (is (= :response-too-large (:web/error (data-of #((:fetch! runtime) (str base "/huge") {}))))))
      (is (= ["/" "/redirect" "/huge"] (mapv :uri @requests)))
      (finally (kernel/dispose-all! ctx) (stop)))))

(deftest search-is-opt-in-and-credentials-never-enter-public-result
  (let [{:keys [ctx runtime]} (fixture) called (atom 0)]
    (try
      (with-redefs [web/pinned-request! (fn [& _] (swap! called inc))]
        (is (= :not-configured (:web/error (data-of #((:search! runtime) "test" {}))))))
      (is (zero? @called))
      (finally (kernel/dispose-all! ctx))))
  (let [seen (atom nil) secret "offline-test-key-only"
        {:keys [ctx runtime]} (fixture {:search {:enabled true :provider :tavily :api-key secret}})]
    (try
      (with-redefs [web/resolve-public-url (fn [url] {:url url})
                    web/pinned-request! (fn [target options]
                                          (reset! seen [target options])
                                          {:status 200 :headers {"content-type" "application/json"}
                                           :body (json/generate-string {:request_id "offline-id"
                                                                        :results [{:title "Fixture source" :url "https://example.com/page" :content "evidence"}]})})]
        (let [result ((:search! runtime) "offline query" {})]
          (is (= "tavily" (:provider result)))
          (is (= "https://example.com/page" (get-in result [:sources 0 :url])))
          (is (str/includes? (:text result) "evidence"))
          (is (= secret (get-in @seen [1 :authorization])))
          (is (= "basic" (:search_depth (json/parse-string (get-in @seen [1 :body]) true))))
          (is (not (str/includes? (pr-str result) secret)))
          (is (not (str/includes? (pr-str ((:status runtime))) secret)))))
      (is (:requires-approval (kernel/tool ctx "web_search")))
      (finally (kernel/dispose-all! ctx)))))

(deftest cancellation-aborts-curl-without-retry
  (let [started (promise) token (cancellation/create-token) calls (atom 0)
        stop (server/run-server (fn [_] (swap! calls inc) (deliver started true)
                                  (try (Thread/sleep 1000) (catch InterruptedException _))
                                  {:status 200 :body "late"}) {:ip "127.0.0.1" :port 0})
        port (:local-port (meta stop)) url (str "http://fixture.example.com:" port "/")
        {:keys [ctx runtime]} (fixture)]
    (try
      (with-redefs [web/resolve-public-url (fn [_] {:url url :host "fixture.example.com" :port port :address "127.0.0.1"})]
        (let [task (future (try ((:fetch! runtime) url {:cancel-token token}) (catch Throwable _ :cancelled)))]
          (is (deref started 1500 false))
          (cancellation/cancel! token)
          (is (= :cancelled (deref task 2000 :timeout)))))
      (is (= 1 @calls))
      (finally (kernel/dispose-all! ctx) (stop)))))

(deftest deadline-prevents-a-late-dns-answer-from-starting-curl
  (let [release (promise) finished (promise) calls (atom 0)
        stop (server/run-server (fn [_] (swap! calls inc) {:status 200 :body "late"}) {:ip "127.0.0.1" :port 0})
        port (:local-port (meta stop)) url (str "http://fixture.example.com:" port "/")
        original web/pinned-request!
        {:keys [ctx runtime]} (fixture {:timeout-ms 20})]
    (try
      (with-redefs [web/resolve-public-url (fn [_]
                                           ;; Simulate a DNS resolver that finishes after its caller's deadline.
                                           (try @release (catch InterruptedException _ @release))
                                           {:url url :host "fixture.example.com" :port port :address "127.0.0.1"})
                    web/pinned-request! (fn [target options]
                                          (try (original target options) (finally (deliver finished true))))]
        (is (= :timeout (:web/error (data-of #((:fetch! runtime) url {})))))
        (deliver release true)
        (is (deref finished 1000 false)))
      (is (zero? @calls))
      (finally (deliver release true) (kernel/dispose-all! ctx) (stop)))))
