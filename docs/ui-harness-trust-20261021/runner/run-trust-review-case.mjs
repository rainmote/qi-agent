// Same assertions as the committed browser suite; select one deterministic review regression.
process.env.QI_AGENT_TRUST_REVIEW_CASE=process.argv[2];
process.argv=[process.argv[0],import.meta.filename,'apps/web/tests/trust-browser.mjs'];
await import('./run-interaction-preview.mjs');
