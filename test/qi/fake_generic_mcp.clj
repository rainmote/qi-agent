(ns qi.fake-generic-mcp
  "Offline modern stdio MCP fixture; never launches tools or accesses the network."
  (:require [cheshire.core :as json]))
(defn -main [& _]
  (doseq [line (line-seq (java.io.BufferedReader. (java.io.InputStreamReader. System/in)))]
    (let [{:keys [id method params]} (json/parse-string line true)
          result (case method
                   "server/discover" {:resultType "complete" :supportedVersions ["2026-07-28"]
                                      :capabilities {:tools {} :resources {}}
                                      :_meta {"io.modelcontextprotocol/serverInfo" {:name "modern-fixture" :version "1"}}}
                   "tools/list" {:resultType "complete" :tools [{:name "echo" :description "Echo fixture input"
                                                                  :inputSchema {:type "object" :properties {:text {:type "string"}}}}]}
                   "tools/call" {:resultType "complete" :content [{:type "text" :text (get-in params [:arguments :text])}]}
                   "resources/list" {:resultType "complete" :resources [{:name "fixture" :uri "fixture://one"}]}
                   "resources/read" {:resultType "complete" :contents [{:uri (:uri params) :text "fixture"}]}
                   nil)]
      (when id
        (println (json/generate-string
                  (if (= "2026-07-28" (get-in params [:_meta :io.modelcontextprotocol/protocolVersion]))
                    {:jsonrpc "2.0" :id id :result result}
                    {:jsonrpc "2.0" :id id :error {:code -32022 :message "modern metadata required"}})))
        (flush)))))
