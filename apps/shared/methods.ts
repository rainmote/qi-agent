import catalog from "../../protocol/methods.json";
const exempt = new Set([...catalog.readOnly, ...catalog.connection]);
// Unknown plugin methods must never default to observer access.
export const mutation = (method: string): boolean => !exempt.has(method);
