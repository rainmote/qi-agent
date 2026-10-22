;; Explicit real component fixture only; not loaded by bb test. This does not
;; forge a packaged manifest or activate user projects. It tests the explicit
;; component seam; runtime/describe and the packaged application are NOT tested.
(require '[babashka.fs :as fs] '[cheshire.core :as json] '[qi.kernel :as kernel]
         '[qi.plugin :as plugin] '[qi.terminal-process :as transport]
         '[qi.plugins.execution-world :as world])
(let [root (System/getenv "QI_PTY_COMPONENT_ROOT") python (System/getenv "QI_PTY_TEST_PYTHON")
      assets {:available? true :python python :helper (str (fs/path root "terminal_helper.py"))
              :root (str (fs/parent (fs/parent python))) :bin (str (fs/parent python))}
      ctx (kernel/create-context) owner (kernel/plugin-context ctx :test/native-component)
      admissions (atom []) factories (atom 0) trusted (atom true)
      factory #(do (swap! factories inc)
                   (transport/controller root assets :seatbelt @#'world/seatbelt-profile :native-process-group))]
  (assert (and root (= root (str (fs/real-path root))) python))
  (kernel/register-service! owner :execution/world
                            {:root root :sandbox :seatbelt :terminal-controller factory
                             :terminal-capability (transport/capability :native-process-group)
                             :workspace-runtime {:available? true :python-version "3.12.14 component"}})
  (kernel/register-service! owner :project/trust {:trusted? #(deref trusted)})
  (kernel/register-service! owner :approval/request (constantly :allow))
  (kernel/register-service! owner :execution/process-admission
                            {:admit! #(do (swap! admissions conj %)
                                         (spit (str (fs/path root "owned-guardian-pids.json")) (json/generate-string @admissions)))})
  (kernel/mark-loaded! ctx {:id :test/native-component})
  (try
    (plugin/load-all! ctx [{:ns 'qi.plugins.remote-registry} {:ns 'qi.plugins.policy} {:ns 'qi.plugins.terminal}])
    (let [rpc (fn [method args] ((:invoke! (kernel/service ctx :remote/registry)) method args))
          cancelled (str (random-uuid))]
      (assert (:cancelled (rpc "terminal.cancel" {:request_id cancelled})))
      (assert (try (rpc "terminal.execute" {:action "open" :request_id cancelled}) false (catch Exception _ true)))
      (assert (and (zero? @factories) (empty? @admissions)))
      (let [opened (rpc "terminal.execute" {:action "open" :request_id (str (random-uuid))}) id (:terminal_id opened)
            input-cancelled (str (random-uuid))]
        (assert (= "running" (:status opened)))
        (assert (= "registered-process-groups" (:cleanup_scope opened)))
        (assert (false? (:descendant_containment opened)))
        (rpc "terminal.cancel" {:request_id input-cancelled})
        (assert (try (rpc "terminal.execute" {:action "input" :terminal_id id :request_id input-cancelled
                                             :text "touch must-not-exist\n"}) false (catch Exception _ true)))
        (rpc "terminal.execute" {:action "input" :terminal_id id :request_id (str (random-uuid))
                                  :text "printf '\\161\\151-real-rpc-ok\\n'\n"})
        (loop [attempt 0 cursor 0 output ""]
          (assert (< attempt 60) "real PTY output deadline")
          (let [result (rpc "terminal.read" {:terminal_id id :since cursor})
                output (str output (:output result))]
            (when-not (.contains output "qi-real-rpc-ok")
              (Thread/sleep 25) (recur (inc attempt) (:cursor result) output))))
        (assert (not (fs/exists? (fs/path root "must-not-exist"))))
        (reset! trusted false) ;; In-memory fixture only, never a real trust store.
        (assert (try (rpc "terminal.execute" {:action "open"}) false (catch Exception _ true)))
        (let [one (future (rpc "terminal.stop" {:terminal_id id}))
              two (future (rpc "terminal.stop" {:terminal_id id}))
              closed (deref one 7000 nil) repeated (deref two 7000 nil)]
          (assert (and (:cleanup_confirmed closed) (:cleanup_observed closed) (:shell_exit_observed closed)))
          (assert (= "closed" (:status repeated)))
          (assert (= 1 @factories))
          (spit (str (fs/path root "result.json"))
                (json/generate-string {:status "REAL_COMPONENT_RPC_PASS" :cancelled_before_admission true
                                       :input_cancelled_before_dispatch true :trust_revoked true :concurrent_close true :admissions @admissions
                                       :sandbox "seatbelt" :mode "native-process-group" :closed closed})))))
    (finally (kernel/dispose-all! ctx))))
