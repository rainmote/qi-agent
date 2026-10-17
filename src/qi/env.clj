(ns qi.env
  "Canonical qì agent environment access with legacy dao/bb-agent fallbacks.")

(defn get
  ([primary]
   (System/getenv primary))
  ([primary legacy]
   (or (System/getenv primary)
       (System/getenv legacy))))

(defn home
  "Return the canonical user data root. QI_AGENT_HOME always wins."
  []
  (or (get "QI_AGENT_HOME")
      (str (java.io.File. (System/getProperty "user.home") ".qi-agent"))))
