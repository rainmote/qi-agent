# 已核实的维护教训

只记录可追溯事故。`Seen` 按独立 incident_id 去重，日期按 Asia/Singapore 计算；重复复盘不增加出现次数。
三个不同日期的独立事故可以提出规则升级，接受规则仍需审查。

## terminal-outcome：结束不是成功

- incident_id：QI-LOOP-000-outcome；occurred_at：2026-10-14。
- 适用：runtime、子任务、workflow 和恢复记录的终态传播。
- 证据：`9021dc7532bec7f9b66df1bca78f619385daa9e9`，`test/qi/run_outcome_test.clj`。
- 正确做法：保存 status / reason / error / verification，未验收不得用 completed 代替通过。
- Seen：1；状态：accepted；已有机器检查，未触发三日升级。

## complete-compaction：摘要覆盖必须可核对

- incident_id：QI-LOOP-000-context；occurred_at：2026-10-14。
- 适用：长历史、工具参数和结果的压缩；覆盖信息不能证明语义完全保真。
- 证据：同上修复提交，`test/qi/context_integrity_test.clj`。
- 正确做法：完整分段、保留当前指令、原子替换；失败保留原上下文并阻断不适配请求。
- Seen：1；状态：accepted；已有机器检查，未触发三日升级。
