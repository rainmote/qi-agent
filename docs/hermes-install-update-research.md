# Hermes Agent 安装与更新调研

调研日期：2026-08-31。结论基于 Nous Research 官方仓库当日 `main` 分支；上游仍在快速
迭代，具体选项以后可能变化。

## Hermes 的做法

Hermes 将“程序代码”和“用户状态”视为两个不同生命周期：

| 范围 | 默认位置 | 更新行为 |
| --- | --- | --- |
| Git checkout | `~/.hermes/hermes-agent/` | fetch/pull `origin/main`，更新依赖 |
| 用户配置与凭据 | `~/.hermes/config.yaml`、`.env`、`auth.json` | 位于 checkout 外，更新前做快照并迁移新增配置 |
| 记忆与技能 | `~/.hermes/memories/`、`skills/` | 位于 checkout 外，不随 Git 覆盖 |
| 历史对话 | `~/.hermes/state.db`、`sessions/` | 位于 checkout 外；大型数据库不进入默认轻量快照 |
| 日志与任务 | `~/.hermes/logs/`、`cron/` | 位于 checkout 外 |

`hermes update` 的官方流程还包括：更新前状态快照、Git 拉取、关键 Python 文件语法检查及
失败回滚、依赖同步、配置迁移，以及 gateway 重启。源码 checkout 有本地改动时，交互更新
会 stash；非交互更新由配置决定保留或丢弃。Hermes 还提供 `--check`、`--plan`、完整备份和
更新收据，这些属于更成熟的多 profile/常驻服务运维能力。

官方依据：

- [Installation / Install Layout](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
- [Updating & Uninstalling](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/updating.md)
- [POSIX installer](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)
- [Configuration directory structure](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)
- [Session persistence](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)

## qì agent 采用的边界

qì agent 采用 Hermes 最关键的原则，但没有照搬其 Python 依赖、profile fleet 和 gateway
管理复杂度：

| 范围 | qì agent 路径 | 保证 |
| --- | --- | --- |
| Git checkout | `$QI_AGENT_INSTALL_DIR`，默认 `~/.qi-agent/app` | 只放程序源码和构建产物 |
| 用户 Profile | `$QI_AGENT_HOME/agent.edn` | 首次迁移旧安装配置，普通升级不覆盖 |
| 用户资源和决定 | `$QI_AGENT_HOME/{trust.edn,presets,skills,AGENTS.md}` | Git 更新不访问 |
| Supervisor/Web 状态 | `$QI_AGENT_HOME/state`、`web` | Git 更新不访问；SQLite 自身升级前另有一致性备份 |
| 项目会话 | `<workspace>/.qi-agent/sessions` | 位于应用和用户数据目录之外 |

当前 qì agent 尚无 Hermes `MEMORY.md`/`USER.md` 对应的一等持久记忆插件；如果用户或未来
插件在 `$QI_AGENT_HOME/memories` 保存记忆，该目录同样位于 Git checkout 外，升级测试已用
哨兵文件验证不会被改写。

## qì agent 更新协议

```bash
qi-agent upgrade --check
qi-agent upgrade
```

1. 检查安装目录确实是 Git checkout。
2. 检查 tracked/untracked 源码改动；存在任何改动就 fail closed，不自动 reset 或 stash。
3. fetch 安装所跟踪的 remote/branch。
4. 在安装目录同一文件系统的临时 checkout 中切到目标 commit。
5. 在临时 checkout 中执行锁定依赖的 Rust release build，并加载 Clojure 启动 namespace 做
   语法/启动面验证。
6. 验证成功后切换 `app` 子目录；切换报告失败时恢复旧目录，然后重建受管理的 launcher。
7. 整个过程不复制、移动或删除 `$QI_AGENT_HOME` 的其他内容，也不访问项目 `.qi-agent/`。

这里选择“脏 checkout 直接拒绝”，而不是 Hermes 的自动 stash，是因为 qì agent 的安装
checkout 定位为不可编辑的受管理程序目录；开发工作应留在独立 clone 中。这一策略更简单，
也避免非交互更新把本地补丁意外重新应用到运行版本。

`qi-agent update` 已经是 supervisor 的 worker/lease 修复命令，为保持兼容，程序更新使用
`qi-agent upgrade`。第一次从旧的复制式安装迁移时，需要在源码仓库再执行一次 `bb install`；
以后不再依赖开发 clone。

## 尚未照搬的 Hermes 能力

- qì agent 暂无配置 schema 版本及交互迁移器；`agent.edn` 是完整用户 Profile，因此默认只
  保留，不尝试自动合并上游字段。
- 更新器尚不生成 Hermes 式 machine-readable receipt，也不管理多 profile fleet。
- 更新器不会自动协调已经由 systemd/launchd 常驻的 daemon。升级后应重启对应服务，或先
  `qi-agent shutdown`，再升级并重新启动。此项是运行版本切换问题，不影响数据隔离保证。
- 源码 checkout 使用浅克隆；当前实现提供安全前进更新，不提供一条命令的任意 commit 回滚。

这些差异是当前能力边界，不应被描述为已经与 Hermes 完全等价。
