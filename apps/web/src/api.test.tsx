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
