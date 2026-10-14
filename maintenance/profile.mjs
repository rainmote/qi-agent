#!/usr/bin/env node
import { promises as fs } from 'node:fs';
const [model, effort, destination] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model ?? '') || !/^[a-z][a-z_-]*$/.test(effort ?? '') || !destination) {
  throw new Error('Usage: node maintenance/profile.mjs EXPLICIT_MODEL SUPPORTED_EFFORT OUTPUT.edn');
}
// Container-only, deliberately small profile. It does not change interactive planning approval.
await fs.writeFile(destination, `{:plugins
 [{:ns qi.plugins.session :config {:path nil :ephemeral true}}
  {:ns qi.plugins.model-registry :config {:default-provider :openai}}
  {:ns qi.plugins.openai-responses :config {:model ${JSON.stringify(model)} :api-key-env "OPENAI_API_KEY"
    :timeout-ms 180000 :max-retries 0 :extra-body {:reasoning {:effort ${JSON.stringify(effort)}}}}}
  {:ns qi.plugins.execution-world :config {:root "/work" :sandbox :none :timeout-ms 30000}}
  {:ns qi.plugins.trust :config {:root "/work" :trusted true}}
  {:ns qi.plugins.tools}
  {:ns qi.plugins.omp}
  {:ns qi.plugins.approval :config {:mode :allow}}
  {:ns qi.plugins.policy :config {:trusted-tools ["write" "edit" "hash_edit" "bash"]
                                 :approval-tools ["write" "edit" "hash_edit" "bash"]}}
  {:ns qi.plugins.context-manager :config {:retain-messages 12}}
  {:ns qi.plugins.runtime :config {:max-steps 32 :max-retries 0 :system-prompt-template :omp}}]}
`, { flag: 'wx', mode: 0o600 });
