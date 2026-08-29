(ns qi.system-prompt
  "OMP-style stable prompt template and provider-facing prompt assembly."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]))

(def omp-template
  (delay
    (if-let [resource (io/resource "qi/prompts/omp-system.md")]
      (slurp resource)
      (throw (ex-info "Bundled OMP system prompt was not found"
                      {:resource "qi/prompts/omp-system.md"})))))

(defn- present [value]
  (when-not (str/blank? (or value ""))
    (str/trim value)))

(defn- join-blocks [blocks]
  (let [text (->> blocks (keep present) (str/join "\n\n"))]
    (when-not (str/blank? text) text)))

(defn- context-block [contexts]
  (when (seq contexts)
    (str "# Project Context\n\n"
         (str/join
          "\n\n"
          (map #(str "## " (:name %) " (" (name (:scope %)) ")\n\n"
                     (str/trim (:content %)))
               contexts)))))

(defn- skills-block [skills]
  (when (seq skills)
    (let [always-applied (filter :always-apply skills)]
      (str "# Available Skills\n\n"
           "Skills are specialized instructions. If one matches the task, read "
           "`skill://<name>` before proceeding.\n\n"
           (str/join
            "\n"
            (map #(str "- " (:name %) ": " (:description %)
                       " [" (name (:scope %)) "]"
                       (when (seq (:globs %))
                         (str " globs=" (str/join "," (:globs %)))))
                 skills))
           (when (seq always-applied)
             (str "\n\n# Always-Applied Skill Instructions\n\n"
                  (str/join
                   "\n\n"
                   (map #(str "## " (:name %) "\n\n"
                              (str/trim (:body %)))
                        always-applied))))))))

(defn- tools-block [tool-names]
  (when (seq tool-names)
    (str "# Available Tools\n\n"
         "The runtime has provided these tools for this request: "
         (str/join ", " (sort tool-names)) ".")))

(defn- environment-block [{:keys [workspace local-date project-trusted]}]
  (join-blocks
   [(when (or workspace local-date (some? project-trusted))
      (str "# Runtime Environment\n\n"
           (str/join
            "\n"
            (keep identity
                  [(when workspace (str "- Working directory: `" workspace "`"))
                   (when local-date (str "- Local date: " local-date))
                   (when (some? project-trusted)
                     (str "- Project resources trusted: "
                          (if project-trusted "yes" "no")))]))))]))

(defn assemble
  "Assemble a provider-facing prompt.

  A custom prompt (normally SYSTEM.md) replaces only the stable base. Generated
  context is retained. APPEND_SYSTEM is placed directly after a custom prompt,
  or at the end of the normal generated prompt, matching OMP's composition
  semantics. Explicit custom/append values should be resolved before calling."
  [{:keys [base-prompt custom-prompt append-prompt contexts skills tool-names
           workspace local-date project-trusted]}]
  (let [custom? (some? (present custom-prompt))
        stable (if custom? custom-prompt base-prompt)
        generated [(context-block contexts)
                   (skills-block skills)
                   (tools-block tool-names)
                   (environment-block {:workspace workspace
                                       :local-date local-date
                                       :project-trusted project-trusted})]]
    (join-blocks
     (if custom?
       (concat [stable append-prompt] generated)
       (concat [stable] generated [append-prompt])))))
