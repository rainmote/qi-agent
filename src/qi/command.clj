(ns qi.command
  "Shared slash-command dispatcher for line, TUI, and embedded frontends."
  (:require [qi.kernel :as kernel]
            [clojure.string :as str]))

(def ^:private built-ins
  [{:name "plugins" :description "List loaded plugins."}
   {:name "tools" :description "List model-facing tools."}
   {:name "commands" :description "List slash commands."}
   {:name "model" :description "Show or select a provider."}
   {:name "session" :description "Show current session information."}
   {:name "sessions" :description "Browse indexed sessions."}
   {:name "tree" :description "Show the current session tree."}
   {:name "name" :description "Set the current session name."}
   {:name "label" :description "Label the active session entry."}
   {:name "checkout" :description "Checkout a session entry."}
   {:name "trust" :description "Show or explicitly change project trust."}
   {:name "reload" :description "Reload project resources."}
   {:name "state" :description "Show current agent state."}
   {:name "abort" :description "Abort the active run."}
   {:name "steer" :description "Queue steering text for the active run."}
   {:name "follow-up" :description "Queue text after the active run."}
   {:name "compact" :description "Compact the current session."}
   {:name "fork" :description "Fork the session to a path."}
   {:name "clear" :description "Clear the active branch append-only."}
   {:name "theme" :description "Show or select the TUI theme."}
   {:name "quit" :description "Exit the interactive frontend."}])

(defn- skill-commands [ctx]
  (if-let [resources (kernel/service ctx :resources/catalog)]
    (mapv (fn [{:keys [name description]}]
            {:name (str "skill:" name)
             :description description})
          ((:skill-commands resources)))
    []))

(defn commands [ctx]
  (->> (concat built-ins (kernel/commands ctx) (skill-commands ctx))
       (reduce (fn [by-name command]
                 (assoc by-name (:name command)
                        (select-keys command [:name :description])))
               {})
       vals
       (sort-by :name)
       vec))

(defn parse [text]
  (when (str/starts-with? (str/triml (or text "")) "/")
    (let [[name argument]
          (str/split (subs (str/triml text) 1) #"\s+" 2)]
      {:name name :argument (or argument "")})))

(defn- session-info [store]
  {:session-id (:session-id store)
   :path (:path store)
   :event-count (count ((:events store)))
   :message-count (count ((:messages store)))
   :diagnostics ((:diagnostics store))})

(defn- output [value]
  {:handled true :output value})

(defn- trust-info [trust]
  {:root (:root trust)
   :decision ((:decision trust))
   :source (:source trust)
   :trust-file (:trust-file trust)
   :mutable (boolean (:set-decision! trust))
   :usage "/trust allow | /trust deny"})

(defn- change-trust! [ctx trust decision]
  (if-let [setter (:set-decision! trust)]
    (let [changed (setter decision)
          resources (kernel/service ctx :resources/catalog)
          reloaded (when resources ((:reload! resources)))]
      (output (cond-> (merge (trust-info trust) changed)
                reloaded (assoc :resources reloaded))))
    {:handled true
     :error (str "Trust is fixed by this profile's :trusted override; "
                 "remove that override to use the user trust store.")}))

(defn- invoke-skill! [ctx session command-name argument]
  (try
    (if-let [resources (kernel/service ctx :resources/catalog)]
      (if-not ((:skill-commands-enabled? resources))
        {:handled true :error "Skill commands are disabled."}
        (let [skill-name (subs command-name (count "skill:"))
              prompt ((:render-skill-invocation resources) skill-name argument)
              active? (not= :idle (:phase ((:state session))))]
          (if active?
            (do
              ((:steer! session) prompt)
              (output {:skill skill-name :status :steered}))
            (do
              ((:submit! session) prompt)
              (output {:skill skill-name :status :submitted})))))
      (output "No resource catalog is configured."))
    (catch Throwable error
      {:handled true :error (ex-message error)})))

(defn dispatch!
  "Execute a slash command and return a frontend-neutral result map.

  Results may contain :output, :quit?, or :ui. Unknown non-slash input returns
  {:handled false}. UI-capable frontends can intercept :ui hints such as model,
  session, and theme selectors before falling back to the textual output."
  [ctx text]
  (if-let [{:keys [name argument]} (parse text)]
    (let [session (kernel/require-service ctx :agent/session)
          store (kernel/require-service ctx :session/store)
          argument (str/trim argument)]
      (case name
        "quit" {:handled true :quit? true}
        "plugins" (output (mapv #(select-keys % [:id :description])
                                  (kernel/loaded-plugins ctx)))
        "tools" (output (mapv #(select-keys % [:name :description])
                                (kernel/tools ctx)))
        "commands" (output (commands ctx))
        "model"
        (if-let [registry (kernel/service ctx :llm/registry)]
          (if (str/blank? argument)
            {:handled true
             :ui :model-selector
             :output {:current ((:current registry))
                      :providers ((:providers registry))}}
            (output ((:select! registry) (keyword argument))))
          (output "No model registry is configured."))
        "session" (output (session-info store))
        "sessions"
        (if-let [catalog (kernel/service ctx :session/catalog)]
          (do
            (when-let [refresh! (:refresh! catalog)] (refresh!))
            {:handled true :ui :session-selector :output ((:list catalog))})
          (output "No session catalog is configured."))
        "tree" {:handled true :ui :tree-selector :output ((:tree store))}
        "name" (do ((:name! store) argument) (output {:name argument}))
        "label" (do ((:label! store) argument) (output {:label argument}))
        "checkout" (output ((:checkout! store) argument))
        "trust"
        (if-let [trust (kernel/service ctx :project/trust)]
          (case (str/lower-case argument)
            "" (output (trust-info trust))
            "status" (output (trust-info trust))
            "allow" (change-trust! ctx trust :allow)
            "deny" (change-trust! ctx trust :deny)
            {:handled true :error "Usage: /trust allow | /trust deny"})
          (output "No project trust service is configured."))
        "reload"
        (if-let [catalog (kernel/service ctx :resources/catalog)]
          (output ((:reload! catalog)))
          (output "No resource catalog is configured."))
        "state" (output ((:state session)))
        "abort" (output {:aborted (boolean ((:abort! session)))})
        "steer" (output ((:steer! session) argument))
        "follow-up" (output ((:follow-up! session) argument))
        "compact" (output ((:compact! store)))
        "fork" (output ((:fork! store) argument))
        "clear" (do ((:clear! store)) (output {:cleared true}))
        "theme"
        (let [requested (when-not (str/blank? argument) (keyword argument))]
          (when-let [set-theme! (and requested
                                     (:set-theme!
                                      (kernel/service ctx :ui/extensions)))]
            (set-theme! requested))
          {:handled true :ui :theme-selector :theme requested})
        (cond
          (str/starts-with? name "skill:")
          (invoke-skill! ctx session name argument)

          (kernel/command ctx name)
          (let [registered (kernel/command ctx name)]
            (output ((:execute registered)
                     argument
                     {:context ctx :session session :store store})))

          :else {:handled true :error (str "Unknown command: /" name)})))
    {:handled false}))
