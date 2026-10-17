# 重构与优化待办

> 审计基线：`main` @ `0567c1e`（2026-10-17）
> 审计范围：Clojure 内核/插件、Rust daemon/TUI、Web Host/Web UI、maintenance、evals、测试/CI/配置
> 文档性质：只读审计产出的待办清单。本次未修改任何产品代码，也未运行完整测试套件。
> 证据等级：**R** = 本次审计中已复现（含子审计执行的命令）；**C** = 已核对代码；**U** = 待复核。

本文件只是待办，不是验收记录。完成一项后请在第 9 节勾选，并把证据（候选 SHA、命令、退出码、原始日志路径）登记到对应条目或私有证据目录。

## 0. 摘要

本次共整理 **31 个可独立开工的条目**：P0 × 3、P1 × 20、P2 × 8。

优先处理的不是“代码难看”，而是三个边界：

1. **会话写入没有跨进程租约**（OPT-001）。Clojure 侧直接追加 JSONL，只有 Rust daemon 在 spawn 前拿 `.writer.lock`。本次已复现两个 session store 同时启动后写入相同 `seq`，日志分叉；恢复逻辑还会把仍存活 run 标成 `restored`。
2. **Web 托管 provider 绕过密钥端点策略**（OPT-002）。官方 Responses 适配器只在 plugin `:start` 校验 `https://api.openai.com/v1`，而 provider-settings 直接调用 `provider-entry` 注册，可把宿主环境里的 `OPENAI_API_KEY` 发往任意 HTTPS 主机（Web 只要求 HTTPS，不要求官方域名）。
3. **付费直连容器把 provider key 交给模型可执行环境**（OPT-003）。`--supervised-live` 以 `--network bridge` + `OPENAI_API_KEY` 启动，容器内 `/work` 可写、模型可执行任意命令；broker 模式已存在，但直连路径仍可用。

结构性问题集中在五处：

- **大文件**：`daemon.rs` 6,720 行、`test_runner.clj` 4,293 行、`ui.rs` 2,994 行、`tui.clj` 1,716 行、`app.rs` 1,510 行、`App.tsx` 1,010 行、`runtime.clj` 948 行、`server.ts` 680 行。
- **复制实现**：Responses 适配器 16 个同名函数中 13 个相似度 0.76–1.0（多数为 1.0）；原子写 8 份；合同校验/候选暂存 3 份；事件投影 3 份；测试清单 3 份。
- **锁用成了长期门闩**：Rust `lifecycle` 跨越 60s RPC；maintenance `writer.lock` 让 `status`/`cancel` 也不可用。
- **密钥边界分散在调用方**：base URL 校验在 plugin start、env 清洗在单个调用点、文件权限各写各的。
- **质量门禁不对称**：Rust 有 fmt/clippy/`--locked`；Clojure 无 clj-kondo/cljfmt，`maintenance/**/*.mjs` 不在 `tsc` 范围；CI 与 `npm test` 不等价；140 个 AppleDouble `._*` 文件会让维护控制器的 clean-check 直接失败。

### 建议的第一批（当天可做）

| 顺序 | 条目 | 理由 |
| --- | --- | --- |
| 1 | OPT-001 | 数据损坏，已复现 |
| 2 | OPT-002 / OPT-003 | 密钥越界，需安全审查 |
| 3 | OPT-023 | 解锁本机维护闭环（`._*` 使 `git status` 非空） |
| 4 | OPT-017 的 `--locked` 子项 | 避免 CI 在改过 lock 的树上变绿 |
| 5 | OPT-006 / OPT-018 | 小改动，直接消除丢事件与运维盲区 |

## 1. 使用约定

### 1.1 状态

| 状态 | 含义 |
| --- | --- |
| `todo` | 未开始 |
| `in-progress` | 已开候选工作区，登记了写入者 |
| `blocked` | 缺失前置、需独立审查或外部决定 |
| `done` | 验收项全部通过，证据已登记 |
| `dropped` | 明确不做，在第 8 节记录原因 |

### 1.2 完成定义（DoD）

1. 行为修复先有失败测试，再有通过测试；纯重构不改变行为，须由现有测试 + 结构断言（行数、依赖方向、公开 API 快照）证明。
2. 验收绑定 base/candidate SHA、profile、控制器、验收器和环境指纹；脏工作区不能借用 HEAD 的绿灯。
3. 跑完受影响范围的完整测试、typecheck、构建；跨端改动至少覆盖两端契约测试。
4. 同步更新受影响的 `docs/`（架构、命令、默认值）。
5. 记录命令、平台、起止时间、退出码、测试数和原始输出路径；未知结果写 UNKNOWN，未运行写 NOT_RUN。
6. 涉及维护控制器、验收器、策略、CI、发布链的改动，必须由独立审查者复核；候选不能激活自己的规则。

### 1.3 保护路径

以下路径的改动按“控制器/权限/验收器”处理，需单独审查并保留旧证据：

- `maintenance/lib/controller.mjs`、`maintenance/lib/environment.mjs`、`maintenance/policy.json`、`maintenance/checks.json`
- `.github/workflows/*`、`maintenance/release-gate.mjs`、`maintenance/draft-pr.mjs`
- `src/qi/plugins/{approval,trust,policy}.clj`、`src/qi/sandbox.clj`
- `apps/web-host/coding-candidates.ts`、`apps/web-host/workspace-files.ts`、`apps/web-host/candidate-verdict.ts` 相关验收逻辑

### 1.4 证据等级与限制

- 本次为静态审计，除特别标注外没有执行完整测试、Docker 或真实模型调用。
- 行号对应基线 `0567c1e`，后续改动会使行号漂移；开工时先按符号名重新定位。
- 本机是 NFS 挂载的 macOS 工作区，`._*` 与文件锁语义都受平台影响；涉及锁的条目需在 NFS 与本地磁盘各验证一次。

### 1.5 单项开工流程

1. **认领**：把第 2 节对应行改为 `in-progress`，登记候选工作区与写入者；一次只开一项。
2. **复现/红测**：按条目的“证据”先跑一次，确认失败或记录基线；无法复现时先补测试或降级为 `U`。
3. **固定基线**：记录 base SHA、profile、控制器/验收器 SHA、镜像 digest 和平台。
4. **最小修改**：只改该条目范围；行为修复与纯重构分开提交。
5. **验证**：跑条目验收 + 第 7 节横切清单；把命令、退出码、原始输出存到私有证据目录。
6. **收尾**：同步文档，勾选第 9 节，状态改 `done`；未完成则写 `blocked` 和具体阻塞条件，不用“稍后重试”代替结论。

## 2. 条目总览

| ID | 标题 | 子系统 | 优先级 | 工作量 | 风险 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OPT-001 | 会话日志跨进程写入租约 | Clojure session | P0 | M | 中 | R | todo |
| OPT-002 | Web 托管 provider 的密钥端点策略 | Web/provider | P0 | S | 低 | R | blocked |
| OPT-003 | maintenance 付费直连的凭据隔离 | maintenance | P0 | M | 中 | C | todo |
| OPT-004 | Rust daemon 分层与协议类型化 | Rust | P1 | L | 中 | C | todo |
| OPT-005 | Rust 生命周期锁不跨越 RPC | Rust | P1 | M | 中 | C | todo |
| OPT-006 | Web 快照刷新合并事件游标 | Web | P1 | S | 低 | C | todo |
| OPT-007 | Web Host 路由、错误与共享契约 | Web Host | P1 | M | 中 | C | todo |
| OPT-008 | App.tsx 拆分与流式投影批处理 | Web UI | P1 | M | 中 | C | todo |
| OPT-009 | Responses 适配器去重 | provider | P1 | M | 中 | C | todo |
| OPT-010 | provider 传输层重试/取消/超时统一 | provider | P1 | M | 中 | C | todo |
| OPT-011 | session 存储组件化与锁外通知 | Clojure session | P1 | M | 中 | C | todo |
| OPT-012 | runtime.clj 拆分与预算显式化 | Clojure runtime | P1 | L | 中 | C | todo |
| OPT-013 | worker RPC 单一注册表与 schema | Clojure protocol | P1 | M | 中 | C | todo |
| OPT-014 | 统一原子写与文件替换 | Clojure 文件 | P1 | M | 中 | C | todo |
| OPT-015 | 配置默认值单一来源与未知键校验 | 配置 | P1 | M | 低 | C | todo |
| OPT-016 | 测试注册表自动发现与 test_runner 拆分 | 测试 | P1 | S | 低 | C | todo |
| OPT-017 | 质量门禁对齐（lint/checkJs/`--locked`/verify） | CI/构建 | P1 | M | 低 | C | todo |
| OPT-018 | maintenance 锁语义与恢复可见性 | maintenance | P1 | M | 中 | R | todo |
| OPT-019 | maintenance 合同与候选暂存单一实现 | maintenance | P1 | L | 中 | C | todo |
| OPT-020 | maintenance 证据语义（NOT_RUN/policy/checks） | maintenance | P1 | M | 中 | C | todo |
| OPT-021 | 跨端事件投影黄金契约 | 跨端 | P1 | M | 低 | C | todo |
| OPT-022 | 子进程环境变量清洗 | 进程边界 | P1 | S | 低 | C | todo |
| OPT-023 | 仓库卫生与文档/脚本单一事实源 | 仓库 | P1 | S | 低 | R | todo |
| OPT-024 | 输入校验前移到持久化之前 | Clojure runtime | P2 | S | 低 | C | todo |
| OPT-025 | LSP 客户端上限与空闲回收 | LSP | P2 | M | 中 | C | todo |
| OPT-026 | execution world 窗口读取与轮询降频 | Clojure 文件/进程 | P2 | M | 中 | C | todo |
| OPT-027 | background job 输出缓冲 O(n²) | jobs | P2 | S | 低 | C | todo |
| OPT-028 | session catalog 增量索引 | session | P2 | M | 低 | C | todo |
| OPT-029 | Web 目录边界、SSE 错误通道、乐观状态与 a11y | Web | P2 | M | 低 | C | todo |
| OPT-030 | 时间敏感测试与 ACP 前置条件 | 测试 | P2 | M | 中 | C | todo |
| OPT-031 | MCP HTTP/stdio 协议收敛 | MCP | P2 | M | 中 | C | todo |

