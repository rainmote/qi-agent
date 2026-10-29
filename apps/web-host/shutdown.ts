import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** An acknowledgement proves admission; only this instance's receipt proves cleanup. */
export async function waitForDaemonShutdown(runtimeDirectory: string, accepted: unknown,
  timeoutMs = 30_000): Promise<void> {
  const result = accepted as Record<string, unknown> | null;
  const id = result?.shutdown_id;
  if (!result || result.preserve_sessions !== true || result.shutting_down !== true
    || typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) {
    throw new Error("Daemon shutdown outcome is UNKNOWN: invalid acknowledgement");
  }
  const receiptPath = join(runtimeDirectory, `shutdown-${id}.json`);
  if (result.receipt_path !== receiptPath) throw new Error("Daemon shutdown receipt identity mismatch");
  const socketPath = join(runtimeDirectory, "daemon.sock");
  const deadline = Date.now() + timeoutMs;
  do {
    let receipt: Record<string, unknown> | undefined;
    try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (receipt) {
      if (receipt.schema_version !== 1 || receipt.shutdown_id !== id || receipt.preserve_sessions !== true) {
        throw new Error("Daemon shutdown receipt identity mismatch");
      }
      if (receipt.ok !== true || !Array.isArray(receipt.errors) || receipt.errors.length) {
        throw new Error("Daemon cleanup is incomplete; runtime evidence retained for reconciliation");
      }
      try { await lstat(socketPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Daemon shutdown outcome is UNKNOWN: cleanup confirmation timed out; runtime retained");
}
