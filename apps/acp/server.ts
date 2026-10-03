import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { LocalAcpBackend } from "./backend.js";
import { AcpConnection, type AcpBackend } from "./protocol.js";

/** Bounded newline JSON framing; pending prompts must not block permission replies. */
export async function serve(input: Readable, output: Writable, backend: AcpBackend, maxBytes = 12 * 1024 * 1024): Promise<void> {
  const connection = new AcpConnection(backend, (value) => output.write(`${JSON.stringify(value)}\n`));
  let buffered = Buffer.alloc(0);
  const pending = new Set<Promise<void>>();
  try {
    for await (const bytes of input) {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
      let end: number;
      while ((end = buffered.indexOf(10)) >= 0) {
        if (end > maxBytes) throw new Error("ACP request exceeds frame limit");
        const line = buffered.subarray(0, end).toString("utf8"); buffered = buffered.subarray(end + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch { output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
        const operation = connection.receive(parsed);
        pending.add(operation); void operation.finally(() => pending.delete(operation));
      }
      if (buffered.length > maxBytes) throw new Error("ACP request exceeds frame limit");
    }
    if (buffered.toString("utf8").trim()) throw new Error("Incomplete ACP JSON frame at EOF");
  } finally {
    await connection.close();
    await Promise.allSettled([...pending]);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const roots: string[] = [];
  let stateDirectory = join(process.env.QI_AGENT_HOME || join(homedir(), ".qi-agent"), "acp");
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("qì ACP v1 adapter: npm --silent run acp -- --workspace /absolute/project [--workspace /another] [--state-dir /private/state]\nDefaults to the current directory. Model configuration stays local. JSON-RPC uses stdin/stdout.\n"); return;
    }
    const value = args[i + 1];
    if (!value || !["--workspace", "--state-dir"].includes(args[i])) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    if (args[i] === "--workspace") roots.push(resolve(value)); else stateDirectory = resolve(value);
    i++;
  }
  const backend = await LocalAcpBackend.open({ stateDirectory, repositoryRoot, roots: roots.length ? roots : [process.cwd()] });
  const stop = () => process.stdin.destroy();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await serve(process.stdin, process.stdout, backend); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`ACP: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
