(ns qi.plugins.cua-driver-mcp
  "Opt-in desktop tools from an installed Cua Driver."
  (:require [qi.computer-use-mcp :as computer]))

(def plugin
  (computer/provider-plugin
   {:id :computer-use/cua-driver-mcp
    :provider-name "cua-driver-mcp"
    :description "Explicitly enabled Cua Driver MCP desktop provider."
    :default-command ["cua-driver" "mcp"]}))