## 3. P0

### OPT-001 会话日志跨进程写入租约

- **优先级**：P0 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：R
- **影响面**：`src/qi/plugins/session.clj`、`apps/tui-rs/src/worker_proxy.rs`、`src/qi/plugins/runtime.clj`（恢复）
- **现状**：Clojure session 插件在 `:start` 里直接 `(FileOutputStream. (io/file path) true)` 打开追加流（`session.clj:187`），没有任何排他租约；`migrate-session-permissions!` 只对已有的 `.writer.lock` 做 chmod（`session.clj:54-64`）。Rust `worker_proxy` 在 spawn resident worker 前会对 `<session>.writer.lock` 做 `try_lock_exclusive()`（`worker_proxy.rs:372-384`），但这条路径只覆盖 daemon 拉起的 worker。
- **复现**：在同一 JSONL 上先后 boot 两个 session store，各 append 一条 message，文件出现两条 `seq=2`、指向同一 parent 的事件；两个 store 的内存事件链也各自从 1 开始。
- **问题**：
  - 直接 CLI（`bb qi-agent --session PATH`）、嵌入 API、测试、或另一个 daemon 实例都可能与现有 writer 并发追加，产生重复 `seq`/分叉 `parent_id`。
  - `runtime/recover-interrupted-runs!`（`runtime.clj:856-876`）会把“只有 start、没有 end”的 run 标成 `:uncertain :restored`；如果它来自一个仍存活的并发 writer，就会把正在进行的工作误判为已中断。
  - 日志一旦分叉，后续 `effective-messages`、fork、compaction 都建立在损坏的顺序上。
- **方案**：
  1. 在 session `:start` 打开追加流之前，对 `<path>.writer.lock` 取跨进程排他锁，写入 `{pid, host, token, started_at}`；失败抛 `:session/writer-conflict` 并回滚已注册的 effect。Clojure 与 Rust 必须使用同一种锁原语（macOS 上 `flock` 与 `fcntl` 不互斥），或统一由 supervisor 发放 lease token，不能各自实现。
  2. 锁在 store dispose 时释放；异常退出依赖 OS 释放，另加启动时的 dead-PID 判定，不能仅凭文件存在就拒绝。
  3. `recover-interrupted-runs!` 只在本进程持有租约时执行；CLI 与 daemon 复用同一个 lease helper，避免两套规则。
  4. 若 NFS 上 `fcntl` 语义不可靠，退化为 daemon 发放的 lease token + `O_EXCL` 锁文件 + 心跳；无论哪种，都必须有“第二个 writer 被拒绝”的机器测试。
- **验收**：
  - [ ] 同一路径第二次 boot 抛 `:session/writer-conflict`，第一个 writer 不受影响。
  - [ ] daemon 端到端（Web/CLI attach）行为不变。
  - [ ] 交叉测试：Rust 持锁时 Clojure 启动被拒，Clojure 持锁时 Rust spawn 被拒（验证两种实现互斥）。
  - [ ] 持有租约时执行恢复流程，不追加任何 `restored` 修正事件。
  - [ ] 持有者被 SIGKILL 后，下一次启动能判断 PID 已死并接管，不需要手工删锁。
  - [ ] NFS 与本地磁盘各跑一次并发测试。
- **注意**：这是数据完整性修复，不要和 OPT-011 的 session 结构重构混在一个提交里。

### OPT-002 Web 托管 provider 的密钥端点策略

- **优先级**：P0 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`src/qi/plugins/provider_settings.clj`、`src/qi/plugins/openai_responses.clj`
- **现状**：官方 Responses 适配器在 plugin `:start` 中用 `valid-base-url?` 强制 `https` + `api.openai.com` + `/v1`（`openai_responses.clj:23-33,356-364`）。但 Web 托管路径在 `provider_settings/model-entry` 里直接调用 `openai-responses/provider-entry` 并用 `:upsert!` 注册（`provider_settings.clj:44-63,101-112`），绕过了 `:start`。`provider-entry` 只校验通用 `http(s)`（`openai_responses.clj:310-331`），`api-key` 会读取任意 `api-key-env`（`openai_responses.clj:19-21`）。`read-providers` 也不检查文件 owner/符号链接（`provider_settings.clj:17-27`）。
- **问题**：
  - 一个 Web 管理的 provider 配置可以把 `apiKeyEnv` 设为 `OPENAI_API_KEY`、`baseUrl` 设为任意 HTTPS 主机（本机回环还允许 http），然后让宿主环境里的密钥随请求发出；这正好绕过了适配器注释里承诺的“Refusing to send an OpenAI API key outside ...”。
  - `providers.json` 若不是 0600 或是指向别处的符号链接，读取时也不会发现。
  - 在 `--unsafe-allow-network` + 认证反代的部署里，能编辑 provider 的会话用户不等于能读宿主环境的人。
- **方案**：
  1. 把“凭据—端点”策略下沉到 `provider-entry`/`generate`，例如 `:credential-scope :openai-official`：官方 scope 只允许 `https://api.openai.com/v1`；自定义端点必须显式 `:allow-custom-endpoint true`，且该 provider 只能使用 settings 内保存的 key，不能引用宿主 env。
  2. `apiKeyEnv` 改为受控枚举（每个适配器只允许自己的 canonical env），或直接禁止 settings 引用 env。
  3. `read-providers` 用 `secure-files` 的 owner-only + 拒绝符号链接检查；保存时沿用 `0600`。
  4. 让 `provider-entry` 与 `:start` 共享同一个校验函数，删除“只有 start 才检查”的分叉。
- **验收**：
  - [ ] 扩展 `official-openai-responses-refuses-key-exfiltration`：boot provider-settings，配置 `openai-responses` + 外部 https `baseUrl` + `apiKeyEnv OPENAI_API_KEY`，启动/首次请求必须失败。
  - [ ] 官方 endpoint + settings key 的合法路径仍通过。
  - [ ] `providers.json` 为 0644 或符号链接时被拒绝。
  - [ ] 不把 key 回显到 API 响应或日志。
- **注意**：这是安全边界变更，按第 1.3 节单独审查；需要产品确认“自定义端点”是否保留、以什么显式开关保留。

### OPT-003 maintenance 付费直连的凭据隔离

- **优先级**：P0 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`maintenance/lib/execution.mjs`、`maintenance/lib/controller.mjs`、`docs/maintenance.md`
- **现状**：`containerCommand` 允许 `envNames` 中的 `OPENAI_API_KEY` 以 `--env` 传入容器（`execution.mjs:112-136`，131 行只允许这一个 key）。`controller.implement` 在非 broker 的付费模式下设置 `network: driver.paid === true && !brokered`，并传 `envNames: ['OPENAI_API_KEY']`（`controller.mjs:408-409`）。同一容器以 `readonly:false` 挂载候选工作区到 `/work`，运行的是 `bb worker.clj`，模型可以通过工具执行任意命令。
- **问题**：仓库内容/依赖里的提示注入可以指示模型 `printenv OPENAI_API_KEY` 或把它 POST 到外部；网络是开放的 bridge。broker 模式（`QI_MAINTENANCE_BROKER_URL` 回环 relay + 预算代理）本来就是为这个威胁设计的，但 `--supervised-live` 仍保留直连路径。
- **方案**：
  1. 首选：所有付费 run（含 supervised）都强制走 broker；直连模式删除或降级为显式 `--unsafe-direct-credentials`，并在文档中标注不接受。
  2. 若必须保留直连：密钥不进入容器 env，而通过仅本机可达的 unix socket / fd 代理注入；容器网络只允许回环 relay。
  3. 启动前断言容器 env 不含 `OPENAI_API_KEY`/`DEEPSEEK_API_KEY`/`QI_*`；把它做成 negative test，而不是注释。
- **验收**：
  - [ ] 容器 smoke 中 `env`/`printenv` 看不到 provider key。
  - [ ] 经 broker 的付费 run 仍能完成一次请求，费用账本记录完整。
  - [ ] 直连模式若保留，必须有显式不安全开关、文档警告和测试证明默认不可用。
  - [ ] 不改变离线/无付费路径的行为。
- **注意**：需要先确认威胁模型（受信任单用户是否接受“模型可读宿主 key”）；若不接受，本项是发布阻断。控制器改动需独立审查。

## 4. P1

### OPT-004 Rust daemon 分层与协议类型化

