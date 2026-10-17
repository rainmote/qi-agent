(ns qi.attachments-test
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.test :refer [deftest is]]
            [qi.attachments :as attachments]
            [qi.env :as qenv]
            [qi.kernel :as kernel]
            [qi.plugin :as plugin]
            [qi.secure-files :as secure])
  (:import [java.security MessageDigest]))

(defn- sha [value]
  (apply str (map #(format "%02x" (bit-and (int %) 255)) (.digest (MessageDigest/getInstance "SHA-256") (.getBytes value "UTF-8")))))

(defn- fixture [f]
  (let [directory (str (fs/real-path (fs/create-temp-dir {:prefix "qi-attachment-test-"})))
        root (str (fs/real-path (fs/create-dirs (fs/path directory "workspace"))))
        store (str (fs/path directory "uploads"))
        id "fixture-upload-0001"
        text "uploaded fixture text"
        block {:type "attachment" :id id :name "note.txt" :mime "text/plain" :size (count text) :workspaceId (subs (sha root) 0 16)}]
    (try
      (secure/protect-directory! store)
      (spit (str (fs/path store (str id ".bin"))) text)
      (spit (str (fs/path store (str id ".json"))) (json/generate-string (assoc block :workspacePath root :sha256 (sha text))))
      (secure/protect-file! (str (fs/path store (str id ".bin"))))
      (secure/protect-file! (str (fs/path store (str id ".json"))))
      (f {:directory directory :root root :store store :block block :text text})
      (finally (fs/delete-tree directory)))))

(deftest uploaded-references-are-workspace-bound-and-integrity-checked
  (fixture (fn [{:keys [directory root store block text]}]
             (is (= block (first (attachments/validate-content! [block]))))
             (is (.contains (:text (attachments/resolve-reference store root block)) text))
             (is (thrown-with-msg? Exception #"belong" (attachments/resolve-reference store directory block)))
             (is (thrown-with-msg? Exception #"Invalid attachment" (attachments/resolve-reference store root (assoc block :id "../escape"))))
             (spit (str (fs/path store (str (:id block) ".bin"))) "tampered")
             (is (thrown-with-msg? Exception #"integrity" (attachments/resolve-reference store root block))))))

(deftest typed-content-rejects-inline-binary-and-empty-messages
  (is (thrown? Exception (attachments/validate-content! [{:type "image" :url "data:image/png;base64,AQID"}])))
  (is (thrown? Exception (attachments/validate-content! [{:type "text" :text "  "}])))
  (is (= "hello" (attachments/validate-content! "hello"))))

(deftest replacing-a-bound-workspace-root-cannot-adopt-another-workspaces-upload
  (fixture
   (fn [{:keys [directory root store block text]}]
     (let [outside (str (fs/real-path (fs/create-dirs (fs/path directory "other-workspace"))))
           outside-id (subs (sha outside) 0 16)
           outside-block (assoc block :workspaceId outside-id)]
       ;; This is a valid upload belonging to the other workspace. Following a
       ;; substituted session root must not transfer that workspace's authority.
       (spit (str (fs/path store (str (:id block) ".json")))
             (json/generate-string (assoc outside-block :workspacePath outside :sha256 (sha text))))
       (is (.contains (:text (attachments/resolve-reference store outside outside-block)) text))
       (fs/move root (fs/path directory "original-workspace"))
       (fs/create-sym-link root outside)
       (is (thrown-with-msg? Exception #"changed|symbolic|canonical|replaced"
                             (attachments/resolve-reference store root outside-block)))))))

(deftest runtime-resolves-for-model-only-and-retains-reference-in-durable-history
  (fixture (fn [{:keys [root store block text]}]
             (let [ctx (kernel/create-context) owner (kernel/plugin-context ctx :fixture) captured (atom nil)]
               (try
                 (kernel/register-service! owner :execution/world {:root root})
                 (kernel/register-service! owner :llm/generate
                                           (fn [request] (reset! captured request) {:message {:role "assistant" :content "done"} :usage {}}))
                 (kernel/mark-loaded! ctx {:id :fixture})
                 (plugin/load-all! ctx [{:ns 'qi.plugins.session} {:ns 'qi.plugins.runtime}])
                 (with-redefs [qenv/get (fn [key & _] (when (= key "QI_AGENT_ATTACHMENT_DIR") store))]
                   ((kernel/require-service ctx :agent/run) [block]))
                 (is (.contains (get-in @captured [:messages 0 :content 0 :text]) text))
                 (let [messages ((:messages (kernel/require-service ctx :session/store)))]
                   (is (= [block] (:content (first messages))))
                   (is (not (.contains (json/generate-string messages) text))))
                 (finally (kernel/dispose-all! ctx)))))))
