import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('explicit production preset uses only official API and fails missing credentials before network', async () => {
  const { stdout } = await exec('bb', ['--classpath', 'src:plugins', '-e', `
    (require '[qi.plugin :as p] '[qi.kernel :as k] '[qi.env :as env]
             '[babashka.fs :as fs] '[babashka.http-client :as http] '[cheshire.core :as json])
    (let [root (fs/create-temp-dir) requests (atom 0)
          cfg (update (p/read-config "presets/production/agent.edn") :plugins
             #(mapv (fn [s] (update s :config
               (fn [c] (cond-> (or c {})
                 (contains? c :root) (assoc :root (str root))
                 (= 'qi.plugins.trust (:ns s)) (assoc :trusted false)
                 (= 'qi.plugins.openai-responses (:ns s)) (assoc :api-key-env "QI_TEST_MISSING_KEY_3B5FB2"))))) %))]
      (try
        (with-redefs [env/get (fn [& _] nil) env/home (constantly (str root))
                      http/post (fn [& _] (swap! requests inc) (throw (ex-info "Unexpected network" {})))]
          (let [ctx (p/boot! cfg)]
            (try
              (assert (= [:openai] (mapv :id ((:providers (k/require-service ctx :llm/registry))))))
              (doseq [name ["write" "edit" "bash"]]
                (assert (= :deny (:decision (k/waterfall ctx :tool/pre-execute
                  {:execution {:name name} :tool (k/tool ctx name)} #(assoc % :decision :allow))))))
              (let [error (try ((k/require-service ctx :agent/run) "No credentials") nil (catch Exception e e))
                    limits ((k/require-service ctx :agent/effective-limits))]
                (assert (= :missing-credentials (:code (ex-data error))))
                (assert (= :failed (:status (ex-data error))))
                (assert (= :not-run (:verification (ex-data error))))
                (assert (= 0 @requests))
                (println (json/generate-string limits)))
              (finally (k/dispose-all! ctx)))))
        (finally (fs/delete-tree root))))`], { timeout: 10000 });
  const limits = JSON.parse(stdout);
  assert.equal(limits.runtime['max-model-requests'], 64);
  assert.equal(limits.runtime['max-parallel-tools'], 4);
  assert.equal(limits.runtime['hard-wall-enforced'], false);
  assert.equal(limits.os['worker-cpu-enforced'], null);
  assert.equal(limits.os['memory-enforced'], false);
  assert.equal(limits.os['pids-enforced'], false);
  assert.equal(limits.verification['automatic-coding-verifier'], false);
});

test('production deny policy also rejects mutations in a trusted temporary project', async () => {
  await exec('bb', ['--classpath', 'src:plugins', '-e', `
    (require '[qi.plugin :as p] '[qi.kernel :as k] '[qi.env :as env] '[babashka.fs :as fs])
    (let [root (fs/create-temp-dir)
          cfg (update (p/read-config "presets/production/agent.edn") :plugins
             #(mapv (fn [s] (update s :config (fn [c] (cond-> (or c {})
               (contains? c :root) (assoc :root (str root))
               (= 'qi.plugins.trust (:ns s)) (assoc :trusted true))))) %))]
      (try (with-redefs [env/get (fn [& _] nil) env/home (constantly (str root))]
        (let [ctx (p/boot! cfg)]
          (try (doseq [name ["write" "edit" "bash"]]
            (assert (= :deny (:decision (k/waterfall ctx :tool/pre-execute
              {:execution {:name name} :tool (k/tool ctx name)} #(assoc % :decision :allow))))))
          (finally (k/dispose-all! ctx)))))
      (finally (fs/delete-tree root))))`], { timeout: 10000 });
});
