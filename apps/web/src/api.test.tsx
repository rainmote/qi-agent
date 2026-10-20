import assert from "node:assert/strict";
import test from "node:test";
import { api, uncertainOperation } from "./api";

function fixture(handler: (path: string, input?: any) => Promise<unknown>) {
  const values = new Map<string,string>();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{
    getItem:(key:string)=>values.get(key) || null,
    setItem:(key:string,value:string)=>values.set(key,value),
    removeItem:(key:string)=>values.delete(key),
  }});
  globalThis.fetch = async (path, init) => new Response(JSON.stringify({ok:true,
    result:await handler(String(path),init?.body ? JSON.parse(String(init.body)) : undefined)}));
  return () => {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis,"sessionStorage",oldStorage);
    else delete (globalThis as any).sessionStorage;
  };
}

test("lost response keeps the original operation through reload and blocks blind replay", async () => {
  let accepted = 0;
  let commandId = "";
  const restore = fixture(async (path,input) => {
    if (path.includes("/operations/")) {
      assert.ok(path.endsWith(commandId)); return {status:"completed",result:{accepted:true}};
    }
    accepted++; commandId = input.commandId;
    throw new TypeError("response connection lost after acceptance");
  });
  try {
    await assert.rejects(api.rpc("session","turn.submit",{message:"once"}),uncertainOperation);
    assert.equal(api.pendingOperation("session")?.commandId,commandId);
    await assert.rejects(api.rpc("session","turn.submit",{message:"once"}),uncertainOperation);
    assert.equal(accepted,1);
    assert.equal((await api.operationStatus("session")).status,"completed");
    assert.equal(api.pendingOperation("session"),null);
    assert.equal(accepted,1);
  } finally { restore(); }
});

test("manual retry after not_found reuses identity and payload; pending outcomes never resend", async () => {
  const commands: any[] = [];
  let status = "pending";
  const restore = fixture(async (path,input) => {
    if (path.includes("/operations/")) return {status};
    commands.push(input);
    if (commands.length === 1) throw new TypeError("connection lost before acceptance");
    return {accepted:true};
  });
  try {
    await assert.rejects(api.rpc("session","repl.eval",{code:"write-once"}),uncertainOperation);
    await assert.rejects(api.retryOperation("session"),uncertainOperation);
    assert.equal(commands.length,1);
    status = "not_found";
    await api.retryOperation("session");
    assert.deepEqual(commands[0],commands[1]);
    assert.equal(api.pendingOperation("session"),null);
  } finally { restore(); }
});

test("structured uncertain responses survive the API boundary and definitive errors allow a new action", async () => {
  const restore = fixture(async () => ({}));
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ok:false,error:{message:"timed out",data:{status:"uncertain"}}}),{status:400});
    await assert.rejects(api.rpc("one","turn.submit",{message:"once"}),uncertainOperation);
    assert.ok(api.pendingOperation("one"));
    globalThis.fetch = async () => new Response(JSON.stringify({ok:false,error:{message:"observer"}}),{status:400});
    await assert.rejects(api.rpc("two","policy.select",{mode:"allow"}),/observer/);
    assert.equal(api.pendingOperation("two"),null);
  } finally { restore(); }
});

