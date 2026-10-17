import assert from "node:assert/strict";
import test from "node:test";
import { RequestScope } from "./request-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a delayed response cannot replace the view after leaving and returning to the same session", async () => {
  const scope = new RequestScope();
  const request = deferred<string>();
  const current = scope.capture();
  let displayed = "A";
  const update = request.promise.then((value) => { if (current()) displayed = value; });
  scope.advance(); displayed = "B";
  scope.advance(); displayed = "A-current";
  request.resolve("A-old"); await update;
  assert.equal(displayed, "A-current");
});

test("rapid session opens honor the latest selection despite reversed response order", async () => {
  const navigation = new RequestScope();
  const first = deferred<string>(); const second = deferred<string>();
  let displayed = "initial";
  const open = async (request: Promise<string>) => {
    const current = navigation.advance();
    const result = await request;
    if (current()) displayed = result;
  };
  const a = open(first.promise); const b = open(second.promise);
  second.resolve("B"); await b;
  first.resolve("A"); await a;
  assert.equal(displayed, "B");
});
