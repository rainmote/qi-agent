(ns qi.sandbox
  "Shared sandbox selection with secure cross-platform degradation."
  (:require [babashka.fs :as fs]))

(defn resolve-mode
  "Resolve :auto without making the whole agent unavailable.

  On macOS, :auto selects Seatbelt when sandbox-exec is present. Elsewhere it
  returns :unavailable so callers can omit process-capable tools while keeping
  safe filesystem and conversational features online. Explicit :seatbelt still
  fails closed, and explicit :none remains an informed opt-out."
  ([requested]
   (resolve-mode requested
                 {:os-name (System/getProperty "os.name")
                  :seatbelt-executable?
                  (fs/executable? "/usr/bin/sandbox-exec")}))
  ([requested {:keys [os-name seatbelt-executable?]}]
   (case requested
     :auto (if (and (= "Mac OS X" os-name) seatbelt-executable?)
             :seatbelt
             :unavailable)
     :seatbelt (do
                 (when-not (= "Mac OS X" os-name)
                   (throw (ex-info "Seatbelt sandbox requires macOS"
                                   {:os os-name})))
                 (when-not seatbelt-executable?
                   (throw (ex-info "sandbox-exec is unavailable" {})))
                 :seatbelt)
     :none :none
     :unavailable :unavailable
     (throw (ex-info
             ":sandbox must be :auto, :seatbelt, :none, or :unavailable"
             {:sandbox requested})))))
