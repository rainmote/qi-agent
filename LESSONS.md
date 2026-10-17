# 已核实的维护教训

只记录可追溯事故。`Seen` 按独立 incident_id 去重，日期按 Asia/Singapore 计算；重复复盘不增加出现次数。
三个不同日期的独立事故可以提出规则升级，接受规则仍需审查。

## snapshot-tar-epipe：成功解压也可能提前关闭管道

- incident_id：QI-NAS-20261015-snapshot；occurred_at：2026-10-15。
- 适用：macOS 上通过 Node spawnSync 向 BSD tar 传入 Git 归档。
- 证据：CI run `38665564871` 的 macOS 维护测试因 `spawnSync tar EPIPE` 失败；`maintenance/tests/snapshot.test.mjs` 使用合法尾部零填充和真实 tar 稳定复现，tar 退出码为 0 但 Node 输入管道报告 EPIPE。
- 正确做法：保留归档大小上限，将归档写入独立私有临时文件再解压，最终清理；不能忽略所有 EPIPE 或反复重跑消除失败记录。
- Seen：1；状态：observed；未触发三日升级。

## terminal-outcome：结束不是成功

- incident_id：QI-LOOP-000-outcome；occurred_at：2026-10-14。
- 适用：runtime、子任务、workflow 和恢复记录的终态传播。
- 证据：`9021dc7532bec7f9b66df1bca78f619385daa9e9`，`test/qi/run_outcome_test.clj`。
- 正确做法：保存 status / reason / error / verification，未验收不得用 completed 代替通过。
- Seen：1；状态：accepted；已有机器检查，未触发三日升级。

## sqlite-wal-close：原生依赖死锁需要线程证据

- incident_id：QI-UNATTENDED-20261015-wal；occurred_at：2026-10-15。
- 适用：daemon 的并发 SQLite WAL 连接与 goal 收尾。
- 证据：`apps/tui-rs/tests/sqlite_wal.rs`；升级前 3.51.1 的并发连接测试在有界子进程内触发死锁断言；实际 daemon 堆栈同时停在 `unixClose` 和 `unixIsSharingShmNode` 的相反锁顺序。
- 正确做法：保留失败、定位线程与依赖版本；升级包含上游修复的依赖，验证并发行为及实际 goal/restart 流程，不能靠扩大超时或反复重跑消除失败记录。
- Seen：1；状态：observed；未触发规则升级。

## complete-compaction：摘要覆盖必须可核对

- incident_id：QI-LOOP-000-context；occurred_at：2026-10-14。
- 适用：长历史、工具参数和结果的压缩；覆盖信息不能证明语义完全保真。
- 证据：同上修复提交，`test/qi/context_integrity_test.clj`。
- 正确做法：完整分段、保留当前指令、原子替换；失败保留原上下文并阻断不适配请求。
- Seen：1；状态：accepted；已有机器检查，未触发三日升级。
