(ns example.ui-demo
  "Example of reversible third-party TUI extension registration."
  (:require [qi.ui :as ui]))

(def plugin
  {:id :example/ui-demo
   :description "Example TUI widget, status, shortcut, and renderer."
   :requires #{:ui/extensions}
   :start
   (fn [ctx _]
     (ui/set-status! ctx :demo "demo:on")
     (ui/set-widget! ctx :hint
                     ["Demo extension: Ctrl+G sends a notification."]
                     {:placement :below-editor})
     (ui/register-shortcut!
      ctx "ctrl+g"
      {:description "Show the demo notification"
       :handler (fn [_] (ui/notify! ctx "Hello from example.ui-demo"))})
     (ui/register-message-renderer!
      ctx :system
      (fn [message _]
        [(str "System · " (:content message))]))
     nil)})
