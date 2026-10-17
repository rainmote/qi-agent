(ns qi.api
  "Stable public Clojure API for embedding qì agent."
  (:require [qi.kernel :as kernel]
            [qi.plugin :as plugin]))

(defn boot
  "Boot from a config map or EDN profile path."
  [config-or-path]
  (plugin/boot! (if (string? config-or-path)
                  (plugin/read-config config-or-path)
                  config-or-path)))

(defn session [ctx]
  (kernel/require-service ctx :agent/session))

(defn run!
  ([ctx message]
   ((kernel/require-service ctx :agent/run) message))
  ([ctx message options]
   ((kernel/require-service ctx :agent/run) message options)))

(defn submit!
  ([ctx message] ((:submit! (session ctx)) message))
  ([ctx message options] ((:submit! (session ctx)) message options)))

(defn subscribe! [ctx listener]
  ((:subscribe! (session ctx)) listener))

(defn dispose! [ctx]
  (kernel/dispose-all! ctx))
