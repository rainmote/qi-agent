import { randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./sessions.js";
import type { HostEvent } from "./types.js";
import { ProviderRegistry, type ProviderSettings } from "./providers.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { AgentWorker } from "./worker.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { TurnFiles } from "./turn-files.js";
import { readSessionReference, resolveReferences } from "./workspace-references.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultStaticRoot = join(repositoryRoot, "apps", "web", "dist");
const cookieName = "qi_agent_web";
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
  verificationDirectory?: string;
  verificationControllerSha?: string;
}

function addressInUse(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

async function listenOnce(
  server: ReturnType<typeof createServer>, host: string, port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenOnAvailablePort(
  server: ReturnType<typeof createServer>, host: string, initialPort: number,
): Promise<number> {
  let candidate = initialPort;
  while (true) {
    try {
      await listenOnce(server, host, candidate);
      const address = server.address();
      return typeof address === "object" && address ? address.port : candidate;
    } catch (error) {
      if (!addressInUse(error) || candidate === 0 || candidate >= 65_535) throw error;
      candidate += 1;
    }
  }
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
  const rawData = error instanceof Error && "data" in error
    ? (error as Error & { data?: unknown }).data : null;
  const data: Record<string, string> = {};
  if (rawData && typeof rawData === "object") {
    for (const key of ["type", "status", "command_id"]) {
      const value = (rawData as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length <= 256) data[key] = value;
    }
  }
  json(response, status, { ok: false, error: { message, data } });
}

async function body(request: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) continue;
    chunks.push(buffer);
  }
  if (length > limit) throw new Error("Request body is too large");
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

function validOrigin(request: IncomingMessage, trustForwardedHost: boolean): boolean {
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    const forwarded = trustForwardedHost
      ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim()
      : "";
    const hosts = [request.headers.host, forwarded].filter(Boolean);
    return ["http:", "https:"].includes(origin.protocol)
      && hosts.includes(origin.host);
  } catch {
    return false;
  }
}

function sendSse(response: ServerResponse, event: HostEvent): void {
  response.write(`id: ${event.hostEpoch}:${event.hostSeq}\nevent: worker\ndata: ${JSON.stringify(event)}\n\n`);
}

