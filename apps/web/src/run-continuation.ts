import type { Projection } from "./projection";
import { runOutcome } from "./run-outcome";

/** Only a known latest model failure may offer continuation; the runtime rechecks admission. */
export function continuableRun(projection: Projection): string | null {
  if (projection.state.phase !== "idle" || projection.interactions.length || projection.timeline.activeRunId) return null;
  const last = projection.timeline.rows.at(-1);
  const outcome = last?.kind === "outcome" ? runOutcome(last.event.data) : null;
  return outcome?.status === "failed" && ["provider-error", "output-limit"].includes(outcome.reason || "")
    ? outcome["run-id"] : null;
}

export function isContinuationRequest(params: Record<string, unknown>): boolean {
  const options = params.options;
  return !!options && typeof options === "object" && "continuation-of" in options;
}
