# 生产运行手册

## 支持边界

当前可生产使用的目标是“受信任单用户的本地 coding agent”：daemon、TUI、worker 和状态文件
运行在同一个操作系统账号下，Web Host 只绑定回环地址，模型通过公开 API 调用。它不是公网
多租户 SaaS，也不把第三方插件当成不可信代码隔离。

- macOS 的 `bash`/REPL 使用 Seatbelt 禁网并限制写入工作区；Linux 没有安全 provider 时会
  fail closed，不注册进程执行能力。需要在 Linux 开启 shell 时，应把 execution world 放入
  容器或受限远程执行环境，不能仅设置 `:sandbox :none` 后称为隔离。
- `agent.plugins.openai-responses` 是默认生产 adapter；`agent.plugins.chatgpt` 依赖内部订阅
  协议并标记为 experimental，不应作为无人值守生产默认值。
- Web Host 默认拒绝非回环地址。`--unsafe-allow-network` 只用于已有认证和 TLS 的反向代理，
  不提供租户隔离、RBAC 或审计身份。
- 插件与 agent 进程同权限。生产 profile 只应加载经过代码审计并固定版本的插件。

## 上线前检查

运行时最低版本由 README 声明；CI 固定 Node 22.12 和 Babashka 1.13.219，并在 Linux、macOS
运行 Rust、Clojure 和 Web 测试。主分支应要求 `CI / Test` 与 `CI / Dependency audit` 通过。

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
cargo build --release --locked --manifest-path apps/tui-rs/Cargo.toml
expect apps/tui-rs/tests/pty-smoke.exp
```

首次启动后检查：

```bash
dao doctor
dao backup
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
| worker 单日志 | 10 MiB | `DAO_LOG_MAX_BYTES` |
| 单日志轮转 | 3 份 | `DAO_LOG_BACKUPS` |
| worker 日志总数 | 100 | `DAO_MAX_WORKER_LOGS` |

命令超时、取消或输出越界会先终止整棵后代进程树。工具输出先写入受保护的临时 spool，只有
需要完整输出时才生成持久文件；启动时只清理符合 dao UUID 命名规则的旧输出。

## 数据库升级、备份与恢复

Supervisor 使用 `PRAGMA user_version` 管理 schema。启动时先做 quick check；已有数据库版本
落后时，先通过 SQLite `VACUUM INTO` 创建一致性快照，再在事务里迁移。高于当前程序支持版本
的数据库会拒绝启动，避免旧二进制破坏新数据。自动和手工快照位于状态目录的 `backups/`，
权限为 owner-only，只保留最近 5 份。

恢复时先停止 daemon，不要覆盖正在使用的数据库：

```bash
dao shutdown
state_dir="/absolute/path/to/dao-state"
recovery_dir="$state_dir/recovery-before-restore"
mkdir -m 700 "$recovery_dir"
mv "$state_dir/supervisor.sqlite" "$recovery_dir/"
test ! -e "$state_dir/supervisor.sqlite-wal" || mv "$state_dir/supervisor.sqlite-wal" "$recovery_dir/"
test ! -e "$state_dir/supervisor.sqlite-shm" || mv "$state_dir/supervisor.sqlite-shm" "$recovery_dir/"
install -m 600 "$state_dir/backups/SELECTED.sqlite" "$state_dir/supervisor.sqlite"
dao doctor
```

未设置 `DAO_STATE_DIR` 时，默认状态目录是 `$XDG_STATE_HOME/dao` 或
`~/.local/state/dao`。恢复前应另外保存当前数据库及 `-wal`/`-shm` 文件；session JSONL 位于
各工作区 `.bb-agent/sessions/`，不包含在 supervisor 备份中，需要纳入独立文件备份策略。

## 发布与校验

推送与 `package.json`、Cargo package 版本一致的 `v*` tag 会在 Linux/macOS 的 x86_64 与
arm64 runner 上重新测试、用 lockfile 构建并生成最小运行包。Release 同时发布单包 SHA256、
汇总 `SHA256SUMS` 和 GitHub artifact attestation。

```bash
shasum -a 256 -c dao-vX.Y.Z-PLATFORM.tar.gz.sha256
gh attestation verify dao-vX.Y.Z-PLATFORM.tar.gz --repo OWNER/REPOSITORY
```

发布包不包含本地 `target/` 缓存、Node 依赖、session、凭据或用户状态。`bb install` 同样只
stage 运行所需源码，使用 `cargo build --release --locked`，并在激活前删除中间构建产物。

## 告警与故障处理

本地部署至少应定期采集 `dao doctor` JSON，并对以下情况告警：`ok=false`、
`database_integrity` 不是 `ok`、schema revision 不匹配、worker `alive=false`、日志持续轮转、
或 release/CI 依赖审计失败。当前项目不内置 Prometheus server、集中日志、PagerDuty 集成或
跨主机高可用；这些属于部署平台职责。需要公网、多租户、合规身份审计或 HA 时，仍需增加
独立网关/RBAC、集中遥测、密钥管理和远程隔离执行层。
