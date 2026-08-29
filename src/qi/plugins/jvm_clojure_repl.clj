(ns qi.plugins.jvm-clojure-repl
  "Native JVM Clojure implementation of the shared per-agent REPL service."
  (:require [qi.plugins.bb-repl :as process-repl]))

(def plugin
  {:id :execution/jvm-clojure-repl
   :description "Persistent, restartable native JVM Clojure REPL backend."
   :provides #{:execution/repl}
   :start
   (fn [ctx config]
     ((:start process-repl/plugin)
      ctx
      (assoc config :backend :jvm-clojure)))})
