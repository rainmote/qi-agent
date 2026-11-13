import type { DurableEvent } from "./types";

/** Transport success is independent of command success. Never infer failure from output prose. */
export function toolFailed(result: DurableEvent | undefined): boolean {
  if (!result) return false;
  const data = result.data;
  const details = data.details as Record<string, unknown> | undefined;
  const exit = details?.["exit-code"];
  return data.ok === false || data["is-error"] === true || data.status === "error"
    || (data.name === "bash" && typeof exit === "number" && exit !== 0);
}
