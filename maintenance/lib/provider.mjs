// Only reviewed provider origins are reachable by the host broker. No URL or
// credential variable comes from the candidate or an arbitrary configuration.
const providers = Object.freeze({
  openai: Object.freeze({ id: 'openai', endpoint: 'https://api.openai.com/v1/responses', credentialEnv: 'OPENAI_API_KEY' }),
  deepseek: Object.freeze({ id: 'deepseek', endpoint: 'https://api.deepseek.com/responses', credentialEnv: 'DEEPSEEK_API_KEY' }),
});

export function providerConfig(config) {
  const id = config?.provider ?? 'openai'; // Existing reviewed budgets retain their original provider.
  if (!Object.hasOwn(providers, id)) throw new Error('Unsupported maintenance provider');
  if (id === 'deepseek') {
    if (config.model !== 'deepseek-flash' || !['none', 'low', 'high', 'max'].includes(config.effort)) {
      throw new Error('DeepSeek requires the canonical deepseek-flash model and none/low/high/max effort');
    }
  } else if (/^deepseek/i.test(config?.model ?? '')) {
    throw new Error('DeepSeek models require explicit provider: deepseek');
  }
  return providers[id];
}

export function providerCredential(config) {
  const { credentialEnv } = providerConfig(config);
  const credential = process.env[credentialEnv];
  if (!credential?.trim()) throw new Error('Missing dedicated ' + credentialEnv);
  return credential;
}

export function knownServiceTier(config, response) {
  // DeepSeek has no selectable service tier and omits this unsupported field.
  // Peak pricing in the reviewed budget covers both peak and off-peak requests.
  const tier = response?.service_tier;
  return providerConfig(config).id === 'deepseek' ? tier == null || tier === 'default' : tier === 'default';
}
