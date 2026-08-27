import { randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./sessions.js";
import type { HostEvent } from "./types.js";
import { WorkspaceRegistry } from "./workspaces.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultStaticRoot = join(repositoryRoot, "apps", "web", "dist");
const cookieName = "bb_agent_web";
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface WebHostOptions {
  host?: string;
  port?: number;
  workspace?: string;
  stateDirectory?: string;
  staticRoot?: string;
  token?: string;
  unsafeAllowNetwork?: boolean;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function errorResponse(response: ServerResponse, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : "Unexpected error";
  json(response, status, { ok: false, error: { message } });
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function hasToken(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) return true;
  return String(request.headers.cookie || "").split(";").some((part) =>
    part.trim() === `${cookieName}=${token}`);
}

function validOrigin(request: IncomingMessage): boolean {
  if (!request.headers.origin) return true;
  const expected = `http://${request.headers.host}`;
  return request.headers.origin === expected;
}

function sendSse(response: ServerResponse, event: HostEvent): void {
  response.write(`id: ${event.hostSeq}\n`);
  response.write("event: worker\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function serveStatic(response: ServerResponse, root: string,
  pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let path = resolve(root, normalized);
  if (!path.startsWith(`${resolve(root)}/`) && path !== resolve(root, "index.html")) {
    throw new Error("Invalid static path");
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Not a file");
  } catch {
    path = join(root, "index.html");
    await access(path);
  }
  securityHeaders(response);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(path)] || "application/octet-stream",
    "Cache-Control": path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(response);
}

export async function startWebHost(options: WebHostOptions = {}) {
  const host = options.host || "127.0.0.1";
  if (!isLoopbackHost(host) && !options.unsafeAllowNetwork) {
    throw new Error(
      "Refusing a non-loopback Web Host. Use --unsafe-allow-network only behind an authenticated TLS proxy.",
    );
  }
  const port = options.port ?? Number(process.env.PORT || 3080);
  const token = options.token || randomBytes(24).toString("base64url");
  const staticRoot = options.staticRoot || defaultStaticRoot;
  const workspaces = new WorkspaceRegistry(options.stateDirectory);
  await workspaces.load(options.workspace || process.cwd());
  const ownedDaemonEnvironment = options.stateDirectory ? {
    // Unix socket paths are short on macOS. Keep the ephemeral runtime path
    // out of deeply nested test/application state directories.
    runtimeDirectory: join("/tmp", `dao-web-${process.pid}-${randomBytes(6).toString("hex")}`),
    stateDirectory: join(options.stateDirectory, "daemon-state"),
  } : null;
  const sessions = new SessionManager(workspaces, repositoryRoot,
    ownedDaemonEnvironment || {});

  const readiness = async () => {
    const workspaceRoots = workspaces.list().map((workspace) => workspace.path);
    const binaryCandidates = [
      process.env.DAO_BIN,
      join(repositoryRoot, "apps", "tui-rs", "target", "release", "dao"),
      join(repositoryRoot, "apps", "tui-rs", "target", "debug", "dao"),
    ].filter((value): value is string => Boolean(value));
    const checks = {
      staticAssets: false,
      runtimeConfig: false,
      daemonBinary: false,
      workspaces: false,
    };
    await Promise.allSettled([
      access(join(staticRoot, "index.html")).then(() => { checks.staticAssets = true; }),
      Promise.all([
        access(join(repositoryRoot, "bb.edn")),
        access(join(repositoryRoot, "agent.edn")),
      ]).then(() => { checks.runtimeConfig = true; }),
      Promise.any(binaryCandidates.map((path) => access(path, constants.X_OK)))
        .then(() => { checks.daemonBinary = true; }),
      Promise.all(workspaceRoots.map((path) => access(path)))
        .then(() => { checks.workspaces = workspaceRoots.length > 0; }),
    ]);
    return { ok: Object.values(checks).every(Boolean), checks };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    try {
      if (url.pathname === "/health" || url.pathname === "/health/live") {
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/health/ready") {
        const status = await readiness();
        return json(response, status.ok ? 200 : 503, status);
      }
      if (url.searchParams.get("token") === token && request.method === "GET") {
        response.setHeader("Set-Cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(303, { Location: url.pathname || "/" });
        return response.end();
      }
      if (!hasToken(request, token)) {
        return json(response, 401, { ok: false, error: { message: "Open the authenticated URL printed by bb web." } });
      }
      if (!["GET", "HEAD"].includes(request.method || "GET") && !validOrigin(request)) {
        return errorResponse(response, new Error("Request origin is not allowed"), 403);
      }

      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        const roots = workspaces.list();
        const catalogs = await Promise.all(roots.map(async (workspace) => ({
          workspaceId: workspace.id,
          sessions: await sessions.list(workspace),
        })));
        return json(response, 200, {
          ok: true,
          result: { workspaces: roots, catalogs, activeWorkspaceId: roots[0]?.id || null },
        });
      }
      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const input = await body(request);
        if (typeof input.path !== "string") throw new Error("Workspace path is required");
        return json(response, 201, { ok: true, result: await workspaces.add(input.path) });
      }
      if (url.pathname === "/api/directories" && request.method === "GET") {
        const requested = url.searchParams.get("path") || homedir();
        const canonical = await realpath(requested);
        const entries = await readdir(canonical, { withFileTypes: true });
        return json(response, 200, {
          ok: true,
          result: {
            path: canonical,
            parent: dirname(canonical) === canonical ? null : dirname(canonical),
            directories: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
              .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          },
        });
      }
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceMatch && request.method === "DELETE") {
        const workspaceId = decodeURIComponent(workspaceMatch[1]);
        await sessions.closeWorkspace(workspaceId);
        return json(response, 200, {
          ok: true,
          result: { removed: await workspaces.remove(workspaceId) },
        });
      }
      if (url.pathname === "/api/sessions" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspace");
        if (!workspaceId) throw new Error("workspace query parameter is required");
        return json(response, 200, {
          ok: true,
          result: await sessions.list(workspaces.get(workspaceId)),
        });
      }
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        const input = await body(request);
        if (typeof input.workspaceId !== "string") throw new Error("workspaceId is required");
        const opened = await sessions.create(input.workspaceId,
          typeof input.name === "string" ? input.name : undefined);
        return json(response, 201, {
          ok: true,
          result: { session: opened.summary, snapshot: opened.snapshot },
        });
      }

      const sessionMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/(open|fork|archive|snapshot|rpc|events)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];
        if (action === "open" && request.method === "POST") {
          const opened = await sessions.open(id);
          return json(response, 200, {
            ok: true,
            result: { session: opened.summary, snapshot: opened.snapshot },
          });
        }
        if (action === "fork" && request.method === "POST") {
          const input = await body(request);
          const forked = await sessions.fork(id,
            typeof input.name === "string" ? input.name : undefined);
          return json(response, 201, {
            ok: true,
            result: { session: forked.summary, snapshot: forked.snapshot },
          });
        }
        if (action === "archive" && request.method === "POST") {
          return json(response, 200, { ok: true, result: await sessions.archive(id) });
        }
        if (action === "snapshot" && request.method === "GET") {
          const worker = await sessions.worker(id);
          return json(response, 200, { ok: true, result: await worker.call("session.snapshot") });
        }
        if (action === "rpc" && request.method === "POST") {
          const input = await body(request);
          if (typeof input.method !== "string") throw new Error("RPC method is required");
          if (input.method === "session.fork") {
            throw new Error("Session destinations are selected by the Web Host");
          }
          const params = input.params && typeof input.params === "object" && !Array.isArray(input.params)
            ? input.params as Record<string, unknown> : {};
          const worker = await sessions.worker(id);
          return json(response, 200, {
            ok: true,
            result: await worker.call(input.method, params),
          });
        }
        if (action === "events" && request.method === "GET") {
          const worker = await sessions.worker(id);
          securityHeaders(response);
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
          });
          response.write("retry: 1500\n\n");
          const cursor = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
          for (const event of worker.eventsAfter(Number.isFinite(cursor) ? cursor : 0)) sendSse(response, event);
          const listener = (event: HostEvent) => sendSse(response, event);
          const releaseClient = worker.subscribeClient();
          worker.on("event", listener);
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
          request.once("close", () => {
            clearInterval(heartbeat);
            worker.off("event", listener);
            releaseClient();
          });
          return;
        }
      }

      if (url.pathname.startsWith("/api/")) {
        return errorResponse(response, new Error("API route was not found"), 404);
      }
      await serveStatic(response, staticRoot, url.pathname);
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error,
        error instanceof Error && /not found/i.test(error.message) ? 404 : 400);
      else response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    host,
    port: actualPort,
    token,
    url: `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`,
    workspaces,
    sessions,
    close: async () => {
      if (options.stateDirectory) await sessions.shutdownDaemon();
      await sessions.closeAll();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      if (ownedDaemonEnvironment) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await rm(ownedDaemonEnvironment.runtimeDirectory, { recursive: true, force: true });
      }
    },
  };
}

function parseArguments(arguments_: string[]): WebHostOptions {
  const options: WebHostOptions = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--host") options.host = arguments_[++index];
    else if (argument === "--port") options.port = Number(arguments_[++index]);
    else if (argument === "--workspace") options.workspace = arguments_[++index];
    else if (argument === "--unsafe-allow-network") options.unsafeAllowNetwork = true;
    else throw new Error(`Unknown Web Host argument: ${argument}`);
  }
  return options;
}

const entrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  const host = await startWebHost(parseArguments(process.argv.slice(2)));
  console.log(`bb-agent Web is ready: ${host.url}`);
  console.log("The bearer token is stored only in this process and the authenticated cookie.");
  const shutdown = async () => {
    await host.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
