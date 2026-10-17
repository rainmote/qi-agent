# qi-agent 维护任务入口

修改前读取任务合同、[LESSONS.md](LESSONS.md)、[代码与验收规范](docs/code-standards.md)，以及受影响子系统的源码和说明。

| 范围 | 先读 |
| --- | --- |
| runtime / profile | `agent.edn`、`docs/runtime-integrity.md`、`src/qi/plugins/runtime.clj` |
| daemon / Web / 会话 | `docs/daemon-agent-architecture.md`、`docs/webui.md`、`docs/workspace-files.md` |
| 计划 / workflow / 团队 | `docs/orchestration.md` |
| 调度 / goal | `docs/automation.md` |
| TUI / ACP | `docs/tui-ratatui.md`、`docs/acp.md` |
| 桌面操作 | `docs/computer-use.md`、`docs/lcu.md` |
| 评测 | `evals/README.md`、`evals/harbor/README.md` |
| 维护闭环 / 发布 | `docs/maintenance.md`、`maintenance/policy.json`、`.github/workflows/` |

每个维护任务使用独立候选工作区，一次一个写入者。保留原工作区修改；不得 reset/clean 原目录。
验收绑定源码、profile、控制器、测试和镜像指纹。执行结束不等于验收通过，缺失、取消、跳过和超时如实记录。
控制器、权限、验收器、规则和发布链的改动需要单独审查；候选不能激活自己的规则。
未知外部结果先对账，不盲目重试。当前闭环只产出待审候选；合入、发布、定时运行以用户明确授权为准。