test("planning approvals can resolve while the original blocking command remains journaled", async () => {
  const seen: string[] = [];
  const restore = fixture(async (_path, input) => { seen.push(input.method); if (input.method === "planning.submit") throw new TypeError("response lost"); return { resolved: true }; });
  try {
    await assert.rejects(api.rpc("session", "planning.submit", { plan_id: "plan" }), uncertainOperation);
    const pending = api.pendingOperation("session");
    await api.rpc("session", "interaction.resolve", { id: "approval", approved: true });
    await api.rpc("session", "planning.cancel");
    assert.deepEqual(api.pendingOperation("session"), pending);
    assert.deepEqual(seen, ["planning.submit", "interaction.resolve", "planning.cancel"]);
  } finally { restore(); }
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("a late old HTTP response cannot erase a newer operation's recovery identity", async () => {
  const old = deferred(), newer = deferred(); let writes = 0;
  const restore = fixture(async (path) => {
    if (path.includes("/operations/")) return { status: "completed" };
    if (++writes === 1) { await old.promise; return { saved: true }; }
    await newer.promise; throw new TypeError("newer response lost");
  });
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = api.rpc("session", "command.execute", { command: "/trust deny" });
    const firstId = api.pendingOperation("session")!.commandId;
    await api.operationStatus("session");
    second = api.rpc("session", "command.execute", { command: "/trust allow" });
    const secondId = api.pendingOperation("session")!.commandId;
    assert.notEqual(firstId, secondId);
    old.resolve(); await first;
    assert.equal(api.pendingOperation("session")?.commandId, secondId, "late old response must retain the new recovery journal");
    newer.resolve(); await assert.rejects(second, uncertainOperation);
    assert.equal(api.pendingOperation("session")?.commandId, secondId);
  } finally { old.resolve(); newer.resolve(); await Promise.allSettled([first, second]); restore(); }
});

test("a late operation-status response cannot erase a newer recovery journal", async () => {
  const late = deferred(), newer = deferred(); let queries = 0, writes = 0;
  const restore = fixture(async (path) => {
    if (path.includes("/operations/")) { if (++queries === 1) await late.promise; return { status: "completed" }; }
    if (++writes === 1) throw new TypeError("old response lost");
    await newer.promise; return { saved: true };
  });
  let query: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    await assert.rejects(api.rpc("session", "command.execute", { command: "/trust deny" }), uncertainOperation);
    query = api.operationStatus("session");
    await api.operationStatus("session");
    second = api.rpc("session", "command.execute", { command: "/trust allow" });
    const secondId = api.pendingOperation("session")!.commandId;
    late.resolve(); await query;
    assert.equal(api.pendingOperation("session")?.commandId, secondId, "a status query owns only its captured command_id");
    newer.resolve(); await second;
    assert.equal(api.pendingOperation("session"), null);
  } finally { late.resolve(); newer.resolve(); await Promise.allSettled([query, second]); restore(); }
});

for (const replacement of [false, true]) test(`late not_found cannot replay an operation after its journal ${replacement ? "belongs to a newer write" : "was already reconciled"}`, async () => {
  const late = deferred(), newer = deferred(); let queries = 0;
  const commands: any[] = [];
  const restore = fixture(async (path, input) => {
    if (path.includes("/operations/")) {
      if (++queries === 1) { await late.promise; return { status: "not_found" }; }
      return { status: "completed" };
    }
    commands.push(input);
    if (commands.length === 1) throw new TypeError("original response lost");
    if (input.params.command === "/trust allow") await newer.promise;
    return { saved: true };
  });
  let retry: Promise<{ ok: boolean; error?: unknown }> | undefined, second: Promise<unknown> | undefined;
  try {
    await assert.rejects(api.rpc("session", "command.execute", { command: "/trust deny" }), uncertainOperation);
    retry = api.retryOperation("session").then(() => ({ ok: true }), error => ({ ok: false, error }));
    await api.operationStatus("session");
    if (replacement) second = api.rpc("session", "command.execute", { command: "/trust allow" });
    const pending = api.pendingOperation("session");
    late.resolve(); const result = await retry;
    assert.equal(commands.length, replacement ? 2 : 1, "stale not_found must never send the original command again");
    assert.deepEqual(api.pendingOperation("session"), pending, "retry must preserve the current journal, including a cleared one");
    assert.equal(result.ok, false); assert.ok(uncertainOperation(result.error));
    newer.resolve(); await second;
  } finally { late.resolve(); newer.resolve(); await Promise.allSettled([retry, second]); restore(); }
});