- **优先级**：P1 ｜ **工作量**：L ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`apps/tui-rs/src/daemon.rs`、`wire.rs`、`client.rs`
- **现状**：`daemon.rs` 6,720 行，一个 `impl Runtime` 从 1628 行延伸到 3463 行；DB/migration、worker 启动/收养、accept/dispatch、cron/goal、`bb` preset 发现、响应装饰都混在一起。`dispatch` 是 277 行的字符串 `match`（3718-3995）。`wire.rs` 的 `PublicCommand` 用 `kind`/`method` 字符串 + 无类型 `params`（`wire.rs:5-35`），`mutation` 依赖 `methods.json` 并在形状变化时 panic。
- **问题**：改一个领域要跨整文件搜索；不变量无法做成模块私有；协议方法漏改只能等到运行期；`daemon.rs` 的 review/test 面过大。
- **方案**（建议按阶段，每阶段单独提交）：
  1. 抽 `daemon/db.rs`：连接、migration、任务/租约/日程/goal 查询；先把 45 处 `Database::connection` 收敛到一个带事务的 API。
  2. 抽 `daemon/worker.rs`：spawn、PID/descriptor、收养、停止、日志轮转。
  3. 抽 `daemon/rpc.rs`：`Method` 枚举 + typed params + 路由表，替换字符串 match；`capabilities` 从同一枚举派生。
  4. 抽 `daemon/automation.rs`、`daemon/presets.rs`、`daemon/view.rs`（响应装饰）。
  5. 同步拆 `ui.rs`/`app.rs` 的渲染、按键、dialog 子模块；目标单文件 ≤ 1.2k 行。
- **验收**：
  - [ ] 每阶段 `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test --locked` 全绿，行为无变化。
  - [ ] 协议 round-trip/exhaustive match 测试覆盖 `methods.json` 中每个公开方法。
  - [ ] `daemon.rs` 最终只做 wiring/listen/shutdown；单文件行数达标。
  - [ ] 不把行为修复混进纯搬移提交。
- **注意**：与 OPT-005 分开做；先做 005 降低锁风险，再做 004 的搬移。

### OPT-005 Rust 生命周期锁不跨越 RPC

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`apps/tui-rs/src/daemon.rs`
- **现状**：`WorkerConnection::call` 只在 admission 段持有 `lifecycle`，注释明确“等待结果不能阻止另一个调用者中断”（`daemon.rs:102-113`）。但 `submit_turn_with_id`（2094-2131）、`attach`（2585-2611）、`stop_agent`（3382-3428）、`spawn_goal_continuation`（4805）改用 `call_inner`，在 60s `WORKER_RPC_TIMEOUT` 期间一直持有同一把 `lifecycle` 锁。idle sweeper 与 hydration 的获取顺序还不一致（`lifecycle → residency` vs `residency → lifecycle`）。
- **问题**：
  - 一个慢 `turn.submit`/`session.snapshot` 会阻塞同 worker 的 `turn.abort`、`subagent.stop`、`agent.stop`，用户看到“停止无响应”。
  - 关停时等待锁会拖长 drain；两条获取顺序有死锁风险。
- **方案**：
  1. 用显式 admission token/状态（`Idle → Starting → Running → Stopping`）替代长期持有的 `Mutex<()>`；admission 只在状态转换瞬间加锁。
  2. 任何 RPC 等待都不持锁；需要串行的操作通过 per-agent 队列/`watch` 串行化。
  3. 把 `call_inner` 的调用点改成“先 admission（短锁），再 `call`（无锁等待）”；在 `stop_agent` 中先发 shutdown，再等结果。
  4. 在模块文档中写死锁顺序（如 `residency → worker.lifecycle`），并用测试固定。
- **验收**：
  - [ ] fake worker 阻塞 `turn.submit` 时，同 worker 的 `turn.abort` 在 1s 内返回。
  - [ ] 阻塞 `session.snapshot` 时 `agent.stop` 不被拖到超时。
  - [ ] 关停 race 测试：create vs shutdown 不留下孤儿 proxy。
  - [ ] `cargo test`/clippy 全绿，现有 daemon_faults 不退化。
- **注意**：改锁语义前先加“慢 worker”测试，确保测试能红；不要仅靠扩大超时。

### OPT-006 Web 快照刷新合并事件游标

- **优先级**：P1 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`apps/web/src/App.tsx`、`apps/web/src/projection.ts`、`apps/web-host/server.ts`、`apps/web/src/types.ts`
- **现状**：`refreshSnapshot` 先 `await api.rpc(id, "session.snapshot")`，然后 `setProjection(fromSnapshot(snapshot))`（`App.tsx:407-414`）。等待期间 SSE 回调仍在 `applyHostEvent` 上追加事件；快照返回后整个 projection 被替换，这些事件不会重放。`SessionSnapshot` 本身带 `cursor: {generation, sequence}`（`types.ts:112-115`），但 `fromSnapshot` 没有使用它；host 的 GET snapshot 路由也只返回裸结果（`server.ts:569-571`）。
- **问题**：`stopRun` 与“核对未决操作”都会走 `refreshSnapshot`；如果此时到达 `interaction/request`、`agent/run/end` 或工具结果，UI 会永久丢掉它。审批请求丢失会让 worker 等到超时默认拒绝；run 结束事件丢失会让界面停在“停止中”。
- **方案**：
  1. host 返回 `{snapshot, eventCursor}`（复用 `AgentWorker.snapshot()` 已有游标），或让 `/api/sessions/:id/events?after=` 在重连时补发。
  2. 客户端保留“快照游标 + 快照后已应用事件”的缓冲；`setProjection` 时用 `EventIdIndex` 去重合并，而不是整体替换。
  3. 若实现成本高，至少把 `refreshSnapshot` 改为重新订阅 `events?after=<cursor>`，失败时回退到完整快照。
- **验收**：
  - [ ] 单测：延迟返回的快照 + 中间插入 `interaction/request`，最终 projection 同时包含快照状态和该交互。
  - [ ] 单测：`agent/run/end` 在快照返回前到达，界面不残留“停止中”。
  - [ ] 现有 `App.test.tsx`、`projection.test.tsx`、`server.test.ts` 仍通过。
- **注意**：不要用“刷新两次”掩盖；竞态必须由游标/去重解决。

### OPT-007 Web Host 路由、错误与共享契约

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`apps/web-host/server.ts`、`apps/web/src/types.ts`、`apps/web-host/types.ts`、`apps/shared/`
- **现状**：`server.ts` 680 行，一个 `createServer` 回调里同时做 token 交换、鉴权、健康检查、约 20 条正则路由、SSE、静态回退和错误处理（338-626）。`errorResponse` 默认 400，只把 `/not found/i` 映射为 404（104-116），ENOENT/EACCES/worker 超时/内部错误都可能变成 400，且原始 `error.message`（常含绝对路径）直接回浏览器。请求体多处 `as ProviderSettings` 或逐字段检查；Web 又重复声明了 `Workspace`/`SessionSummary`/`ProviderReloadResult`。
- **问题**：路由顺序耦合不可见；handler 无法脱离完整 host 单测；客户端无法区分校验失败、缺失、冲突与服务器故障；类型漂移能通过 `tsc`。
- **方案**：
  1. 拆 `web-host/http/`：安全/鉴权中间件、`{method, pattern, handler}` 路由表、资源 handler（sessions/files/candidates/providers）。
  2. `HttpError(status, code)` + 统一 `mapError`：ENOENT→404、EACCES→403、校验→400、uncertain/pending→409、其余→500（带 request id，不返回绝对路径）。
  3. `apps/shared/web-contract.ts`：每路由一个 JSON Schema + 推导 DTO；入口 parse 一次；Web 只从 shared 导入类型。
  4. `server.ts` 收敛为 wiring/listen/close，目标 <200 行。
- **验收**：
  - [ ] 表驱动测试覆盖 400/403/404/409/500，错误体不含路径。
  - [ ] 契约测试：合法 fixture 通过，未知/缺失字段被拒绝。
  - [ ] `HostEvent` 类型前后端一致（用类型级测试或生成的 DTO）。
  - [ ] 现有 `server.test.ts` 矩阵不改语义通过。
- **注意**：先做错误映射与共享类型，再拆路由；避免一次重写全部 handler。

### OPT-008 App.tsx 拆分与流式投影批处理

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`apps/web/src/App.tsx`、`apps/web/src/projection.ts`、`apps/web/src/Timeline.tsx`
- **现状**：`App.tsx` 1,010 行，40+ 个 `useState`（会话、preset、模型、策略、抽屉、菜单、dialog、搜索、主题……）。每个 SSE 帧都 `setProjection(applyHostEvent(...))`（`App.tsx:325-327`）；`applyHostEvent` 对 `events`、`eventIds`、`timeline.rows` 做整体复制（`projection.ts:99-130`），流式 token/tool update 会逐帧触发 App 与 Timeline 重渲染。
- **问题**：长会话下每帧成本随事件数增长；布局/测量在流式期间反复执行；组件无法独立测试，任何面板改动都碰到 App。
- **方案**：
  1. 抽 `useSession`/`useRuntimeStatus`/`useComposer` 等 hooks 或一个 reducer，把 pending/confirmed 状态收拢（也覆盖 OPT-029 的乐观回滚）。
  2. 拆 `AppShell`、`Sidebar`、`Composer`、`Workbench`、`Dialogs`；App 只做组合。
  3. 区分 durable projection 与 live partials：非 durable 帧进入缓冲，按 `requestAnimationFrame` 合并一次 `applyHostEvents(batch)`；流式行只用 ref/局部 state 更新。
  4. `Timeline` 对 `rows` 做 memo，避免无关面板变化导致整表重算。
