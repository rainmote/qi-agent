// Exact empty-form browser-origin contract from LCU v0.11.2. Other sensitive
// forms (history, passwords, URL challenges, etc.) require separate integrations.
export function browserOriginApproval(params) {
  const meta = params?._meta ?? params?.meta;
  const schema = params?.requestedSchema;
  if (!params || ![undefined, 'form'].includes(params.mode) || typeof params.message !== 'string' || !params.message
      || meta?.connector_id !== 'browser-use' || meta.codex_approval_kind !== 'mcp_tool_call'
      || meta.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string'
      || meta.tool_params?.origin !== meta.origin || (params._meta && params.meta)
      || schema?.type !== 'object' || !schema.properties || Array.isArray(schema.properties)
      || typeof schema.properties !== 'object' || Object.keys(schema.properties).length
      || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
      || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))
      || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) return;
  try {
    const url = new URL(meta.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== meta.origin) return;
    return { message: params.message, resource: url.origin,
      // Frontends without a visible cancel item focus refusal by default.
      choices: [{ value: 'decline', label: 'Decline' },
        { value: 'once', label: 'Allow this connection to access this site' }] };
  } catch { return; }
}

export function sameScope(actual, expected) {
  return actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}
