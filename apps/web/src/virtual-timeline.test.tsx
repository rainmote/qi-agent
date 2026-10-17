import assert from "node:assert/strict";
import test from "node:test";
import { captureAnchor, restoreAnchor, timelineLayout, visibleRange } from "./virtual-timeline";

const rows = Array.from({ length: 10_000 }, (_, index) => ({ id: `row-${index}`, estimate: 100 }));

test("ten thousand rows keep a bounded viewport window at the start, middle and end", () => {
  const layout = timelineLayout(rows, new Map(), 700);
  for (const top of [0, 500_000, 999_400]) {
    const range = visibleRange(layout, top, 600);
    assert.ok(range.end - range.start <= 19);
    assert.ok(layout.offsets[range.start] <= top);
    assert.ok(layout.offsets[range.end] >= top + 600);
  }
});

test("history scroll anchors survive late insertion and height changes above the viewport", () => {
  const before = timelineLayout(rows, new Map(), 700);
  const anchor = captureAnchor(before, 500_037);
  assert.deepEqual(anchor, { id: "row-5000", offset: 37 });
  const changed = timelineLayout([{ id: "late", estimate: 260 }, ...rows],
    new Map([["row-20", { width: 700, height: 500 }]]), 700);
  assert.equal(restoreAnchor(changed, anchor), 500_697);
  assert.deepEqual(captureAnchor(changed, restoreAnchor(changed, anchor)!), anchor);
});

test("new output does not move a history anchor; resized narrow rows invalidate stale measurements", () => {
  const measured = new Map([["row-1", { width: 700, height: 450 }]]);
  const before = timelineLayout(rows, measured, 700);
  const anchor = captureAnchor(before, 1_023);
  const appended = timelineLayout([...rows, { id: "new-output", estimate: 350 }], measured, 700);
  assert.equal(restoreAnchor(appended, anchor), 1_023);
  const narrow = timelineLayout(rows, measured, 320);
  assert.equal(narrow.total, 1_000_000);
  assert.equal(before.total, 1_000_350);
  assert.equal(restoreAnchor(narrow, anchor), 673);
});

test("empty layouts and removed anchors recover without invalid offsets", () => {
  const empty = timelineLayout([], new Map(), 700);
  assert.deepEqual(visibleRange(empty, 0, 500), { start: 0, end: 0 });
  assert.equal(captureAnchor(empty, 0), null);
  assert.equal(restoreAnchor(empty, { id: "gone", offset: 40 }), null);
});