- **验收**：
  - [ ] 现有 UI 测试全绿；新增 render-count 测试：连续 1,000 个 token 帧触发的 App 渲染次数有上限。
  - [ ] 10k 事件会话的投影/滚动基准不劣化（记录前后数据）。
  - [ ] 发送、审批、停止、附件行为与现在一致。
- **注意**：与 OPT-006 配合；先修快照竞态，再做批处理，避免掩盖丢事件。

### OPT-009 Responses 适配器去重

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/openai_responses.clj`、`src/qi/plugins/chatgpt.clj`
- **现状**：两个 Responses 适配器有 16 个同名函数，其中 13 个函数体相似度为 0.76–1.0：`responses-content`、`tool-calls`、`output-text`、`finish-reason`、`error-body`、`fallback-assistant-items`、`message-items` 等为 1.0，`emit-stream!` 0.92、`terminal-response` 0.98（本次用 `difflib` 对函数体量化）。它们已经开始分叉：chatgpt 版本缺少 parsed `:error` 检查，且 `:options` merge 可覆盖 `:model`/`:stream`。
- **问题**：解码/重试/流式修复要改两处；分叉会变成 provider 特有的正确性 bug（错误响应被当成空输出、模型被请求参数覆盖）。
- **方案**：
  1. 新建 `qi.providers.responses`：纯解码（items/message/tool-calls/finish-reason/usage/error）+ SSE 事件归一化。
  2. `generate` 参数化为 `{:post! :credential! :provider-name :retry-policy :headers}`；`chatgpt` 与 `openai-responses` 只保留鉴权、endpoint、host 校验和少量差异。
  3. 用同一份捕获的 Responses 事件流 fixture 驱动两个适配器，断言归一化输出完全一致；错误事件、空输出、`length` finish 都覆盖。
- **验收**：
  - [ ] 同一 fixture 经两个适配器得到相同 message/tool_calls/finish-reason/usage。
  - [ ] 补上 chatgpt 的错误事件处理；`:options` 不能覆盖受保护字段。
  - [ ] 现有 `official-openai-responses-request-retry-and-replay`、`chatgpt-subscription-request-and-replay` 通过。
- **注意**：不要合并鉴权与 host 策略；那是 OPT-002 的边界。

### OPT-010 provider 传输层重试/取消/超时统一

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/{openai,openai_responses,chatgpt,anthropic}.clj`、`src/qi/streaming.clj`、`src/qi/plugins/runtime.clj`
- **现状**：默认超时不一致：OpenAI 120s（`openai.clj:195`）、Responses 180s（`openai_responses.clj:13`）、Anthropic 180s（`anthropic.clj:112`）、provider-settings 又把 180000 写死（`provider_settings.clj:59`）。只有 Responses 在内部按状态码重试并把最终错误标成 `:retryable false`；ChatGPT 只按字符串匹配传输错误重试；OpenAI/Anthropic 依赖 runtime 的重试。取消 token 只在 `http/post` 前/后与重试之间检查；非流式调用会阻塞到客户端超时。`streaming/consume-sse!` 的读取端没有按字节/事件行数设上限（`streaming.clj:21-68`）。
- **问题**：相同故障在不同 provider 上重试次数/墙钟不同；隐藏重试绕过 runtime 预算与费用账本；abort 可能占用 run 线程 120-180s；恶意/异常 provider 可用超长行或无限 `data:` 行拖垮进程。
- **方案**：
  1. `qi.http.transport`：统一状态码 + IOException 重试策略，支持 `Retry-After`、指数退避 + jitter、总 deadline、统一 `:retryable` 映射；重试计数回报给 runtime。
  2. 用 `HttpClient/sendAsync` + `on-cancel!` 取消 future/关闭 body；非流式请求也能在取消后 <250ms 返回。
  3. `consume-sse!` 加上 max-line-bytes、max-event-bytes、max-data-lines；超限抛有界错误，不 OOM。
  4. 所有 timeout/retry 默认值收敛到 OPT-015 的配置默认值，不在 provider-settings 里另写一份。
- **验收**：
  - [ ] fake 429/500/IOException 矩阵：每个适配器产生预期尝试次数与 `:retryable`。
  - [ ] 非流式请求在 50ms 后取消，<250ms 抛 `:cancelled`。
  - [ ] 64MB 单行 / 100k `data:` 行触发有界失败而不是 OOM。
  - [ ] 现有 provider 回放测试通过。
- **注意**：重试策略改动会影响费用与 wall budget，需同步更新账本测试。

### OPT-011 session 存储组件化与锁外通知

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/session.clj`、`src/qi/plugins/subagent_in_process.clj`、`src/qi/plugins/context_manager.clj`、`src/qi/kernel.clj`
- **现状**：session plugin 的 `:start` 是一个约 220 行的闭包工厂（`session.clj:173-395`），内含两个几乎相同的 `append!` arity（206-224）、compaction、fork、checkout、tree、label/name。`append!` 在 `(locking lock ...)` 内调用 `notify!`，而 `kernel/emit!` 同步执行监听器（只吞异常）；协议层监听器会写 stdout。`effective-messages` 在 `subagent_in_process.clj:36-44` 被重新实现（且只处理字符串 type，已与 session 的关键字支持分叉）；context-manager 仅为 `compaction-plan` require 了 session 插件（`context_manager.clj:133`）。
- **问题**：慢监听器（stdout 管道写满、trace、telemetry）会阻塞所有 append/compaction 和 run 本身；fork 的 replay 规则与主路径不同；替代 session store 无法满足 context-manager。
- **方案**：
  1. 抽纯函数命名空间 `qi.session-log`：`messages`、`compaction-plan`、`replay-until`、`effective-events`；session/subagent/context-manager 共用。
  2. 把 `:start` 拆成 `store` record/构造器 + 小函数：`append!`、`compact!`、`fork!`、`checkout!`、`tree`。
  3. `append!` 在锁内只做“分配 seq、写文件、swap”，锁外通知监听器；需要有序异步时用一个有界 dispatcher（持久 append 仍同步）。
  4. 与 OPT-001 共用 lease；`write-events-atomically!` 改用 OPT-014 的统一实现。
- **验收**：
  - [ ] 200ms 慢监听器不增加 append 延迟（测 append 前后时间）。
  - [ ] 同一组 fixture 经 session 与 subagent replay 结果一致；clear + compaction + fork 组合有测试。
  - [ ] 现有 session/compaction/context 测试全绿。
- **注意**：先加“慢监听器”失败测试；不要在重构中改变事件顺序。

### OPT-012 runtime.clj 拆分与预算显式化

- **优先级**：P1 ｜ **工作量**：L ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/runtime.clj`、`src/qi/generation.clj`、`src/qi/run_progress.clj`、`src/qi/plugins/subagent.clj`
- **现状**：`runtime.clj` 948 行，同时负责工具批次/并发槽、重试与溢出恢复、prompt 组装、持久化、run admission 和插件描述；`run-agent-body!` 是 108 行的 loop，接收 11 个位置参数（`runtime.clj:663-770`）。run 预算通过动态 var `*run*` 隐式传递（`generation.clj:5-12,107`；`runtime.clj:804`）；未绑定时 `generate!` 没有请求/墙钟限制，subagent/compaction 也读取同一 var。
- **问题**：单 run/队列/槽位不变量只存在于闭包；私有函数无法单独测试；预算在非默认循环中静默消失。
- **方案**：
  1. `qi.runtime.session`：持有 active/queue/admission 状态与转换，公开 `submit!`/`steer!`/`abort!`/`state`。
  2. `qi.runtime.tool-batch`：`execute-batch!`、槽位排序、结果归一化。
  3. `qi.runtime.provider`：`generate-with-recovery!`、溢出/重试、usage 累加。
  4. `qi.runtime.prompt`：system prompt/上下文快照。
  5. 预算改为 request metadata 显式传递；`*run*` 只保留为兼容 shim，并在缺失时抛错或使用文档化默认值。
- **验收**：
  - [ ] 现有 `runtime_recovery_test`、`context_integrity_test`、`run_outcome_test` 全绿。
  - [ ] 新增“事件序列快照”测试：同一输入产生相同 turn/step/tool 事件顺序。
  - [ ] 无预算调用 `generate!` 的行为被测试固定（抛错或显式默认）。
- **注意**：这是纯结构重构，行为修复另开提交；每拆一个模块跑一次相关测试。

