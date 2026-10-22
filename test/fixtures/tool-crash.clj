;; Offline subprocess fixture: one real effect, then an abrupt process exit before
;; runtime can persist the result. Never calls a model or an external service.
(require '[qi.kernel :as kernel] '[qi.plugin :as plugin])
(let [[session-path effect-path] *command-line-args*
      ctx (plugin/boot! {:plugins [{:ns 'qi.plugins.session :config {:path session-path}}
                                  {:ns 'qi.plugins.mock :config {:responses
                                    [{:message {:role "assistant" :tool_calls
                                       [{:id "a" :type "function" :function {:name "probe" :arguments "{}"}}]}
                                      :finish-reason "tool_calls"}]}}
                                  {:ns 'qi.plugins.runtime}]})]
  (kernel/register-tool! (kernel/plugin-context ctx :fixture/probe)
                        {:name "probe" :description "Offline crash fixture" :parameters {:type "object"}
                         :execute (fn [_ _] (spit effect-path "effect\n" :append true) (System/exit 73))})
  ((kernel/require-service ctx :agent/run) "Perform the fixture effect once."))
