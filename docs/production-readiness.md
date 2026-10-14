# 生产运行手册

## 支持边界

当前可生产使用的目标是“受信任单用户的本地 coding agent”：daemon、TUI、worker 和状态文件
运行在同一个操作系统账号下，Web Host 只绑定回环地址，模型通过公开 API 调用。它不是公网
多租户 SaaS，也不把第三方插件当成不可信代码隔离。

- macOS 的 `bash`/REPL 使用 Seatbelt 禁网并限制写入工作区；Linux 没有安全 provider 时会
  fail closed，不注册进程执行能力。需要在 Linux 开启 shell 时，应把 execution world 放入
  容器或受限远程执行环境，不能仅设置 `:sandbox :none` 后称为隔离。
- `qi.plugins.openai-responses` 是默认生产 adapter；`qi.plugins.chatgpt` 依赖内部订阅
  协议并标记为 experimental，不应作为无人值守生产默认值。
- Web Host 默认拒绝非回环地址。`--unsafe-allow-network` 只用于已有认证和 TLS 的反向代理；
  此模式接受与 `Host` 或代理 `X-Forwarded-Host` 严格匹配的 HTTPS Origin，并把鉴权 cookie
  标记为 `Secure`，但不提供租户隔离、RBAC 或审计身份。
- 插件与 agent 进程同权限。生产 profile 只应加载经过代码审计并固定版本的插件。

## 上线前检查

运行时最低版本由 README 声明；Rust 最低版本为 1.88，与 `Cargo.toml` 的 `rust-version`
一致。CI 固定 Node 22.12 和 Babashka 1.13.219，在 Linux、macOS 运行 Rust、Clojure 和 Web
测试，并单独使用 Rust 1.88 与锁定依赖构建全部 Rust targets。主分支应要求 `CI / Test`、
`CI / MSRV 1.88` 的所有平台检查与 `CI / Dependency audit` 通过。

```bash
export OPENAI_API_KEY="..."
npm ci
bb test
npm run typecheck
npm run test:web
npm run test:web-ui
cargo fmt --manifest-path apps/tui-rs/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/tui-rs/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path apps/tui-rs/Cargo.toml
cargo +1.88.0 build --locked --all-targets --manifest-path apps/tui-rs/Cargo.toml
cargo build --release --locked --manifest-path apps/tui-rs/Cargo.toml
expect apps/tui-rs/tests/pty-smoke.exp
```

首次启动后检查：

```bash
qi-agent doctor
qi-agent backup
```

`doctor.ok` 只有在 worker 状态、SQLite quick check 和 schema revision 都正常时才为 `true`。
没有常驻 worker 也属于正常状态。Web 部署可分别探测 `/health/live` 与 `/health/ready`；后者还
检查静态产物、配置、daemon 二进制和 allowlist 工作区。

## 状态、权限与配额

运行目录、socket、lock、SQLite、worker 描述文件、session、持久状态和工具输出会迁移为
owner-only（目录 `0700`、普通文件 `0600`），符号链接状态文件会被拒绝。默认资源边界：

| 资源 | 默认值 | 配置 |
| --- | ---: | --- |
| 单文件读取 | 16 MiB | execution world `:max-file-bytes` |
| 单次/最终文件写入 | 4 MiB | `:max-write-bytes` |
| 一次目录遍历 | 100,000 项 | `:max-walk-entries` |
| shell 最长运行 | 5 分钟 | `:max-timeout-ms` |
| 单命令落盘输出 | 10,000,000 字符/流 | `:max-output-file-chars` |
| 保留工具完整输出 | 1,000 份/工作区 | `:max-output-files` |
| worker 单日志 | 10 MiB | `QI_AGENT_LOG_MAX_BYTES` |
| 单日志轮转 | 3 份 | `QI_AGENT_LOG_BACKUPS` |
| worker 日志总数 | 100 | `QI_AGENT_MAX_WORKER_LOGS` |

命令超时、取消或输出越界会先终止整棵后代进程树。工具输出先写入受保护的临时 spool，只有
需要完整输出时才生成持久文件；启动时只清理符合 qi-agent UUID 命名规则的旧输出。

## 数据库升级、备份与恢复