### OPT-013 worker RPC 单一注册表与 schema

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/protocol.clj`、`src/qi/plugins/remote_api.clj`、`src/qi/plugins/remote_registry.clj`
- **现状**：`protocol/rpc!` 用 `cond` 手写分发 `prompt`/`steer`/`follow-up`/`abort`/`state`/`clear`/`compact`/`sessions`/`providers`/`select-provider`/`reload`（`protocol.clj:100-210`），`blocking-rpc?` 另硬编码 4 个方法名（95-98）。同一进程的 `remote_api` 又为 `session.clear`/`session.compact`/`turn.abort` 等注册了带 `:params-schema`/`:result-schema` 的方法（`remote_api.clj:172-279`）。硬编码路径不经 `schema/validate!`，compact 还直接调 `(:compact! store)` 而非 context-manager。
- **问题**：同一动词两条路径、两套校验、两种行为；新增方法要改两处；非法参数在硬编码路径上不会被拒绝。
- **方案**：
  1. `protocol.clj` 只保留 framing/read-line/response 循环与 `shutdown`。
  2. 所有动词迁到 `remote_api`（或一个 `qi.rpc.methods` 注册表）；`prompt` 作为 `turn.submit` 的兼容别名。
  3. `blocking` 改为方法元数据；由注册表统一派生。
  4. 加 parity 测试：`clear`/`compact`/`abort` 经两条路径（若保留别名）结果一致；非法参数被拒。
- **验收**：
  - [ ] `remote.methods` 输出与实际分发集合一致（机器比较）。
  - [ ] `clear`/`compact`/`abort` 行为与现状一致，compact 走 context-manager。
  - [ ] 现有 protocol/rpc 测试与 `bb test` 全绿。
- **注意**：会改变 worker 私有协议的错误形状；需要同步 daemon 侧测试。

### OPT-014 统一原子写与文件替换

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/secure_files.clj`、`src/qi/plugins/execution_world.clj`、`plugin_manager.clj`、`trust.clj`、`durable_state.clj`、`repl_worker.clj`、`presets.clj`、`install.clj`、`session.clj`
- **现状**：至少 8 处各自实现“临时文件 + protect + `ATOMIC_MOVE`”，fallback 与 fsync 语义不同：plugin_manager 带 `REPLACE_EXISTING`，session 的 fallback move 不带；durable_state 的 rename 未 fsync；各处的临时文件前缀/清理也不同。`execution_world` 的 `:write!`/`:edit!` 直接用 `spit` 覆盖目标（`execution_world.clj:535-575`），崩溃或磁盘满会留下截断文件；`edit!` 基于先 `slurp` 的旧内容重写，可能丢并发修改。
- **问题**：权限/持久性修复要改 8 处；`write`/`edit` 是最常见的模型操作，截断不可接受；不同调用点的文件权限可能不一致。
- **方案**：
  1. 在 `secure-files` 提供 `atomic-write!` / `atomic-copy!` / `atomic-replace!`：同目录临时文件、0600、拒绝符号链接、写入后 fsync、`ATOMIC_MOVE` + 跨设备 fallback、保留目标权限/owner、失败清理。
  2. 迁移 8 处调用；`execution_world` 的 write/edit 改为临时文件 + 原子替换。
  3. 对 append 语义保留直接追加（不需要整文件替换），但要先做尺寸/权限检查。
- **验收**：
  - [ ] 模拟 move/write 失败，原文件字节不变。
  - [ ] 权限、符号链接、跨设备 fallback 各有一个共享测试。
  - [ ] `write`/`edit` 的现有契约测试通过；新增“并发修改不被静默覆盖”的测试或明确拒绝策略。
- **注意**：`edit!` 的并发语义需要产品决策（检测 mtime/hash 后拒绝，还是 last-write-wins）；不要默默选择。

### OPT-015 配置默认值单一来源与未知键校验

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`agent.edn`、`src/qi/plugins/context_manager.clj`、`session.clj`、`runtime.clj`、`provider_settings.clj`
- **现状**：`agent.edn` 的 subagent `:child-profile` 重复了约 20 个 plugin spec（`agent.edn:126-179`），provider/model/proxy/retry 与父 profile 逐字复制。默认值也分散：context-manager 默认 `context-window 114688`（`context_manager.clj:61-64`），但所有 shipped profile 都写 128000；`retain-messages 12` 同时由 session（`session.clj:173-174`）和 context-manager 声明，CLI `--compact` 与 run 循环可能取到不同值；provider-settings 又写死 `:timeout-ms 180000`（`provider_settings.clj:59`）。runtime 只校验三个数字键，未知键静默忽略。
- **问题**：改一个模型/限额要同步多处；默认值与 profile 已经不一致；拼错键不会报错，只会悄悄用默认值。
- **方案**：
  1. 每个插件一个 `qi.defaults` spec（键、类型、默认值、是否必填），启动时校验并拒绝未知键。
  2. `:child-profile` 支持 `:extends` 或从父 profile 生成继承项，避免整段复制；至少加“父子 provider/limit 相等”的测试。
  3. `retain-messages`、`context-window`、timeout 各指定唯一所有者；provider-settings 从配置读取，不写死。
  4. `effective_limits`（或类似工具）输出“配置值 vs 默认值 vs 每 run 覆盖”，便于排查。
- **验收**：
  - [ ] 父/子 profile 的 provider 与 limit 解析结果相等（机器测试）。
  - [ ] 未知键启动失败并指出路径。
  - [ ] `--compact` 与 run 循环使用同一个 retain 值。
  - [ ] 生产 preset 的 32 步/64 请求/35 分钟仍与文档一致。

### OPT-016 测试注册表自动发现与 test_runner 拆分

- **优先级**：P1 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`test/qi/test_runner.clj`、`bb.edn`
- **现状**：`test_runner.clj` 4,293 行、91 个 `deftest`；`-main` 用 27 个字面量 namespace 调 `run-tests`（`test_runner.clj:4278-4292`），另在 ns 顶部手工 require 同一组。当前 26 个 `*_test.clj` + runner 全部登记，但新增文件不会被自动执行，删除一个名字也不会失败。
- **问题**：测试文件存在却从未运行是“绿色但未覆盖”；巨型 runner 让安装/协议/UI 测试共享一个命名空间，定位和并行都困难。
- **方案**：
  1. 从 `test/qi/*_test.clj` 自动发现 namespace（排除 fixture 与 opt-in `lcu_e2e`），或在启动时断言“文件集合 == 注册集合”。
  2. 把 runner 内的 91 个测试按主题拆到 `install_test`、`profiles_test`、`protocol_test`、`tui_test` 等；runner 只保留入口与 fixture 工具。
  3. 输出 collected/skipped 计数；平台条件（macOS Seatbelt）改为显式 skip 标签并打印。
- **验收**：
  - [ ] 新增一个故意失败的 `test/qi/scratch_test.clj`，不改 runner 也能让 `bb test` 失败。
  - [ ] 删除一个已注册名字会导致“文件/注册不一致”失败。
  - [ ] `bb test` 输出 collected 数；macOS-only 测试在 Linux 打印 skipped 而不是静默通过。
- **注意**：先做自动发现（S），拆分可分批；不要在同一提交里改测试语义。

### OPT-017 质量门禁对齐（lint/checkJs/`--locked`/verify）

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`bb.edn`、`package.json`、`tsconfig.json`、`.github/workflows/ci.yml`、`maintenance/checks.json`、`apps/tui-rs/Cargo.toml`
- **现状**：
  - 仓库没有 clj-kondo/cljfmt 配置、任务或 CI 步骤；Rust 有 fmt/clippy，Clojure 没有。
  - `tsconfig.json` 的 `allowJs: false` + `include: apps/**/*.ts(x)` 使 `maintenance/**/*.mjs`、`evals/**/*.mjs`、`apps/web/tests/*.mjs` 不在 `tsc --noEmit` 范围；`apps/shared/workspace-verification.mjs` 只有手写 `.d.mts`。
  - `ci.yml:46` 的 clippy 没有 `--locked`，`ci.yml:48` 的 test 有；`package.json` 的 `test:web`/`test:tui` 也没有 `--locked`。若 `Cargo.toml` 改了而 lock 未更新，clippy 可在 runner 上重写 lock，之后 locked test 通过，但该提交本身不可复现。
  - `npm test` 不含 rustfmt/clippy、`web:build`、浏览器/E2E；CI 也不调用 `npm test`，两套清单靠人维护。
- **问题**：验证“绿”可能来自被改写的 lock、缺失的 lint 或未运行的 E2E；本地/维护候选/CI 的覆盖不同。
- **方案**：
  1. 加 clj-kondo + cljfmt 的 `bb lint`/`bb fmt-check`，覆盖 `src plugins test`；CI 与维护 catalog 调用。
  2. 加 `tsconfig.checkjs.json`（`allowJs/checkJs`）覆盖 `.mjs` 安全相关目录；再加 formatter/linter（ESLint/Biome/Prettier 任一）。
  3. 所有 cargo 调用加 `--locked`；CI 第一步跑 `cargo metadata --locked` 或 `git diff --exit-code apps/tui-rs/Cargo.lock`。
  4. 定义单一 `npm run verify`（可移植超集），CI 与 `checks.json` 复用它；OS-only 步骤单列。
- **验收**：
  - [ ] 注入一个未使用 binding / 一个 `.mjs` 类型错误，新门禁失败。
  - [ ] 改 `Cargo.toml` 不更新 lock，第一个 cargo 步骤失败且工作树保持干净。
  - [ ] CI 步骤与 `verify` 清单机器比对，无遗漏。
  - [ ] `npm test` 与 CI 的差异有文档说明（或直接统一）。

### OPT-018 maintenance 锁语义与恢复可见性

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：R
- **影响面**：`maintenance/run.mjs`、`maintenance/lib/store.mjs`、`maintenance/lib/environment.mjs`
- **现状**：
  - 除 `pause` 外，所有命令都先 `lockStore(root, ...)`（`run.mjs:50`）；持锁期间 `status`/`cancel` 直接以 “Maintenance store has a writer” 退出，而它们正是文档化的恢复入口。
  - `lockStore` 的恢复路径用 `writer.lock.recovery` + `wx` 串行化（`store.mjs:58`），崩溃后该文件会永久残留，后续 `recover` 一直 `EEXIST`。
  - `inspectEnvironment` 在持有 state 锁时又对宿主级 `~/.qi-agent/maintenance-environments` 取非阻塞 `lockStore`（`environment.mjs:30`）；另一个 state root 的 doctor/tick 会把“环境探测被占用”升级成 uncertain。
