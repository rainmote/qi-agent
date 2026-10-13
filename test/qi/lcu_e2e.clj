(ns qi.lcu-e2e
  "Opt-in macOS E2E: real qì loop -> LCU -> native UI -> independent file oracle.
  Default planner is deterministic. QI_LCU_E2E_MODEL selects a live ChatGPT model."
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.string :as str]
            [qi.kernel :as kernel]
            [qi.mcp-stdio :as mcp]
            [qi.plugin :as plugin])
  (:import [java.util Base64]))

(defn- check! [condition message]
  (when-not condition (throw (ex-info message {}))))

(defn- fixture-app! [root app-id]
  (let [bundle (fs/path root "QiLCUE2E.app" "Contents")
        executable (fs/path bundle "MacOS" "QiLCUE2E")]
    (fs/create-dirs (fs/parent executable))
    (process/check (process/shell "swiftc" "test/fixtures/lcu-desktop.swift" "-o" (str executable)))
    (spit (str (fs/path bundle "Info.plist"))
          (str "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>"
               "<key>CFBundleExecutable</key><string>QiLCUE2E</string>"
               "<key>CFBundleIdentifier</key><string>" app-id "</string>"
               "<key>CFBundleName</key><string>Qi LCU E2E</string>"
               "<key>CFBundlePackageType</key><string>APPL</string>"
               "<key>CFBundleVersion</key><string>1</string>"
               "<key>NSHighResolutionCapable</key><true/></dict></plist>"))
    executable))

(defn- element! [text id]
  (or (some-> (re-find (re-pattern (str "(?m)^\\s*(\\d+) [^\\n]*ID: " id "(?:\\s|$)")) text)
              second parse-long)
      (throw (ex-info "Expected fixture control absent from fresh AX observation" {:id id}))))

