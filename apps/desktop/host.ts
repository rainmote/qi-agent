import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { startWebHost } from "../web-host/server.js";
import { ensurePrivateDirectory } from "../web-host/storage.js";
import { rememberPort, savedPort } from "./state.js";

function requiredPath(name: string): string {
  const path = process.env[name];
  if (!path || !isAbsolute(path)) throw new Error(`Missing absolute desktop path: ${name}`);
  return path;
}

// No CLI overrides or renderer commands. Only the native parent's private pipe
// can end this Host. A parent crash closes that pipe as well.
let activeHost: Awaited<ReturnType<typeof startWebHost>> | null = null;
async function main() {
  const state = requiredPath("QI_AGENT_DESKTOP_STATE_DIR");
  const runtime = requiredPath("QI_AGENT_RUNTIME_DIR");
  await ensurePrivateDirectory(state);
  const welcome = join(state, "Welcome");
  await ensurePrivateDirectory(welcome);
  await writeFile(join(welcome, "README.md"),
    "# qì agent\n\nUse File → Open Project to choose a project. Project trust and tool approvals remain separate.\n",
    { flag: "wx", mode: 0o600 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const portFile = join(state, "desktop-port.json");
  const requestedPort = await savedPort(portFile);
  const host = await startWebHost({ host: "127.0.0.1", port: requestedPort,
    workspace: welcome, stateDirectory: join(state, "web"),
    externalDaemonRuntimeDirectory: runtime });
  activeHost = host;
  if (requestedPort && host.port !== requestedPort) {
    throw new Error("The saved desktop port is occupied; no other Host was attached");
  }
  await rememberPort(portFile, host.port);
  let stopping: Promise<void> | null = null;
  const shutdown = () => stopping ||= host.close().then(() => { process.exitCode = 0; });
  const input = createInterface({ input: process.stdin });
  input.on("line", line => { if (line === "shutdown") { void shutdown().finally(() => input.close()); } });
  input.on("close", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown().finally(() => input.close()); });
  process.once("SIGINT", () => { void shutdown().finally(() => input.close()); });
  // Token appears only in the inherited private stdout pipe. Never log this
  // frame, put it in a file, expose it through IPC, or send it to another URL.
  process.stdout.write(`${JSON.stringify({ kind: "ready", port: host.port, token: host.token })}\n`);
}

main().catch(async (error) => {
  await Promise.race([activeHost?.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2000))]);
  // Bounded category only; never echo a token, provider key or user data.
  const reason = error instanceof Error && error.message.startsWith("The saved desktop port")
    ? "saved_port_occupied" : "host_initialization_failed";
  process.stderr.write(`Desktop Host startup failed: ${reason}\n`);
  process.stdout.write(`${JSON.stringify({ kind: "failed", reason })}\n`, () => process.exit(1));
});
