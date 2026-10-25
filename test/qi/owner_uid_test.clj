(ns qi.owner-uid-test
  (:require [babashka.classpath :as classpath]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.test :refer [deftest is]]))

(defn- probe-owner-boundary [user-name]
  (let [home (fs/create-temp-dir {:prefix "qi-owner-uid-home-"})
        program
        (str
         (when user-name (pr-str `(System/setProperty "user.name" ~user-name)))
         "\n"
         (pr-str
          '(do
             (require '[qi.secure-files :as secure] '[babashka.fs :as fs]
                      '[cheshire.core :as json])
             (let [directory (fs/create-temp-dir {:prefix "qi-owner-uid-files-"})
                   private-file (fs/file directory "private.txt")
                   public-file (fs/file directory "public.txt")
                   linked-file (fs/file directory "linked.txt")
                   contents "synthetic-owner-boundary-fixture\n"
                   outcome (fn [run]
                             (try {:value (run)}
                                  (catch Throwable error
                                    {:error (or (:code (ex-data error)) :unexpected-error)
                                     :message (.getMessage error)})))]
               (try
                 (spit private-file contents)
                 (fs/set-posix-file-permissions private-file "rw-------")
                 (spit public-file contents)
                 (fs/set-posix-file-permissions public-file "rw-r--r--")
                 (fs/create-sym-link linked-file private-file)
                 (println
                  (json/generate-string
                   {:user-name (System/getProperty "user.name")
                    :private-check (outcome #(= (str private-file) (secure/assert-owner-file! private-file)))
                    :private-read (outcome #(secure/read-owner-file-text! private-file))
                    :public-check (outcome #(secure/assert-owner-file! public-file))
                    :public-read (outcome #(secure/read-owner-file-text! public-file))
                    :link-check (outcome #(secure/assert-owner-file! linked-file))
                    :link-read (outcome #(secure/read-owner-file-text! linked-file))}))
                 (finally (fs/delete-tree directory)))))))
        child (atom nil)]
    (try
      (reset! child
              (process/process ["bb" "--classpath" (classpath/get-classpath) "-e" program]
                               {:out :string :err :string
                                :env {"PATH" (System/getenv "PATH")
                                      "HOME" (str home) "LANG" "C.UTF-8"}}))
      (let [result (deref @child 10000 ::timeout)]
        (is (not= ::timeout result) "isolated owner checks must finish; a timeout is not valid target red")
        (when-not (= ::timeout result)
          (is (zero? (:exit result)) (:err result))
          (when (zero? (:exit result))
            (let [report (json/parse-string (:out result) true)]
              (is (= (or user-name (System/getProperty "user.name")) (:user-name report)))
              (is (= {:value true} (:private-check report))
                  "a current-UID 0600 file must pass validation independently of user.name")
              (is (= {:value "synthetic-owner-boundary-fixture\n"} (:private-read report))
                  "a current-UID 0600 file must remain readable independently of user.name")
              (doseq [operation [:public-check :public-read :link-check :link-read]]
                (is (= "insecure-credentials" (get-in report [operation :error]))
                    (str operation " must keep the private-file boundary")))))))
      (finally
        (when @child
          (when (.isAlive (:proc @child))
            (process/destroy-tree @child)
            (when-not (.waitFor (:proc @child) 1 java.util.concurrent.TimeUnit/SECONDS)
              (.destroyForcibly (:proc @child))))
          (is (.waitFor (:proc @child) 3 java.util.concurrent.TimeUnit/SECONDS)
              "the isolated fixture process must exit during cleanup"))
        (fs/delete-tree home)))))

(deftest current-owner-with-native-account-mapping
  ;; This same case covers a real Linux UID without a passwd entry when the
  ;; frozen suite is run as that UID; no particular native name is assumed.
  (probe-owner-boundary nil))

(deftest current-owner-with-missing-account-name
  (probe-owner-boundary "?"))

(deftest current-owner-with-account-alias
  (probe-owner-boundary "qi-owner-test-account-alias"))