- **问题**：长 verify 期间无法观察/取消；崩溃恢复被一个未文档化的锁文件永久卡住；跨 state 的只读探测互相干扰。
- **方案**：
  1. `status`/`review-window`/`doctor` 改为无锁读取：读最后一条完整事件/快照（原子读），不回放全日志；写命令仍独占。
  2. `cancel` 改为写 `cancel-intent.json`，由持锁进程在检查点轮询（类似 `pause.json`），CLI 返回“已登记取消”。
  3. 恢复标记写入 `{token,pid,host,started_at}`；获取失败时按 dead-PID 判定清理，或用 `O_EXCL` + 短暂重试；不能要求人工删文件。
  4. 环境探测锁改为 bounded wait + 明确 `environment-busy` 重试，或按 endpoint 分锁；只读探测不升级为 uncertain。
- **验收**：
  - [ ] 外部持有 writer lock 时，`status` 正常返回最近状态，`cancel` 记录 intent 并退出 0。
  - [ ] 在创建 `.recovery` 后 SIGKILL，下一次 `recover` 成功，不要求手工删除。
  - [ ] 两个不同 state root 并发探测都 PASS，无 uncertain。
  - [ ] 现有 runner/store 测试通过；新增子进程测试覆盖上述场景。
- **注意**：控制器改动需独立审查；不要用扩大超时/重跑掩盖。

### OPT-019 maintenance 合同与候选暂存单一实现

- **优先级**：P1 ｜ **工作量**：L ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`maintenance/lib/controller.mjs`、`evals/lib/core.mjs`、`evals/harbor/export.mjs`、`evals/harbor/verify.mjs`
- **现状**：
  - 合同校验有三份：`controller.validateContract`（`controller.mjs:57`）、`evals/lib/core.mjs:52-89` 的 `readTask`、`evals/harbor/export.mjs:46-97` 的 `loadTask`；各自用不同正则校验 ids/allowed_files/paths/acceptance。`export` 的 `safeRelative`（10-16）还允许路径中包含 `\n`。
  - 候选暂存/验收也有三份：`controller.candidateTree` + `preflight` 验收、`evals/lib/core.mjs:175-212` 的 `verifyCandidate`、`evals/harbor/verify.mjs:13-35`；copy/overwrite allowed/加 verifier/跑 `node --test`/解析 TAP 的细节各不相同。
- **问题**：同一合同可能被 controller 接受、被 Harbor 拒绝或弱接受；同一篡改候选在三处得到不同 verdict，维护与评测结果不可比。
- **方案**：
  1. `maintenance/lib/contract.mjs`：单一 JSON Schema/校验器，带 mode（maintenance/eval/harbor）与明确的路径规则；三处只做适配。
  2. `maintenance/lib/candidate.mjs`：`stageCandidate()`、`runAcceptance()`、`parseTap()`，注入 fs/container 执行器；maintenance、eval、Harbor 共用。
  3. 统一 fixture 表：非法合同、路径穿越、换行注入、越界修改、TAP skip/零测试。
- **验收**：
  - [ ] 同一组非法合同 fixture 在三个入口都被拒绝，错误码一致。
  - [ ] 同一个被篡改的候选在三个入口得到相同 verdict。
  - [ ] 含 `\n` 的路径被拒绝。
  - [ ] 现有 maintenance/evals 测试通过；Harbor 导出仍可被独立 verifier 消费。
- **注意**：这是验收器改动，需独立审查；候选不能用自己的规则给自己发通行证。

### OPT-020 maintenance 证据语义（NOT_RUN/policy/checks）

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`maintenance/lib/controller.mjs`、`maintenance/worker.clj`、`maintenance/policy.json`、`maintenance/checks.json`
- **现状**：
  - `executeCheck` 在 wall budget 用尽时返回 `NOT_RUN`（`controller.mjs:190-204`），但 `preflight` 把任何非 PASS 都映射为 `blocked: baseline-failed`（294-298），`verify` 映射为 `failed: verification-failed`（342-348）；只有 CANCELLED 有独立原因。超时/基础设施耗尽被记成代码失败。
  - policy 的 `parent_steps:32`/`readonly_child_steps:8` 只与字面量比较（`controller.mjs:82`），worker.clj 又硬编码 `:max-steps 32`/`:max-wall-ms 2100000`（`worker.clj:21-22`）；`readonly_child_steps` 实际未使用。
  - 必需 checks 目录仅在 `material/base/src/qi/plugins/runtime.clj` 存在时生效（`controller.mjs:142`）；`checks.json:10` 的 `production-browser` 仍是 `["sh","-c", "... && ..."]`，与“argv-only”说明冲突。
- **问题**：NOT_RUN 污染失败/无进展/遥测桶；policy 改动无法真正作用于 worker；非标准仓库可跳过强制 checks；shell 字符串破坏审计。
- **方案**：
  1. 保留每个 check 的 `status` + `reason`；预算耗尽映射为 `blocked: budget/*` 或 `uncertain`，绝不记作失败；遥测单列。
  2. 把 policy 限额通过 argv/env 传给 worker 并断言实际应用值；`readonly_child_steps` 要么实现，要么删除。
  3. 必需 checks 由任务 kind/path glob 推导，不依赖某个文件是否存在；目录校验拒绝解释器（`sh -c`）。
  4. 拆 `production-browser` 为 build/test 两个 argv check，只构建一次。
- **验收**：
  - [ ] deadline 耗尽测试断言 reason 为 budget/uncertain，遥测桶不落 `verification_failure`。
  - [ ] 改 policy 的 steps 会改变 worker argv/实际限制，并有断言。
  - [ ] 不含 `runtime.clj` 的测试仓库仍要求 catalog checks。
  - [ ] checks.json 无 `sh -c`；web 验收只构建一次。
- **注意**：策略/验收器改动需独立审查；保持旧证据可解释。

### OPT-021 跨端事件投影黄金契约

- **优先级**：P1 ｜ **工作量**：M ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`apps/tui-rs/src/projection.rs`、`apps/web/src/projection.ts`、`apps/web/src/timeline-model.ts`、`src/qi/plugins/tui.clj`、`test/fixtures/`
- **现状**：同一份 session 事件在三个前端各有一套投影/批处理/摘要逻辑：Rust `projection.rs`（1,098 行）、Web `projection.ts` + `timeline-model.ts`、Clojure TUI `tui.clj`。各自测试用自己的 fixture，没有共享的事件流/期望输出；审批、compaction、run outcome、附件、subagent 事件的呈现语义靠各自实现对齐。
- **问题**：同一事件在不同端可能显示不同状态；新增事件类型要改三处；某个端的回归测试无法证明另一端也正确。
- **方案**：
  1. 在 `test/fixtures/projection/` 放一组 JSONL 事件流（正常 turn、工具批次、审批、compaction、cancel、run outcome、subagent、附件）。
  2. 为每条流定义与语言无关的期望投影（行类型/顺序/状态/交互），存 JSON snapshot。
  3. Rust/TS/Clojure 测试各自消费同一 fixture 并比对；CI 中任一端失败即阻断。
  4. 文档注明“事件类型新增必须同时更新 fixture 与三端投影”。
- **验收**：
  - [ ] 三端对同一 fixture 产生相同行顺序与状态字段。
  - [ ] 新增一个事件类型时，三端测试都能捕获未处理（默认行/错误）。
  - [ ] 现有投影测试不删除，只迁移到共享 fixture。
- **注意**：不要求三端 UI 像素一致，只要求状态/事件语义一致。

### OPT-022 子进程环境变量清洗

- **优先级**：P1 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`src/qi/plugins/stdio_session.clj`、`src/qi/mcp_stdio.clj`、`src/qi/plugins/mcp_client.clj`、`src/qi/plugins/lsp.clj`、`src/qi/computer_use_mcp.clj`
- **现状**：`stdio-session` 用 `ProcessBuilder` 继承 daemon 环境，只追加传入的 env（`stdio_session.clj:87-91`）。`mcp_stdio` 的 `scrub-env` 是可选参数，只有 `mcp_client.clj:255` 设为 true；LSP server、桌面驱动、`bb_repl` 等直接继承 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`QI_*`。
- **问题**：任何语言服务器/第三方 MCP/驱动（包括通过包管理器安装的代码）都能读到宿主密钥；一旦被利用，等同于凭据泄露。
- **方案**：
  1. `stdio-session` 默认构造最小环境（PATH、HOME、临时目录、locale），只传显式 allowlist；需要额外变量的集成必须声明。
  2. `mcp_stdio` 的 `scrub-env` 默认 true；显式 `:inherit-env` 才继承。
  3. LSP/桌面驱动/REPL 逐个改为最小环境，并保留必要的工具链变量（如 `JAVA_HOME`、`CARGO_HOME`）。
  4. 加 fake driver/LSP：启动时打印 env，测试断言 API key 不存在。
