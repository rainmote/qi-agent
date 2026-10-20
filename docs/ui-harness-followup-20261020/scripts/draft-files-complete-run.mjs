import { spawn } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
const url = "http://127.0.0.1:4179";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4179", "--strictPort"], { cwd: "qi-agent", stdio: ["ignore", "pipe", "inherit"] });
let listening = false;
let startupOutput = "";
server.stdout.on("data", chunk => {
  process.stdout.write(chunk);
  // CI colors the port separately; a stream chunk can also split the URL or escape sequence.
  startupOutput = (startupOutput + chunk.toString()).slice(-4096);
  if (stripVTControlCharacters(startupOutput).includes(url)) listening = true;
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("Production preview exited before readiness");
    try { ready = listening && (await fetch(url)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Production preview did not become ready");
  for (const script of ["draft-files-complete.mjs"]) {
    const tests = spawn(process.execPath, [`tools/${script}`], {
      stdio: "inherit", env: { ...process.env, QI_AGENT_WEB_TEST_URL: url },
    });
    const watchdog = setTimeout(() => tests.kill("SIGTERM"), 120_000);
    try {
      const [code] = await once(tests, "exit");
      if (code !== 0) { process.exitCode = code ?? 1; break; }
    } finally { clearTimeout(watchdog); }
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}
