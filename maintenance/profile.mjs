#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { validateBudget } from './lib/budget.mjs';
import { providerConfig } from './lib/provider.mjs';
const [model, effort, destination, budgetFile] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model ?? '') || !/^[a-z][a-z_-]*$/.test(effort ?? '') || !destination) {
  throw new Error('Usage: node maintenance/profile.mjs EXPLICIT_MODEL SUPPORTED_EFFORT OUTPUT.edn');
}
const budget = budgetFile ? validateBudget(JSON.parse(await fs.readFile(budgetFile, 'utf8'))) : null;
const provider = providerConfig(budget ?? { model, effort });
if (budget && (model !== budget.model || effort !== budget.effort)) throw new Error('Profile must match the approved budget model and effort');
// Container-only, deliberately small profile. It does not change interactive planning approval.
await fs.writeFile(destination, `{:plugins
 [{:ns qi.plugins.session :config {:path nil :ephemeral true}}
  {:ns qi.plugins.model-registry :config {:default-provider :${provider.id}}}
  {:ns qi.plugins.openai-responses :config {:provider-id :${provider.id} :model ${JSON.stringify(model)} :api-key-env "${provider.id === 'deepseek' ? 'QI_MAINTENANCE_BROKER_ONLY' : 'OPENAI_API_KEY'}"
    ${provider.id === 'deepseek' ? ':thinking-levels [:none :low :high :max]' : ''}
    :timeout-ms 180000 :max-retries 0 ${budget ? ':context-window ' + budget.context_window_tokens : ''}
    :extra-body {${budget ? ':max_output_tokens ' + budget.max_output_tokens : ''} :reasoning {:effort ${JSON.stringify(effort)}}}}}
  {:ns qi.plugins.execution-world :config {:root "/work" :sandbox :none :timeout-ms 30000}}
  {:ns qi.plugins.trust :config {:root "/work" :trusted true}}
  {:ns qi.plugins.tools}
  {:ns qi.plugins.omp}
  {:ns qi.plugins.approval :config {:mode :allow}}
  {:ns qi.plugins.policy :config {:trusted-tools ["write" "edit" "hash_edit" "bash"]
                                 :approval-tools ["write" "edit" "hash_edit" "bash"]}}
  {:ns qi.plugins.context-manager :config {:retain-messages 12 ${budget ? ':context-window ' + budget.context_window_tokens + ' :reserve-tokens ' + budget.max_output_tokens : ''}}}
  {:ns qi.plugins.runtime :config {:max-steps 32 :max-retries 0 :max-model-requests 64 :max-wall-ms 2100000 :system-prompt-template :omp}}]}
`, { flag: 'wx', mode: 0o600 });