- **验收**：
  - [ ] fake MCP/LSP/computer-use 子进程的 env 中不含 `*_API_KEY`/`QI_*`（按 allowlist 例外）。
  - [ ] 现有 MCP/LSP/computer-use 测试通过；需要 env 的集成有显式声明。
  - [ ] 文档记录最小环境与 allowlist。
- **注意**：可能影响依赖 `PATH` 之外变量的 LSP；先在 fake/fixture 上验证，再改真实驱动。

### OPT-023 仓库卫生与文档/脚本单一事实源

- **优先级**：P1 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：R
- **影响面**：`.gitignore`、`maintenance/host-controller.sh`、`maintenance/lib/controller.mjs`、`.github/workflows/release.yml`、`README.md`、`package.json`、`bb.edn`、`design-qa.md`
- **现状**：
  - 本工作区 140 个未跟踪文件全部是 AppleDouble `._*`；`.gitignore` 没有 `._*`。`host-controller.sh:21` 与 `controller.mjs:132` 都以 `git status --porcelain` 为空作为 clean 条件，因此维护控制器在本机直接失败；`release.yml` 还会 `cp -R src` 打包这些文件。
  - `maintenance-container.yml` 仍包含 `feat/unattended-readiness` 分支，`setup-node` 版本与 ci.yml 不一致；release 工作流同样使用旧 action 主版本。
  - `design-qa.md` 有 11 处 `/Users/one/...` 绝对路径，且未被 README/docs 引用。
  - `package.json` 与 `bb.edn` 有重复别名：`test:lcu-e2e` ≡ `test-lcu-e2e`、`tui:build` ≡ `tui-build`；`test:tui`（cargo test）与 `bb tui-test`（含 release build + PTY）语义不同但都像“官方入口”。
  - `README.md:371` 把 `npm test` 称为“complete repository test suite”，但它不含 fmt/clippy/browser/E2E（见 OPT-017）。
- **问题**：维护闭环在本机无法启动；发布产物可能带垃圾；文档/脚本入口互相矛盾，用户容易跑弱版本。
- **方案**：
  1. `.gitignore` 加 `._*` 与 `**/._*`，删除现存文件；release 打包前 `find ... -name '._*' -delete`。
  2. 清理/归档 `design-qa.md`（移入 `docs/archive/` 或去掉本机绝对路径）；文档中的命令用相对路径。
  3. 每个能力只保留一个主入口（npm 或 bb），删除别名或在文档标明“仅兼容”；`bb tui-test` 与 `npm run test:tui` 的差异写清楚。
  4. 加一个 docs 命令测试：从 `*.md` 抽取 `npm run`/`bb` 引用，断言脚本存在。
  5. 对齐 workflows 的 action 版本、分支过滤与 paths。
- **验收**：
  - [ ] `git status --porcelain` 为空；`git check-ignore src/qi/._cli.clj` 命中。
  - [ ] release tarball 无 `._*`。
  - [ ] 文档中的命令全部可解析；`design-qa.md` 无 `/Users/`。
  - [ ] `npm run`/`bb` 入口一一对应或有明确兼容说明。
- **注意**：本机立即做 `.gitignore` 子项即可解锁维护；其余可分批。

## 5. P2

### OPT-024 输入校验前移到持久化之前

- **优先级**：P2 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`src/qi/plugins/runtime.clj`、`src/qi/attachments.clj`、`src/qi/plugins/remote_api.clj`
- **现状**：`run-agent-body!` 只拒绝空白 prompt（`runtime.clj:666-668`），随后立即 `record-message!`；`attachments/validate-user-content!`（`attachments.clj:118-124`）只在 remote-api 调用（`remote_api.clj:243`）。嵌入 API、CLI interactive、automation、子代理消息都可能把非法/超大附件块写进持久历史。
- **问题**：写入后每个模型边界都失败，只能重写日志清除；这是“持久化的坏输入”。
- **方案**：在 `run-agent!`/`enqueue!` 的唯一入口、`record-message!` 之前校验；返回 `:reason :invalid-content`；删除 RPC 层重复校验。
- **验收**：
  - [ ] `run!` 传非法附件块时，session 事件数为 0（除 start）。
  - [ ] RPC/API/CLI 三条路径行为一致。
  - [ ] 现有附件测试通过。

### OPT-025 LSP 客户端上限与空闲回收

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/lsp.clj`
- **现状**：client 以 `[server-id project-root]` 为 key 存在 map 中（`lsp.clj:393-422`），只在 `/lsp reload` 或插件 dispose 时停止（716-722）；没有 max-clients、idle TTL 或 root 上限。
- **问题**：monorepo 每个 root 启一个语言服务器并常驻，最终耗尽 fd/进程/内存。
- **方案**：LRU + `max-clients` + idle TTL，淘汰时 `stop-client!`；或每个 server 固定一个 root。
- **验收**：fake LSP 打开 N≥max 个 root，断言最旧 client 被关闭；现有 LSP 契约测试通过。

### OPT-026 execution world 窗口读取与轮询降频

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/plugins/execution_world.clj`
- **现状**：`read-limited`/`read-lines-limited` 先 `slurp` 整个文件（上限 16MB）再截取 50KB（`execution_world.clj:67-74,127-152`）；`track-descendants-during-startup!` 每 5ms 枚举一次 `ProcessHandle` 后代（305-329），每条命令一个线程。
- **问题**：大文件读取的堆/延迟尖峰；每条 bash 约 200Hz 的进程树轮询。
- **方案**：用 `RandomAccessFile`/`BufferedReader` 只读请求窗口；进程组 kill 已能覆盖大部分场景，descendant 采样降到 100-250ms 或仅在退出时。
- **验收**：16MB 文件读 50KB 的耗时/内存有基准；现有进程树清理测试通过。

### OPT-027 background job 输出缓冲 O(n²)

- **优先级**：P2 ｜ **工作量**：S ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`src/qi/jobs.clj`
- **现状**：`append-output!` 对每个 chunk 执行 `(str (:output job) chunk)` 再 `subs`，在 manager 锁内复制整个 200k 缓冲（`jobs.clj:50-61`）。
- **问题**：聊天型 job 的输出追加是 O(n²)，并阻塞 `job_output` 轮询。
- **方案**：固定容量 ring buffer 或 `StringBuilder` + 绝对 offset，追加不复制。
- **验收**：10k chunk 的耗时/分配基准；`live-output-has-stable-cursors-and-a-bounded-tail` 仍通过。

### OPT-028 session catalog 增量索引

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`src/qi/plugins/session_catalog.clj`
- **现状**：每次 `:list`/`refresh!` 都 walk 所有 `.jsonl`，对每个文件 `line-seq` + JSON parse 全部行（`session_catalog.clj:9-56`），没有缓存。
- **问题**：列表耗时随 transcript 总字节增长；大工具输出会让 WebUI 会话列表变慢。
- **方案**：按 `path+mtime+size` 增量索引；name/label/fork 用头尾读取；未变化文件跳过。
- **验收**：500 个 session 的 fixture，第二次 refresh 跳过未变文件且结果与全量扫描一致。

### OPT-029 Web 目录边界、SSE 错误通道、乐观状态与 a11y

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：低 ｜ **证据**：C
- **影响面**：`apps/web-host/server.ts`、`apps/web/src/App.tsx`、`apps/web/src/Dialogs.tsx`、`apps/web/src/api.ts`
- **现状**：
  - `/api/directories` 对任意宿主路径 `realpath` + `readdir`（默认 home），无 allowlist/上限（`server.ts:442-456`）。
  - SSE 在 backlog 超限/快照失败时直接关闭，不发 `event:error`；客户端只置 `connected=false` 并每 1.5s 重连（`server.ts:162-246`、`api.ts:161-183`）。
  - `pendingModel/pendingThinking/pendingPolicy` 先设后发 RPC，失败不回滚（`App.tsx:157-160,622-674`）；`composerContext` 在只有 context-window 时伪造 used=0。
  - 命令 listbox 无 `aria-activedescendant`；会话/视图菜单缺方向键/Escape；DialogFrame 不恢复焦点。
- **问题**：宿主目录枚举超出工作区边界；永久故障变成静默重连循环；UI 显示未生效的模型/权限；键盘/读屏用户丢失上下文。
- **方案**：
  1. 目录浏览限制在配置的根/home，条目上限 + `truncated`；复用路径策略 helper。
  2. SSE 发 `event:error {code,retryMs}`，客户端计数并在 N 次后停止、展示手动重试。
  3. 选择状态改为 confirmed/pending reducer，catching 时回滚；ContextMeter 用 `used: null` 显示 unknown。
  4. 菜单/对话框补 ARIA、焦点恢复、roving tabindex；Playwright 键盘测试。
- **验收**：
  - [ ] `path=/` 或 10k 目录返回 403/截断，不产生巨大 JSON。
  - [ ] 快照持续失败时只发一个有界错误并停止重连。
  - [ ] 模型/策略选择失败后 UI 回到 confirmed 值。
  - [ ] 键盘 E2E：方向键、Escape、焦点恢复通过。

