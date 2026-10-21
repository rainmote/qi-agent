(ns qi.plugins.policy
  (:require [qi.kernel :as kernel]))

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
           approval-required (set approval-tools)]
       (kernel/register-service! ctx :tool/policy {:metadata-gates true})
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
                  (next request)
                  (deny request "Tool execution was not approved."
                        terminate-on-deny)))

              :else
              (next request)))))
     nil))})
