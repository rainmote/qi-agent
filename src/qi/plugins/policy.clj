(ns qi.plugins.policy
  (:require [qi.kernel :as kernel]
            [qi.tool-contract :as contract]))

(defn- record-decision! [ctx data]
  (when-let [store (kernel/service ctx :session/store)]
    (let [event ((:append! store) "approval/decision" data)]
      (kernel/emit! ctx :session/event event))))

(defn- deny [request reason terminate-on-deny]
  (assoc request
         :decision :deny
         :reason reason
         :terminate terminate-on-deny))

(def plugin
  {:id :policy/tool-gate
   :description "Tool deny-list, project trust, and approval gate."
   :provides #{:tool/policy}
   :start
   (fn [ctx {:keys [deny-tools trusted-tools approval-tools terminate-on-deny]
             :or {deny-tools []
                  trusted-tools []
                  approval-tools []
                  terminate-on-deny false}}]
     (let [denied (set deny-tools)
           trust-required (set trusted-tools)
           approval-required (set approval-tools)
           receipts (atom {})
           member? (fn [configured request]
                     (let [tool-name (get-in request [:execution :name])]
                       (or (contains? configured tool-name)
                           (and (contains? #{"terminal" "office_preview"} tool-name)
                                (contains? configured "bash")))))
           needs-approval? #(or (member? approval-required %) (true? (get-in % [:tool :requires-approval])))]
       (kernel/register-service! ctx :tool/policy {:metadata-gates true :release! #(swap! receipts dissoc %)})
       (kernel/track-effect! ctx #(reset! receipts {}))
       (kernel/register-tool-guard!
        ctx (fn [_ request]
              (let [trust (kernel/service ctx :project/trust)]
                (cond
                  (member? denied request) {:reason "Denied by configured tool policy." :terminate terminate-on-deny}
                  (and (or (member? trust-required request) (true? (get-in request [:tool :requires-trust])))
                       (not (and trust ((:trusted? trust)))))
                  {:reason "Tool requires a trusted project; use /trust allow to enable it." :terminate terminate-on-deny}
                  (and (needs-approval? request)
                       (let [receipt (get @receipts (get-in request [:execution :token]))]
                         (or (not= (:identity receipt) (contract/identity-of request))
                             (not (identical? (:approver receipt) (kernel/service ctx :approval/request))))))
                  {:reason "Tool approval is missing or no longer matches this invocation." :terminate terminate-on-deny}
                  :else nil))))
       (kernel/intercept!
        ctx :tool/pre-execute -100
        (fn [_ request next]
          (let [tool-name (get-in request [:execution :name])
                names (cond-> #{tool-name} (contains? #{"terminal" "office_preview"} tool-name) (conj "bash"))
                member? (fn [configured] (some #(contains? configured %) names))
                trust (kernel/service ctx :project/trust)]
            (cond
              (member? denied)
              (deny request "Denied by configured tool policy."
                    terminate-on-deny)

              (and (or (member? trust-required)
                       (true? (get-in request [:tool :requires-trust])))
                   (not (and trust ((:trusted? trust)))))
              (deny request
                    "Tool requires a trusted project; use /trust allow to enable it."
                    terminate-on-deny)

              (or (member? approval-required)
                  (true? (get-in request [:tool :requires-approval])))
              (let [approve (kernel/service ctx :approval/request)
                    approval-request
                    {:tool tool-name
                     :name tool-name
                     :call-id (get-in request [:execution :call-id])
                     :cancel-token (get-in request [:execution :cancel-token])
                     :arguments (get-in request [:execution :arguments])
                     :target (get-in request [:execution :approval])
                     :execution-token (get-in request [:execution :token])}
                    _ (kernel/emit!
                       ctx :tool.execution/confirming
                       {:execution-id (:execution-token approval-request)
                        :call-id (:call-id approval-request)
                        :name tool-name})
                    decision (if approve
                               (approve approval-request)
                               :deny)]
                (record-decision!
                 ctx (assoc (dissoc approval-request :cancel-token)
                            :decision decision))
                (if (= :allow decision)
                  (do (when-let [token (get-in request [:execution :token])]
                        (swap! receipts assoc token {:identity (contract/identity-of request) :approver approve}))
                      (next request))
                  (deny request "Tool execution was not approved."
                        terminate-on-deny)))

              :else
              (next request)))))
     nil))})