### OPT-030 时间敏感测试与 ACP 前置条件

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`test/qi/test_runner.clj`、`test/qi/jobs_test.clj`、`test/qi/mcp_http_test.clj`、`test/qi/lcu_test.clj`、`docs/acp.md`、`apps/acp/daemon.test.ts`
- **现状**：`test_runner.clj:2300,3344` 断言取消 <1000ms；`jobs_test.clj:290` 断言 <1500ms；`mcp_http_test.clj:92` 用 250ms sleep；`lcu_test.clj:106` 用 350ms sleep；36 处 `Thread/sleep`。两个 Seatbelt 测试整体包在 `(when (= "Mac OS X" ...))` 里（1264、3110），Linux 上记为通过但零断言。`docs/acp.md:30` 让用户跑 `npm run test:acp`，但 `apps/acp/daemon.test.ts:75-76` 要求已构建 `target/debug/qi-agent`，CI 只是碰巧先跑了 `test:web`。
- **问题**：2 核 CI 负载下假红；静默 skip 让 Linux 绿灯虚高；新克隆按文档跑 ACP 会失败。
- **方案**：
  1. 用事件闩锁/顺序断言替代耗时阈值；保留少量 generous ceiling 或按环境缩放；注入时钟。
  2. macOS 测试加 `^:macos` 标签，`bb test` 打印 skipped 数；平台覆盖预期写进 CI。
  3. `test:acp` 自己 `cargo build --locked`，或启动时给出明确前置错误；文档同步。
- **验收**：
  - [ ] 50 次并行负载循环零 flake（记录环境）。
  - [ ] Linux 输出 `skipped: 2`；macOS 执行它们。
  - [ ] 干净克隆 `npm ci && npm run test:acp` 通过或给出可操作错误。

### OPT-031 MCP HTTP/stdio 协议收敛

- **优先级**：P2 ｜ **工作量**：M ｜ **风险**：中 ｜ **证据**：C
- **影响面**：`src/qi/mcp_http.clj`、`src/qi/mcp_stdio.clj`、`src/qi/plugins/mcp_client.clj`
- **现状**：两种 transport 各自实现 discovery/version negotiation、JSON-RPC 校验与 legacy fallback。HTTP 只在 400/404/405 或 `-32601` 时回退，且只校验 jsonrpc/id/envelope（`mcp_http.clj:22-33,170-177`）；stdio 对任何非取消错误都回退，并额外校验 error code/message（`mcp_stdio.clj:97-114,348-358`）。
- **问题**：同一 server 配置因 transport 不同行为不同；HTTP 校验较弱，会接受畸形响应。
- **方案**：抽 `qi.mcp.protocol`（`validate-message!`、`modern-params`、协商与 uncertain 结果策略），HTTP/stdio 只做 framing；共享 contract test。
- **验收**：同一个 fake server 在两种 transport 上通过同一组契约测试；现有 MCP 测试通过。

## 6. 建议执行批次

| 批次 | 条目 | 目标 |
| --- | --- | --- |
| 0 立即 | OPT-001、002、003、023、017（`--locked` 子项） | 止损：数据、密钥、本机维护闭环、可复现性 |
| 1 一周 | OPT-006、005、018、014、009、022 | 小而高收益：丢事件、锁、恢复、原子写、去重、env |
| 2 两到三周 | OPT-011、013、010、007、015、019、020 | 核心边界与验收一致性 |
| 3 结构重构 | OPT-004、012、008、016、021 | 降低变更放大；先有 lint/test 门禁 |
| 4 按需 | OPT-024–031 | 性能、资源、体验、卫生 |

依赖关系：

- OPT-011 依赖 OPT-001 的租约抽象；OPT-014 依赖 `secure-files` 的新 API。
- OPT-004 在 OPT-005 之后做；OPT-008 在 OPT-006 之后做；OPT-019 在 OPT-020 的 checks 语义稳定后做。
- OPT-017 应尽早做，否则后续重构缺少 lint/format 保护。

## 7. 横切验收清单

每个条目合入前至少确认：

- [ ] 受影响范围的单元/集成测试、`npm run typecheck`、`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test --locked` 通过。
- [ ] 跨端改动（Rust/TS/Clojure 投影或协议）有三端契约测试或共享 fixture。
- [ ] 生产构建（`npm run web:build`）通过；涉及 Web/daemon 时补浏览器/E2E（Linux）。
- [ ] 记录 base/candidate SHA、profile、控制器 SHA、验收器 SHA、镜像 digest、命令、退出码、测试数、原始日志。
- [ ] 新增/修改的行为有失败测试（red）在先；纯重构有结构断言。
- [ ] 文档（架构、命令、默认值、安全边界）同步更新。
- [ ] 产物不含 `._*`、临时目录、密钥或本机绝对路径。
- [ ] 涉及 maintenance 的改动：旧控制器仍可验证新证据；候选不能激活自己的规则；未知结果保持 UNKNOWN/NOT_RUN。

## 8. 非目标 / 暂缓

以下不在本轮待办中，除非另立 ADR：

- 重写 Rust TUI 为 Web/Clojure，或反向合并两个 TUI。
- 迁移 session JSONL 到 SQLite，或把 supervisor SQLite 换成别的存储。
- 引入完整 IDL/codegen 覆盖所有内部协议；本轮只做 OPT-004 的 Rust typed method 与 OPT-007 的 Web contract。
- 把 maintenance 的 Docker/容器模型换成别的隔离模型。
- 在本次审计中直接修改维护控制器、验收器规则或发布链；这些必须由独立审查者实施。
- 用扩大超时、重试或放宽断言消除已有失败记录。

## 9. 追踪清单

### 批次 0

- [ ] OPT-001 会话日志跨进程写入租约
- [ ] OPT-002 Web 托管 provider 的密钥端点策略
- [ ] OPT-003 maintenance 付费直连的凭据隔离
- [ ] OPT-023 仓库卫生与文档/脚本单一事实源
- [ ] OPT-017 质量门禁对齐（先做 `--locked`）

### 批次 1

- [ ] OPT-005 Rust 生命周期锁不跨越 RPC
- [ ] OPT-006 Web 快照刷新合并事件游标
- [ ] OPT-009 Responses 适配器去重
- [ ] OPT-014 统一原子写与文件替换
- [ ] OPT-018 maintenance 锁语义与恢复可见性
- [ ] OPT-022 子进程环境变量清洗

### 批次 2

- [ ] OPT-007 Web Host 路由、错误与共享契约
- [ ] OPT-010 provider 传输层重试/取消/超时统一
- [ ] OPT-011 session 存储组件化与锁外通知
- [ ] OPT-013 worker RPC 单一注册表与 schema
- [ ] OPT-015 配置默认值单一来源与未知键校验
- [ ] OPT-019 maintenance 合同与候选暂存单一实现
- [ ] OPT-020 maintenance 证据语义（NOT_RUN/policy/checks）

### 批次 3

- [ ] OPT-004 Rust daemon 分层与协议类型化
- [ ] OPT-008 App.tsx 拆分与流式投影批处理
- [ ] OPT-012 runtime.clj 拆分与预算显式化
- [ ] OPT-016 测试注册表自动发现与 test_runner 拆分
- [ ] OPT-021 跨端事件投影黄金契约

### 批次 4

- [ ] OPT-024 输入校验前移到持久化之前
- [ ] OPT-025 LSP 客户端上限与空闲回收
- [ ] OPT-026 execution world 窗口读取与轮询降频
- [ ] OPT-027 background job 输出缓冲 O(n²)
- [ ] OPT-028 session catalog 增量索引
- [ ] OPT-029 Web 目录边界、SSE 错误通道、乐观状态与 a11y
- [ ] OPT-030 时间敏感测试与 ACP 前置条件
- [ ] OPT-031 MCP HTTP/stdio 协议收敛

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-17 | 初次审计：31 个条目（P0×3、P1×20、P2×8），基线 `0567c1e`。 |

## 11. 本轮候选记录

候选工作区：`optimization-audit/qi-agent`；唯一写入者：Codex /root。原工作区和原始清单保留。
私有证据前缀：`optimization-evidence/20261017/`，包含任务合同、冻结基线指纹、每条命令的
起止时间、退出码与原始输出 SHA-256；候选提交身份另存私有回执，避免自引用。

### OPT-002：已复现并修复，待独立审查

- Web settings 的环境变量引用绑定官方端点/协议；模型发现同样检查，阻止变更地址后发送宿主 key。
- Responses 的 `provider-entry` 与直接 `generate` 共享端点策略；自定义地址必须显式保存 key，
  不会回退读取环境凭据。现有自定义提供方与 ChatGPT 订阅保留。
- 两端拒绝公开权限、其他 owner 与符号链接设置；合法测试 fixture 按真实约定创建 0600 文件。
- red：`OPT-002-red-bb-offline`（2 tests / 9 assertions failed）、`OPT-002-red-node`（2 failed），
  均为行为断言失败，无 skip/零测试。首次 BB red 曾误发一个 dummy-key 请求到 example.com，
  已改为 HTTP stub 后重取离线 red；该原始记录保留，不作为离线 red 使用。
- green：`bb test` 313 tests / 2370 assertions；Web Host 87、Web UI 70、ACP 13、真实离线 E2E 8 tests；
  typecheck、Vite build、生产浏览器回归、Rust fmt/clippy/`cargo test --locked` 均退出 0。
- 第一次 Rust 全套因旧 fixture 写出 0644 的 providers.json 失败；定位后仅把该 fixture 权限改为
  0600，再次全套通过。失败日志 `OPT-002-rust-full.log` 保留，不当作偶发失败删除。
- 平台为本地 macOS；Linux 浏览器/可信镜像验收 NOT_RUN，镜像 digest 未提供；独立安全/测试审查
  NOT_RUN。因此暂列 blocked，未勾选 done，也未接受、合入或激活候选规则。