async function serveEvents(request: IncomingMessage, response: ServerResponse,
  worker: AgentWorker): Promise<void> {
  if (request.destroyed || response.destroyed) return;
  const cursor = String(request.headers["last-event-id"] || "")
    || new URL(request.url || "/", "http://localhost").searchParams.get("after");
  const replay = worker.replayAfter(cursor);
  let pending: HostEvent[] | null = [];
  let uncovered = (_event: HostEvent) => true;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const releaseClient = worker.subscribeClient();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    worker.off("event", listener);
    worker.off("exit", stop);
    worker.off("reset", stop);
    response.off("close", cleanup);
    pending = null;
    releaseClient();
  };
  const stop = () => { cleanup(); response.end(); };
  const listener = (event: HostEvent) => {
    if (closed) return;
    if (pending) {
      pending.push(event);
      // An unavailable snapshot or stalled client must not grow memory forever.
      if (pending.length > 10_000) stop();
    } else {
      if (uncovered(event)) sendSse(response, event);
      if (response.writableLength > 4 * 1024 * 1024) stop();
    }
  };
  worker.on("event", listener);
  worker.once("exit", stop);
  worker.once("reset", stop);
  response.once("close", cleanup);
  securityHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  response.write("retry: 1500\n\n");
  try {
    if (replay.reset) {
      const snapshot = await worker.call("session.snapshot") as Record<string, unknown>;
      if (closed) return;
      const included = new Set((Array.isArray(snapshot.events) ? snapshot.events : [])
        .map((event: { id?: unknown }) => event.id));
      const stateRevision = (snapshot.state as { revision?: unknown } | undefined)?.revision;
      const interactionsRevision = snapshot.interactions_revision;
      let missingRevision = typeof stateRevision !== "number" || typeof interactionsRevision !== "number";
      uncovered = (event: HostEvent) => {
        if (event.durable) return !included.has(event.event_id);
        const revision = event.data?.revision;
        const baseline = event.event === "agent/state" ? stateRevision
          : event.event === "interaction/request" || event.event === "interaction/resolved"
            ? interactionsRevision : undefined;
        if (["agent/state", "interaction/request", "interaction/resolved"].includes(event.event || "")
          && (typeof baseline !== "number" || typeof revision !== "number")) missingRevision = true;
        return !(typeof baseline === "number" && typeof revision === "number"
          && revision <= baseline);
      };
      const events = pending!.filter(uncovered);
      // Snapshot and uncovered events share one SSE dispatch/id. A disconnect
      // cannot acknowledge the snapshot while losing the events captured with it.
      response.write(`id: ${worker.eventCursor}\nevent: snapshot\ndata: ${JSON.stringify({
        snapshot, events, reason: replay.reset,
        ...(missingRevision ? { warning: "当前运行时缺少状态版本，重连期间的状态可能需要刷新。请重启运行时以启用完整恢复。" } : {}),
      })}\n\n`);
    } else {
      for (const event of replay.events) sendSse(response, event);
      for (const event of pending!) sendSse(response, event);
    }
    pending = null;
    response.write(`id: ${worker.eventCursor}\nevent: ready\ndata: {}\n\n`);
    heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
  } catch (error) {
    stop();
    throw error;
  }
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
  const networkExposed = !isLoopbackHost(host);
  if (networkExposed && !options.unsafeAllowNetwork) {
    throw new Error(
      "Refusing a non-loopback Web Host. Use --unsafe-allow-network only behind an authenticated TLS proxy.",
    );
  }
  const port = options.port ?? Number(process.env.PORT || 3080);
  const token = options.token || randomBytes(24).toString("base64url");
  const staticRoot = options.staticRoot || defaultStaticRoot;
  const workspaces = new WorkspaceRegistry(options.stateDirectory);
  await workspaces.load(options.workspace || process.cwd());
  const providers = new ProviderRegistry(workspaces.stateDirectory);
  await providers.load();
  if (Boolean(options.verificationDirectory) !== Boolean(options.verificationControllerSha)) throw new Error("Verification requires both a receipt directory and trusted controller SHA");
  const files = new WorkspaceFiles(workspaces, {
    ...(options.stateDirectory ? { attachmentDirectory: join(workspaces.stateDirectory, "attachments") } : {}),
    ...(options.verificationDirectory ? { verification: { directory: options.verificationDirectory, controllerSha: options.verificationControllerSha! } } : {}),
  });
  await files.recoverPending();
  const turnFiles = new TurnFiles(files);
  const ownedDaemonEnvironment = options.stateDirectory ? {
    // Unix socket paths are short on macOS. Keep the ephemeral runtime path
    // out of deeply nested test/application state directories.
    runtimeDirectory: join("/tmp", `qi-agent-web-${process.pid}-${randomBytes(6).toString("hex")}`),
    stateDirectory: join(options.stateDirectory, "daemon-state"),
    providerSettingsPath: providers.statePath,
    attachmentDirectory: files.attachmentDirectory,
  } : null;
  const sessions = new SessionManager(workspaces, repositoryRoot,
    ownedDaemonEnvironment || { providerSettingsPath: providers.statePath, attachmentDirectory: files.attachmentDirectory });

  const readiness = async () => {
    const workspaceRoots = workspaces.list().map((workspace) => workspace.path);
    const binaryCandidates = [
      process.env.QI_AGENT_BIN,
      process.env.DAO_BIN,
      join(repositoryRoot, "apps", "tui-rs", "target", "release", "qi-agent"),
      join(repositoryRoot, "apps", "tui-rs", "target", "debug", "qi-agent"),
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
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      if (url.pathname === "/health" || url.pathname === "/health/live") {
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/health/ready") {
        const status = await readiness();
        return json(response, status.ok ? 200 : 503, status);
      }
      if (url.searchParams.get("token") === token && request.method === "GET") {
        response.setHeader("Set-Cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`
          + (networkExposed ? "; Secure" : ""));
        response.writeHead(303, { Location: url.pathname || "/" });
        return response.end();
      }
      if (!hasToken(request, token)) {
        return json(response, 401, { ok: false, error: { message: "Open the authenticated URL printed by bb web." } });
      }
      if (!["GET", "HEAD"].includes(request.method || "GET")
        && !validOrigin(request, networkExposed)) {
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
      if (url.pathname === "/api/presets" && request.method === "GET") {
        return json(response, 200, { ok: true, result: await sessions.listPresets() });
      }
      if (url.pathname === "/api/providers" && request.method === "GET") {
        return json(response, 200, {
          ok: true,
          result: { providers: await providers.list(), presets: providers.presets() },
        });
      }
      if (url.pathname === "/api/providers" && request.method === "POST") {
        const input = await body(request) as unknown as ProviderSettings;
        const saved = await providers.upsert(input);
        const reload = await sessions.reloadProviderSettings();
        return json(response, 200, { ok: true, result: { ...saved, reload } });
      }
      if (url.pathname === "/api/providers/reload" && request.method === "POST") {
        const input = await body(request);
        if (!Array.isArray(input.sessionIds) || input.sessionIds.length > 256
          || !input.sessionIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)) {
          throw new Error("sessionIds must be an array of at most 256 session IDs");
        }
        return json(response, 200, { ok: true,
          result: await sessions.reloadProviderSettings(input.sessionIds as string[]) });
      }
      if (url.pathname === "/api/providers/discover" && request.method === "POST") {
        const input = await body(request);
        return json(response, 200, {
          ok: true,
          result: await providers.discover({
            providerId: typeof input.providerId === "string" ? input.providerId : undefined,
            baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : undefined,
            apiKey: typeof input.apiKey === "string" ? input.apiKey : undefined,
          }),
        });
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (providerMatch && request.method === "DELETE") {
        const id = decodeURIComponent(providerMatch[1]);
        const removed = await providers.remove(id);
        const reload = await sessions.reloadProviderSettings();
        return json(response, 200, { ok: true, result: { removed, reload } });
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
        return json(response, 200, {
          ok: true,
          result: { removed: await workspaces.remove(workspaceId) },
        });
      }
      const fileMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(files|search|preview|content|attachments|references|resolve-references|changes)(?:\/([^/]+))?$/);
      if (fileMatch) {
        const workspaceId = decodeURIComponent(fileMatch[1]), action = fileMatch[2];
        const workspace = workspaces.get(workspaceId), check = workspaces.lease(workspaceId);
        const path = url.searchParams.get("path") || "";
        if (request.method === "GET" && ["content", "attachments"].includes(action)) {
          const served = action === "content"
            ? await files.content(workspaceId, path, { download: url.searchParams.get("download") === "1" })
            : await files.attachment(workspaceId, decodeURIComponent(fileMatch[3] || ""), { download: url.searchParams.get("download") !== "0" });
          securityHeaders(response); response.writeHead(200, served.headers); return response.end(served.body);
        }
        if (request.method === "POST" && action === "attachments" && !fileMatch[3]) {
          const input = await body(request, 12 * 1024 * 1024);
          return json(response, 201, { ok: true, result: await files.upload(workspaceId, input as unknown as { name: string; mime: string; base64: string }) });
        }
        if (request.method === "POST" && action === "resolve-references") {
          const input = await body(request);
          if (typeof input.message !== "string") throw new Error("Reference message must be text");
          const result = await resolveReferences(files, workspaceId, input.message, async (id) => {
            const catalog = await sessions.list(workspace);
            const summary = catalog.find(item => item.id === id);
            if (!summary) throw new Error("Referenced session does not belong to this workspace");
            check(); return readSessionReference(workspaces, summary);
          });
          check(); return json(response, 200, { ok: true, result });
        }
        if (request.method === "GET") {
          let result: unknown;
          if (action === "files") result = await files.list(workspaceId, path);
          else if (action === "search") result = await files.search(workspaceId, url.searchParams.get("q") || "");
          else if (action === "preview") result = await files.preview(workspaceId, path);
          else if (action === "changes") result = await files.sessionChanges(workspaceId, url.searchParams.get("session") || "");
          else if (action === "references") {
            const query = url.searchParams.get("q") || "";
            const [found, catalog] = await Promise.all([files.search(workspaceId, query), sessions.list(workspace)]);
            result = { files: found.entries.filter(item => item.kind === "file").slice(0, 12), sessions: catalog.filter(item => `${item.name || ""} ${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 12) };
          } else throw new Error("Unsupported workspace resource");
          check(); return json(response, 200, { ok: true, result });
        }
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
        if ("configPath" in input || "config_path" in input) {
          throw new Error("Session creation accepts presetId, not config paths");
        }
        if (typeof input.workspaceId !== "string") throw new Error("workspaceId is required");
        if (input.presetId !== undefined
          && (typeof input.presetId !== "string" || input.presetId.length > 128
            || !/^[a-z0-9][a-z0-9_-]*$/.test(input.presetId))) {
          throw new Error("presetId must be a valid Preset identifier");
        }
        const opened = await sessions.create(
          input.workspaceId,
          typeof input.name === "string" ? input.name : undefined,
          typeof input.presetId === "string" ? input.presetId : undefined,
        );
        return json(response, 201, {
          ok: true,
          result: { session: opened.summary, snapshot: opened.snapshot, eventCursor: opened.eventCursor },
        });
      }

      const operationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/operations\/([a-zA-Z0-9_-]{8,128})$/);
      if (operationMatch && request.method === "GET") {
        const result = await sessions.commandStatus(decodeURIComponent(operationMatch[1]), operationMatch[2]) as { status: string; result?: unknown };
        if (result.status === "completed") turnFiles.reconcile(decodeURIComponent(operationMatch[1]), operationMatch[2], result.result);
        else if (result.status === "failed") await turnFiles.rejectReconciled(decodeURIComponent(operationMatch[1]), operationMatch[2]);
        return json(response, 200, { ok: true,
          result });
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
            result: { session: opened.summary, snapshot: opened.snapshot, eventCursor: opened.eventCursor },
          });
        }
        if (action === "fork" && request.method === "POST") {
          const input = await body(request);
          const forked = await sessions.fork(id,
            typeof input.name === "string" ? input.name : undefined);
          return json(response, 201, {
            ok: true,
            result: { session: forked.summary, snapshot: forked.snapshot, eventCursor: forked.eventCursor },
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
          if (input.method === "session.archive") {
            throw new Error("Session archives are managed by the Web Host");
          }
          if (input.method === "automation.resolve") throw new Error("Internal automation resolution cannot be called from the browser");
          if (input.commandId !== undefined && (typeof input.commandId !== "string"
            || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.commandId))) {
            throw new Error("commandId must be a stable operation identifier");
          }
          const params = input.params && typeof input.params === "object" && !Array.isArray(input.params)
            ? input.params as Record<string, unknown> : {};
          if (["turn.submit", "turn.steer", "turn.follow-up"].includes(input.method)
            && Buffer.byteLength(JSON.stringify(params.message ?? "")) > 256 * 1024) throw new Error("Message references and text exceed 256 KiB");
          const worker = await sessions.worker(id);
          const workspace = workspaces.list().find(item => item.path === worker.workspaceRoot);
          let turnId: string | undefined;
          if (input.method === "turn.submit") {
            if (!workspace) throw new Error("Turn workspace is not permitted");
            turnId = typeof input.commandId === "string" ? input.commandId : `web-${randomUUID()}`;
            await turnFiles.begin(worker, workspace.id, id, turnId);
          }
          try {
            const result = await worker.call(input.method, params, 30_000, input.commandId as string | undefined);
            if (turnId && workspace) turnFiles.admit(workspace.id, id, turnId, result);
            return json(response, 200, { ok: true, result });
          } catch (error) {
            const status = (error as { data?: { status?: string } })?.data?.status;
            // Transport uncertainty keeps the original snapshot and listener alive for reconciliation.
            if (turnId && workspace && status !== "uncertain" && status !== "pending") await turnFiles.reject(workspace.id, id, turnId);
            throw error;
          }
        }
        if (action === "events" && request.method === "GET") {
          const worker = await sessions.worker(id);
          await serveEvents(request, response, worker);
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

  const actualPort = await listenOnAvailablePort(server, host, port);
  return {
    host,
    port: actualPort,
    token,
    url: `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`,
    workspaces,
    sessions,
    files,
    close: async () => {
      if (options.stateDirectory) await sessions.shutdownDaemon();
      await sessions.closeAll();
      await turnFiles.close();
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
    else if (argument === "--verification-directory") options.verificationDirectory = arguments_[++index];
    else if (argument === "--verification-controller-sha") options.verificationControllerSha = arguments_[++index];
    else if (argument === "--unsafe-allow-network") options.unsafeAllowNetwork = true;
    else throw new Error(`Unknown Web Host argument: ${argument}`);
  }
  return options;
}

const entrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  const host = await startWebHost(parseArguments(process.argv.slice(2)));
  console.log(`qì agent Web is ready: ${host.url}`);
  console.log("The bearer token is stored only in this process and the authenticated cookie.");
  const shutdown = async () => {
    await host.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