(defn- planner [marker requests app-id]
  (let [step (atom -1)
        keyboard-marker (str/replace marker "中文-" "")]
    (fn [request]
      (swap! requests conj request)
      (let [n (swap! step inc)
            last-tool (last (filter #(= "tool" (:role %)) (:messages request)))
            text (:content last-tool)
            code (case n
                   0 (str "var app = await cua.getApp(" (json/generate-string app-id) ")")
                   1 "await app.getAXStateAndScreenshot({disableDiffing:true})"
                   2 (str "await app.click(" (element! text "marker-input") "); "
                          "await app.typeText(" (json/generate-string keyboard-marker) "); "
                          "await app.getAXState({disableDiffing:true})")
                   3 (do
                       (check! (str/includes? text (str "Value: " keyboard-marker))
                               "Keyboard input was not observed in the native field")
                       (str "await app.setValue(" (element! text "marker-input") ","
                            (json/generate-string marker) "); "
                            "await app.getAXState({disableDiffing:true})"))
                   4 (str "await app.click(" (element! text "verify-button") "); "
                          "await app.getAXStateAndScreenshot({disableDiffing:true})")
                   nil)]
        (check! (str/includes? (:system-prompt request) "initialized cua API")
                "Original LCU instructions did not reach the planner")
        (if code
          {:message {:role "assistant" :tool_calls
                     [{:id (str "desktop-" n) :type "function"
                       :function {:name "computer_js" :arguments {:code code}}}]}
           :finish-reason "tool_calls"}
          (do
            (check! (str/includes? text (str "Verified: " marker)) "Final UI verification failed")
            (check! (seq (:images last-tool)) "Final screenshot did not reach the planner")
            {:message {:role "assistant" :content "Verified the marker in the native app."}
             :finish-reason "stop"}))))))

(defn -main [& _]
  (check! (= "Mac OS X" (System/getProperty "os.name")) "This desktop E2E fixture requires macOS")
  (let [root (fs/create-temp-dir {:dir (str (fs/create-dirs ".qi-agent/lcu-e2e")) :prefix "run-"})
        root (fs/absolutize root)
        app-id (str "dev.qi.lcu-e2e." (random-uuid))
        executable (fixture-app! root app-id)
        oracle (str (fs/path root "result.json"))
        marker (str "qi-LCU-中文-" (random-uuid))
        app (process/process [(str executable) oracle] {:out :string :err :string})
        ctx (kernel/create-context)
        owner (kernel/plugin-context ctx :test/desktop-e2e)
        requests (atom [])
        cleanup (atom [])
        pids (atom [])
        real-connect mcp/connect!
        live-model (System/getenv "QI_LCU_E2E_MODEL")]
    (try
      (loop [left 100]
        (when-not (fs/exists? (str oracle ".ready"))
          (check! (pos? left) "Fixture app did not start")
          (Thread/sleep 100)
          (recur (dec left))))
      (kernel/register-service! owner :execution/world {:provider :local :sandbox :none :root (str root)})
      ;; These grants exist only in this disposable test context. Never modify
      ;; the user's trust store, approval policy or persistent app grants.
      (kernel/register-service! owner :project/trust {:trusted? (constantly true)})
      (kernel/register-service! owner :approval/request
                                (fn [r] (if (= "lcu" (get-in r [:target :provider])) :allow :deny)))
      (kernel/register-service! owner :ui/prompt
                                {:select! (fn [r]
                                            (check! (= (str "Computer use: " app-id) (:title r))
                                                    "E2E refuses consent for any app except its own fixture")
                                            :allow)})
      (kernel/on! owner :computer-use/turn-ended (fn [_ event] (swap! cleanup conj event)))
      (kernel/mark-loaded! ctx {:id :test/desktop-e2e})
      (if live-model
        (do
          (plugin/load-all! ctx [{:ns 'qi.plugins.auth-store}
                                 {:ns 'qi.plugins.model-registry :config {:default-provider :chatgpt}}
                                 {:ns 'qi.plugins.chatgpt
                                  :config {:model live-model :timeout-ms 180000
                                           :extra-body {:reasoning {:effort "low"}}}}])
          (kernel/intercept! owner :llm/request 2000
                             (fn [_ request next] (swap! requests conj request) (next request))))
        (do
          (kernel/register-service! owner :llm/registry
                                    {:current (constantly {:id :e2e :input-modalities #{:text :image}})})
          (kernel/register-service! owner :llm/generate (planner marker requests app-id))))
      (with-redefs [mcp/connect! (fn [options]
                                  (let [c (real-connect options)] (swap! pids conj (:pid c)) c))]
        (plugin/load-all! ctx [{:ns 'qi.plugins.session :config {:path (str (fs/path root "session.jsonl"))}}
                               {:ns 'qi.plugins.policy}
                               {:ns 'qi.plugins.computer-use}
                               {:ns 'qi.plugins.lcu :config {:enabled true :request-timeout-ms 150000}}
                               {:ns 'qi.plugins.runtime :config {:max-steps 15}}]))
      ((kernel/require-service ctx :agent/run)
       (str "Use computer_js and only the native fixture app " app-id " (Qi LCU E2E). "
            "Observe its controls and capture a screenshot, click the marker field, type exactly "
            (json/generate-string marker) ", then click Verify. Observe the resulting Verified status "
            "and capture a final screenshot. Do not use any other app or access files. "
            "Stop once the marker is visibly verified."))
      (check! (fs/exists? oracle) "UI button did not produce the independent oracle file")
      (check! (= {:marker marker :clicked true} (json/parse-string (slurp oracle) true))
              "Independent file oracle does not match typed marker")
      (check! (= ["Stop"] (mapv :event @cleanup)) "Original LCU turn cleanup did not succeed")
      (let [messages ((:messages (kernel/service ctx :session/store)))
            images (vec (mapcat :images messages))
            final-ui (last (filter #(and (= "tool" (:role %))
                                         (str/includes? (or (:content %) "") (str "Verified: " marker))) messages))]
        (check! final-ui "Fresh UI observation did not contain the verified marker")
        (check! (>= (count images) 2) "Before/after screenshots missing")
        (doseq [[index image] (map-indexed vector images)]
          (let [[_ mime data] (re-matches #"data:([^;]+);base64,(.+)" (:url image))
                extension (get {"image/png" "png" "image/jpeg" "jpg" "image/webp" "webp"} mime "bin")]
            (with-open [out (java.io.FileOutputStream. (str (fs/path root (str "screenshot-" index "." extension))))]
              (.write out (.decode (Base64/getDecoder) ^String data)))))
        (kernel/dispose-all! ctx)
        (check! (empty? (kernel/tools ctx)) "Desktop tools survived disposal")
        (doseq [pid @pids]
          (let [p (java.lang.ProcessHandle/of pid)]
            (check! (not (and (.isPresent p) (.isAlive (.get p)))) "LCU bridge survived disposal")))
        (let [report {:passed true :planner (or live-model "deterministic (no model API)")
                      :marker marker :oracle oracle :screenshots (count images)
                      :model-requests (count @requests) :cleanup @cleanup :processes-reaped true}]
          (spit (str (fs/path root "report.json")) (json/generate-string report {:pretty true}))
          (println (json/generate-string report {:pretty true}))
          (println "Evidence:" (str root))))
      (finally (kernel/dispose-all! ctx) (process/destroy-tree app)))))
