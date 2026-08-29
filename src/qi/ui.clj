(ns qi.ui
  "Public, reversible UI extension helpers.

  UI extensions are frontend-neutral: renderers return strings or string
  sequences, shortcuts receive a context map, and widgets are line-oriented."
  (:require [qi.kernel :as kernel]))

(defn- owner [ctx]
  (or (:plugin/id ctx)
      (throw (ex-info "UI registration requires a plugin context" {}))))

(defn- extensions [ctx]
  (kernel/require-service ctx :ui/extensions))

(defn- tracked [ctx dispose]
  (kernel/track-effect! ctx dispose))

(defn register-message-renderer! [ctx message-type renderer]
  (tracked ctx ((:register-message-renderer! (extensions ctx))
                (owner ctx) message-type renderer)))

(defn register-entry-renderer! [ctx entry-type renderer]
  (tracked ctx ((:register-entry-renderer! (extensions ctx))
                (owner ctx) entry-type renderer)))

(defn register-tool-renderer! [ctx tool-name renderer]
  (tracked ctx ((:register-tool-renderer! (extensions ctx))
                (owner ctx) tool-name renderer)))

(defn register-shortcut!
  [ctx shortcut {:keys [handler] :as options}]
  (when-not (fn? handler)
    (throw (ex-info "Shortcut :handler must be a function"
                    {:shortcut shortcut})))
  (tracked ctx ((:register-shortcut! (extensions ctx))
                (owner ctx) shortcut options)))

(defn set-status! [ctx status-id value]
  (tracked ctx ((:set-status! (extensions ctx))
                (owner ctx) status-id value)))

(defn set-widget!
  ([ctx widget-id value]
   (set-widget! ctx widget-id value {:placement :above-editor}))
  ([ctx widget-id value options]
   (tracked ctx ((:set-widget! (extensions ctx))
                 (owner ctx) widget-id value options))))

(defn notify!
  ([ctx text] (notify! ctx text :info))
  ([ctx text level]
   ((:notify! (extensions ctx)) {:text text :level level})))

(defn set-theme! [ctx theme]
  ((:set-theme! (extensions ctx)) theme))

(defn snapshot [ctx]
  ((:snapshot (extensions ctx))))

(defn select! [ctx request]
  ((:select! (kernel/require-service ctx :ui/prompt)) request))

(defn confirm! [ctx request]
  ((:confirm! (kernel/require-service ctx :ui/prompt)) request))

(defn input! [ctx request]
  ((:input! (kernel/require-service ctx :ui/prompt)) request))

(defn custom! [ctx request]
  ((:custom! (kernel/require-service ctx :ui/prompt)) request))
