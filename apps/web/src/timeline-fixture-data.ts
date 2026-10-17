import type { DurableEvent, SessionSnapshot } from "./types";

/** Synthetic only: this fixture never loads a workspace, credentials or a real session. */
export function fixtureSnapshot(turns = 2_000): SessionSnapshot {
  const events: DurableEvent[] = [];
  const add = (type: string, data: Record<string, unknown>) => {
    const seq = events.length + 1;
    events.push({ id: `fixture-${seq}`, seq, at: "2026-10-02T00:00:00Z", type, data });
  };
  for (let turn = 0; turn < turns; turn++) {
    add("message", { message: { role: "user", content: `任务 ${turn + 1}：检查模拟组件与窄屏布局。` } });
    add("step/start", { step: turn + 1 });
    for (let call = 0; call < 2; call++) {
      const id = `call-${turn}-${call}`;
      add("tool/call", { "call-id": id, name: call ? "grep" : "read",
        arguments: { path: `mock/components/Example${turn}.tsx`, query: "TODO", details: "模拟参数\n".repeat(8) } });
      add("tool/result", { "call-id": id, ok: true, "duration-ms": 12,
        content: `模拟文件 ${turn}\n${"多行工具结果用于检查展开高度。\n".repeat(14)}` });
    }
    add("step/end", { step: turn + 1 });
    add("message", { message: { role: "assistant", reasoning: `模拟推理 ${turn + 1}。\n`.repeat(7),
      content: `### 回复 ${turn + 1}\n\n已检查模拟组件。这里包含中文与 English，验证宽度变化后的换行。\n\n${turn % 3 === 0
        ? "```tsx\nconst sample = { enabled: true };\nconsole.log(sample);\n```\n\n" : ""}${"- 已完成这一项模拟检查。\n".repeat(turn % 5 + 1)}` } });
  }
  return { session_id: "offline-fixture", path: "mock://timeline", cursor: { generation: 1, sequence: events.length },
    events, state: { phase: "idle" }, interactions: [], models: null };
}
