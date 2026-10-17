(ns qi.plugins.computer-use
  "Exclusive, name-only computer-use provider registration."
  (:require [qi.kernel :as kernel]
            [clojure.string :as str]))

(def plugin
  {:id :computer-use/registry
   :description "One explicitly configured computer-use provider per context."
   :provides #{:computer-use/registry}
   :start
   (fn [ctx _]
     (let [slot (atom nil)]
       (kernel/register-service!
        ctx :computer-use/registry
        {:provider-name #(some-> @slot :name)
         :register!
         (fn [provider-name]
           (when-not (and (string? provider-name) (not (str/blank? provider-name)))
             (throw (ex-info "Computer-use provider name must be nonblank" {})))
           (let [entry {:name provider-name :token (random-uuid)}]
             (when-not (compare-and-set! slot nil entry)
               (throw (ex-info "A computer-use provider is already registered"
                               {:provider (:name @slot)})))
             ;; An old/repeated disposer cannot release a later reservation.
             #(compare-and-set! slot entry nil)))}))
     nil)})
