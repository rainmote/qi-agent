(ns qi.streaming
  "Provider-neutral SSE framing with cooperative cancellation."
  (:require [qi.cancellation :as cancellation]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(defn- parse-data [data]
  (cond
    (= "[DONE]" data) ::done
    (not (str/blank? data))
    (try
      (json/parse-string data true)
      (catch Throwable error
        (throw (ex-info "Invalid JSON in LLM event stream"
                        {:code :invalid_stream_json :retryable false
                         :event-chars (count data)}))))))

(defn consume-sse!
  "Parse an SSE string/InputStream incrementally and call handler for every JSON
  data event. Cancellation closes the reader and wakes a blocked network read."
  [body token handler]
  (let [source (if (string? body) (java.io.StringReader. body) body)
        reader (io/reader source)
        close-target (if (instance? java.io.Closeable body) body reader)
        ;; A bounded queue prevents a fast network reader from buffering an
        ;; unbounded response when downstream rendering is slow.
        queue (java.util.concurrent.LinkedBlockingQueue. 256)
        eof (Object.)
        reader-task
        (future
          (try
            (loop []
              (if-let [line (.readLine ^java.io.BufferedReader reader)]
                (do (.put queue [:line line]) (recur))
                (.put queue eof)))
            (catch Throwable error
              (.put queue [:error error]))))
        dispose (cancellation/on-cancel!
                 token #(do
                          (try (.close ^java.io.Closeable close-target)
                               (catch Throwable _))
                          (future-cancel reader-task)))]
    (try
      (loop [data-lines []]
        (cancellation/throw-if-cancelled! token)
        (let [entry (.poll queue 100
                           java.util.concurrent.TimeUnit/MILLISECONDS)]
          (cond
            (nil? entry)
            (recur data-lines)

            (identical? eof entry)
            (let [event (parse-data (str/join "\n" data-lines))]
              (when (and event (not= ::done event)) (handler event))
              {:done? (= ::done event)})

            (= :error (first entry))
            (throw (second entry))

            :else
            (let [line (second entry)]
              (cond
            (str/blank? line)
            (let [event (parse-data (str/join "\n" data-lines))]
              (if (= ::done event)
                {:done? true}
                (do (when event (handler event)) (recur []))))

            (str/starts-with? line "data:")
            (recur (conj data-lines (str/trim (subs line 5))))

            :else
                (recur data-lines))))))
      (catch Throwable error
        (if (cancellation/cancelled? token)
          (throw (ex-info "Agent run was cancelled" {:cancelled true} error))
          (throw error)))
      (finally
        (dispose)
        ;; DONE may arrive while the reader future is blocked on its next read.
        ;; Closing the underlying stream first releases that read/reader lock.
        (try (.close ^java.io.Closeable close-target) (catch Throwable _))
        (future-cancel reader-task)
        (try (.close ^java.io.Reader reader) (catch Throwable _))))))
