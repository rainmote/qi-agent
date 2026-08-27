(ns agent.plugins.approval
  "Approval rules over resolved tools, paths, cwd, commands, and session grants."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(def ^:private modes #{:allow :deny :ask})

(defn- regex-match? [patterns value]
  (or (empty? patterns)
      (and value
           (some #(re-find (re-pattern %) (str value)) patterns))))

(defn- rule-matches? [{:keys [tools paths commands providers]} request]
  (let [{:keys [tool target]} request]
    (and (or (empty? tools) (some #{tool} tools))
         (regex-match? paths (:path target))
         (regex-match? commands (:command target))
         (or (empty? providers)
             (some #{(:provider target)} providers)))))

(defn- rule-decision [rules request]
  (some (fn [rule]
          (when (rule-matches? rule request)
            (:decision rule)))
        rules))

(defn- request-key [{:keys [tool target]}]
  [tool (:provider target) (:path target) (:cwd target) (:command target)])

(defn- ask-console! [{:keys [tool arguments target]}]
  (binding [*out* *err*]
    (println (str "Approve tool " tool "?"))
    (when (seq target)
      (println "Resolved target:" (pr-str target)))
    (when (seq arguments)
      (println "Arguments:" (pr-str arguments)))
    (print "[y]es / [s]ession / [N]o: ")
    (flush))
  (let [answer (some-> (read-line) str/trim str/lower-case)]
    (cond
      (contains? #{"y" "yes"} answer) :allow
      (contains? #{"s" "session"} answer) :allow-session
      :else :deny)))

(defn- ask! [ctx request]
  (if-let [prompt (let [candidate (kernel/service ctx :ui/prompt)]
                    (when (and candidate
                               (or (nil? (:active? candidate))
                                   ((:active? candidate))))
                      candidate))]
    ((:select! prompt)
     {:title (str "Approve tool " (:tool request) "?")
      :message (pr-str (select-keys request [:target :arguments]))
      :cancel-token (:cancel-token request)
      :items [{:label "Allow once" :value :allow}
              {:label "Allow for session" :value :allow-session}
              {:label "Deny" :value :deny}]
      :default :deny})
    (ask-console! request)))

(def plugin
  {:id :security/approval
   :description "Resolved-target approval with rules and session grants."
   :provides #{:approval/request}
   :start
   (fn [ctx {:keys [mode rules] :or {mode :deny rules []}}]
     (when-not (contains? modes mode)
       (throw (ex-info "Approval :mode must be :allow, :deny, or :ask"
                       {:mode mode})))
     (when-not (every? #(contains? #{:allow :deny} (:decision %)) rules)
       (throw (ex-info "Approval rules require :decision :allow or :deny"
                       {:rules rules})))
     (let [session-grants (atom #{})
           active-mode (atom mode)]
       (kernel/register-service!
        ctx :approval/policy
        {:status (fn [] {:mode @active-mode
                         :modes [{:id :deny :label "Read Only"}
                                 {:id :ask :label "Workspace Write"}
                                 {:id :allow :label "Full Access"}]})
         :select! (fn [next-mode]
                    (when-not (contains? modes next-mode)
                      (throw (ex-info "Unknown approval mode"
                                      {:mode next-mode})))
                    (reset! active-mode next-mode)
                    (reset! session-grants #{})
                    {:mode next-mode})})
       (kernel/register-service!
        ctx :approval/request
        (fn [request]
          (let [key (request-key request)
                configured (rule-decision rules request)
                mode @active-mode
                raw (cond
                      (contains? @session-grants key) :allow
                      configured configured
                      (= :ask mode) (ask! ctx request)
                      :else mode)
                decision (if (= raw :allow-session) :allow raw)]
            (when (= raw :allow-session)
              (swap! session-grants conj key))
            (kernel/emit! ctx :approval/event
                          (assoc (dissoc request :cancel-token)
                                 :mode mode :decision decision
                                 :session-grant (= raw :allow-session)))
            decision))))
     nil)})
