# 完成嵌套运行的用量账本

这是受 agent 用量统计问题启发的合成开发题，只用于开发评测流程，不是真实项目或留出 benchmark。仅修改 `src/usage.mjs`；环境是无第三方依赖的 Node.js。保留 `aggregateUsage(events)` 导出。

events 是任意顺序的数组，每条记录形如：

```js
{ event_id: 'call-1', run_id: 'child', parent_run_id: 'root',
  usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 3 } }
```

usage 是该次调用的增量，不是包含子运行的累计快照；压缩、重试或失败前已发生的消耗也可以作为普通事件传入。以下是完整约定：

- event_id、run_id 必须是非空字符串；parent_run_id 必须是 null 或非空字符串。usage 必须是非 null、非数组对象。三个计数缺省为 0，显式 undefined 也视为缺省；如果给出，必须是非负安全整数，cached_input_tokens 不能大于 input_tokens。其他额外字段忽略。
- 以 `(run_id, event_id)` 为唯一键去重。相同键且标准化后三个计数和 parent_run_id 都一致的重复事件只统计一次；同键内容冲突抛 TypeError。同 event_id 可用于不同 run。
- 同一 run 的所有事件必须声明相同 parent_run_id；每个非 null 的父 run 都必须在 events 中存在。父子关系不能自引用或成环。以上结构问题抛 TypeError；允许多个根节点和任意深度。
- 返回 `{ total, runs }`。total 是所有去重事件三个计数分别相加。cached_input_tokens 是 input_tokens 的子集，不能再额外加进 input_tokens。
- runs 是按 run_id JavaScript 字符串 `<` / `>` 顺序升序排列的数组。每项为 `{ run_id, parent_run_id, own, subtree }`。own 只包含本 run 的三个计数，subtree 包含自身和所有后代；三个计数的字段名与 usage 相同。各根的 subtree 相加等于 total。
- 空 events 返回三个计数全为 0 的 total 和空 runs。events 不是数组、记录字段不符合约定时抛 TypeError。任何聚合计数超出安全整数范围时抛 RangeError。
- 不修改输入数组、记录或 usage；返回数据之间不能意外共享可变的计数对象，例如修改某 run.own 不得改变它的 subtree 或 total。

验收覆盖重复传递、乱序多层子运行、多根、计数缺省、冲突、环、非法计数和聚合溢出。