Supervisor 使用 `PRAGMA user_version` 管理 schema。启动时先做 quick check；已有数据库版本
落后时，先通过 SQLite `VACUUM INTO` 创建一致性快照，再在事务里迁移。高于当前程序支持版本
的数据库会拒绝启动，避免旧二进制破坏新数据。自动和手工快照位于状态目录的 `backups/`，
权限为 owner-only，只保留最近 5 份。

恢复时先停止 daemon，不要覆盖正在使用的数据库：

```bash
qi-agent shutdown
state_dir="/absolute/path/to/qi-agent-state"
recovery_dir="$state_dir/recovery-before-restore"
mkdir -m 700 "$recovery_dir"
mv "$state_dir/supervisor.sqlite" "$recovery_dir/"
test ! -e "$state_dir/supervisor.sqlite-wal" || mv "$state_dir/supervisor.sqlite-wal" "$recovery_dir/"
test ! -e "$state_dir/supervisor.sqlite-shm" || mv "$state_dir/supervisor.sqlite-shm" "$recovery_dir/"
install -m 600 "$state_dir/backups/SELECTED.sqlite" "$state_dir/supervisor.sqlite"
qi-agent doctor
```

未设置 `QI_AGENT_STATE_DIR` 时，若配置了 `QI_AGENT_HOME`，状态目录为
`$QI_AGENT_HOME/state`；否则依次使用 `$XDG_STATE_HOME/qi-agent` 或 `~/.qi-agent/state`。
恢复前应另外保存当前数据库及 `-wal`/`-shm` 文件；session JSONL 位于
各工作区 `.qi-agent/sessions/`，不包含在 supervisor 备份中，需要纳入独立文件备份策略。

## 发布与校验

发布前还必须通过 [维护发布闸门](maintenance.md)：解析 tag 的精确 SHA，核对该提交最新完整 CI
及所有必需平台检查；package 固定 checkout 该 SHA。publish 重新校验标签、CI、完整产物、
原始校验和、source manifest 与 attestation。缺失、取消和未知检查均阻断。Intel macOS 打包
使用 `macos-15-intel`，替代已退役的 `macos-13`（[GitHub 退役公告](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)）。

推送与 `package.json`、Cargo package 版本一致的 `v*` tag 后，会先在干净环境完成 Rust
格式与 lint、Clojure runtime、daemon/Web Host、Web UI 和 Rust TUI 测试；通过后才会在
Linux/macOS 的 x86_64 与 arm64 runner 上用 lockfile 构建运行包。发布包包含预编译 CLI、
runtime 源码、WebUI、示例与文档。Release 同时发布可在下载目录直接使用的单包 SHA256、
汇总 `SHA256SUMS` 和 GitHub artifact attestation。已存在的 tag 资产不会被静默覆盖。
发布步骤通过 `GH_REPO` 显式指定触发工作流的仓库，不依赖本地 Git checkout 推断发布目标。

```bash
shasum -a 256 -c qi-agent-vX.Y.Z-PLATFORM.tar.gz.sha256
gh attestation verify qi-agent-vX.Y.Z-PLATFORM.tar.gz --repo OWNER/REPOSITORY
```

发布包不包含本地 `target/` 缓存、Node 依赖、session、凭据或用户状态。`bb install` 创建
`~/.qi-agent/app` Git checkout，使用 `cargo build --release --locked --bins` 构建，并在激活前
删除中间构建产物。`qi-agent upgrade` 在独立 checkout 中 fetch、构建和验证后替换该
应用子目录；`~/.qi-agent/agent.edn`、`state/`、`web/`、用户资源以及各工作区
`.qi-agent/sessions/` 均位于 Git 管理范围外。

## 告警与故障处理

本地部署至少应定期采集 `qi-agent doctor` JSON，并对以下情况告警：`ok=false`、
`database_integrity` 不是 `ok`、schema revision 不匹配、worker `alive=false`、日志持续轮转、
或 release/CI 依赖审计失败。当前项目不内置 Prometheus server、集中日志、PagerDuty 集成或
跨主机高可用；这些属于部署平台职责。需要公网、多租户、合规身份审计或 HA 时，仍需增加
独立网关/RBAC、集中遥测、密钥管理和远程隔离执行层。
