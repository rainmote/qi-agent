(require '[clojure.edn :as edn] '[clojure.pprint :as pprint])

;; Packaging starts from the portable Standard preset, not a workstation's
;; root profile (which may contain machine-specific proxy settings).
;; Computer use remains disabled; this adds discoverable status, not consent.
(doseq [path *command-line-args*]
  (let [profile (edn/read-string (slurp path))
        plugins (:plugins profile)
        existing (set (map :ns plugins))
        additions (remove #(contains? existing (:ns %))
                          [{:ns 'qi.plugins.computer-use}
                           {:ns 'qi.plugins.lcu :config {:enabled false}}
                           {:ns 'qi.plugins.terminal}
                           {:ns 'qi.plugins.workspace-tools}])
        index (or (first (keep-indexed #(when (= 'qi.plugins.mcp-client (:ns %2)) %1) plugins))
                  (count plugins))
        result (assoc profile :plugins (vec (concat (take index plugins) additions (drop index plugins))))]
    (spit path (with-out-str (pprint/pprint result)))))
