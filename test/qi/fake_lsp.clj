(ns qi.fake-lsp
  "Deterministic stdio language server used by the LSP contract tests."
  (:require [cheshire.core :as json]
            [clojure.string :as str])
  (:import [java.io BufferedInputStream ByteArrayOutputStream EOFException]
           [java.nio.charset StandardCharsets]))

(defn- read-line-bytes [^BufferedInputStream input]
  (let [output (ByteArrayOutputStream.)]
    (loop [previous -1]
      (let [value (.read input)]
        (cond
          (= value -1) nil
          (and (= previous 13) (= value 10))
          (let [bytes (.toByteArray output)]
            (String. bytes 0 (dec (alength bytes))
                     StandardCharsets/US_ASCII))
          :else (do (.write output value) (recur value)))))))

(defn- read-message! [input]
  (loop [headers {}]
    (let [line (read-line-bytes input)]
      (cond
        (nil? line) nil
        (empty? line)
        (let [length (parse-long (get headers "content-length"))
              body (byte-array length)]
          (loop [offset 0]
            (when (< offset length)
              (let [n (.read input body offset (- length offset))]
                (when (neg? n) (throw (EOFException.)))
                (recur (+ offset n)))))
          (json/parse-string (String. body StandardCharsets/UTF_8) true))
        :else
        (let [[name value] (str/split line #":" 2)]
          (recur (assoc headers (str/lower-case name)
                        (str/trim value))))))))

(defn- send! [output value]
  (let [body (.getBytes (json/generate-string value) StandardCharsets/UTF_8)
        header (.getBytes (str "Content-Length: " (alength body) "\r\n\r\n")
                          StandardCharsets/US_ASCII)]
    (.write output header)
    (.write output body)
    (.flush output)))

(defn- response [id result]
  {:jsonrpc "2.0" :id id :result result})

(defn -main [& _]
  (let [input (BufferedInputStream. System/in)
        output System/out
        documents (atom {})]
    (loop []
      (when-let [{:keys [id method params]} (read-message! input)]
        (case method
          "initialize"
          (do
            ;; Deliberately collide with the client's first request id. A
            ;; correct client routes this by method before considering id.
            (send! output {:jsonrpc "2.0" :id 1
                           :method "workspace/configuration"
                           :params {:items [{:section "fake"}]}})
            (send! output
                   (response id
                             {:serverInfo {:name "fake-lsp" :version "1"}
                              :capabilities
                              {:positionEncoding "utf-16"
                               :textDocumentSync 1
                               :definitionProvider true
                               :referencesProvider true
                               :hoverProvider true
                               :documentSymbolProvider true
                               :workspaceSymbolProvider true
                               :implementationProvider true
                               :typeDefinitionProvider true
                               :diagnosticProvider
                               {:interFileDependencies false
                                :workspaceDiagnostics false}}})))

          "textDocument/didOpen"
          (swap! documents assoc (get-in params [:textDocument :uri])
                 (get-in params [:textDocument :text]))

          "textDocument/didChange"
          (swap! documents assoc (get-in params [:textDocument :uri])
                 (get-in params [:contentChanges 0 :text]))

          "textDocument/diagnostic"
          (let [uri (get-in params [:textDocument :uri])]
            (send! output
                   (response id
                             {:kind "full"
                              :items [{:range {:start {:line 0 :character 0}
                                               :end {:line 0 :character 4}}
                                       :severity 2
                                       :source "fake-lsp"
                                       :message (str "chars="
                                                     (count (get @documents uri "")))}]})))

          "textDocument/definition"
          (let [uri (get-in params [:textDocument :uri])
                position (:position params)]
            (send! output (response id {:uri uri
                                        :range {:start position :end position}})))

          "textDocument/implementation"
          (let [uri (get-in params [:textDocument :uri])]
            (send! output (response id {:uri uri
                                        :range {:start {:line 1 :character 2}
                                                :end {:line 1 :character 7}}})))

          "textDocument/typeDefinition"
          (let [uri (get-in params [:textDocument :uri])]
            (send! output (response id {:uri uri
                                        :range {:start {:line 0 :character 6}
                                                :end {:line 0 :character 11}}})))

          "textDocument/references"
          (do
            (Thread/sleep 250)
            (let [uri (get-in params [:textDocument :uri])]
              (send! output (response id [{:uri uri
                                           :range {:start {:line 0 :character 6}
                                                   :end {:line 0 :character 11}}}]))))

          "textDocument/hover"
          (let [uri (get-in params [:textDocument :uri])]
            (send! output
                   (response id {:contents {:kind "markdown"
                                            :value (str "current: `"
                                                        (get @documents uri "")
                                                        "`")}})))

          "textDocument/documentSymbol"
          (send! output (response id [{:name "greet" :kind 12
                                       :range {:start {:line 0 :character 0}
                                               :end {:line 1 :character 15}}
                                       :selectionRange
                                       {:start {:line 0 :character 6}
                                        :end {:line 0 :character 11}}}]))

          "workspace/symbol"
          (send! output (response id [{:name "greet" :kind 12}]))

          "shutdown" (send! output (response id nil))
          "exit" nil
          ;; Client responses, initialized, didSave, and cancellation need no
          ;; reply in this fake server.
          nil)
        (when-not (= method "exit")
          (recur))))))
