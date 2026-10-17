# qì agent 与 Pi 当前能力差距

调研时间：2026-08-15。实施复核：2026-08-16。

对比基线：Pi 官方 `main` 分支 `086c32e74530564922d011ade23ff582c9d63116`，以及
`pi.dev/docs/latest`；qì agent 使用本仓库当前工作区。本文比较的是“能否作为日常 coding
agent 使用”，不是比较语言、代码量或 UI 外观。

## 实施后的结论

本文件最初列出的四项 P0 已完成：AgentSession 控制面、ExecutionWorld 与完整 coding
工具、自动上下文预算/语义压缩/恢复重试、确定性的工具批并行。对应契约由本仓库测试覆盖，
包括阻塞 provider 的 steer/follow-up/abort、并行耗时与稳定结果顺序、路径/符号链接逃逸、
Seatbelt 外部文件隔离、自动压缩和 overflow 单次恢复。

P1 产品闭环也已补上主要路径：session tree/catalog、用户/项目 resource catalog、
AGENTS/SYSTEM/prompt/skill 渐进加载、运行时 provider/model registry、动态 auth resolver、
版本化 JSON event、stdin/stdout RPC、公开 Clojure API，以及插件化全屏 TUI。当前剩余差距
集中在：

1. **包生态与完整热重载**：resource catalog 可原子 reload context/prompt/skill；尚无
   git/local package installer，也没有重建整棵 plugin fiber 后原子切换。
2. **凭据产品体验**：auth store 每请求动态解析 Codex cache/环境 key，provider 可运行时
   切换；仍没有 `/login`、`/logout` 和内建 OAuth refresh UI。
3. **P2 完整度**：已有 JSON Schema composition/约束和 typed text/image 输入，但缺图片
   选择/渲染 UI、费用 analytics、跨平台容器 provider 等生态能力。

因此，当前已从“演示型 harness”跨到可持续完成真实代码任务的 coding-agent runtime；
与 Pi 的主要差别已转为终端产品体验和包生态，而不是 agent 执行能力。

## 实现与验证证据

| 能力面 | 主要实现 | 自动验证 |
|---|---|---|
| 可控运行、队列、abort、partial state、并行批 | `runtime.clj`、`cancellation.clj` | 阻塞 provider、队列顺序、结束竞态、abort、并行耗时与稳定排序 |
| 文件/进程世界与安全 | `execution_world.clj`、`tools.clj`、`trust.clj`、`approval.clj` | traversal、symlink、Seatbelt、目标解析、工具契约 |
| 上下文与 session | `context_manager.clj`、`session.clj`、`session_catalog.clj` | 自动语义压缩、overflow 恢复、append-only tree/checkout/catalog |
| 资源、模型与凭据 | `resources.clj`、`model_registry.clj`、`auth_store.clj` | trust gate、渐进 skill、原子 catalog reload、运行时 provider selection |
| 外部接口与多模态 | `api.clj`、`protocol.clj`、两个 LLM adapter | version 1 JSON、RPC、typed text/image 请求转换 |
| TUI 与 UI extension | `tui.clj`、`ui.clj`、`command.clj` | 全屏/主屏、流式 transcript、多行编辑、selector、可逆 renderer/widget/shortcut |

实施复核运行了 37 个测试、284 条断言，均通过；此外验证了默认 profile inventory、离线
tool-call loop、JSON mode、RPC ready/state/shutdown 和真实 PTY 下的 TUI 启动、提交、流式
结果与退出恢复。macOS Seatbelt 用例在非 macOS 环境会条件跳过。

## 已经对齐或有自身优势的部分

- 微内核只保留 service/tool/event/effect，agent loop 和 LLM adapter 都可替换。
- 插件 effect 可逆、失败会回滚；这比只提供 callback 的扩展结构更接近真正的插件系统。
- Codex profile 默认复用 `~/.codex/auth.json`，同时保留 DeepSeek/OpenAI-compatible
  profile；Responses output item 会完整 replay。
- Codex 与 DeepSeek 都增量消费 SSE，并发布 provider-neutral `:llm/stream` 事件。
- 工具调用有输入 schema、canonical output、输出 schema、独立 renderer，以及
  `pre/execute/post` waterfall。
- session 是模型上下文的事实来源，支持损坏 JSONL 行恢复、resume、独立文件 fork、
  append-only clear/compaction。
- `bb_repl` 是独立执行 provider；macOS 默认通过 Seatbelt 禁网、限制读取并只开放专用
  写目录。Pi 的 project trust 也明确不是 sandbox，因此这一点不是 qì agent 的落后项。
- 工具调用过程已经由 trace 插件写到 stderr；`--once` 会显示过程，且最终流式文本不会
  重复打印。

## 能力矩阵

状态含义：`已具备` 表示主路径可用；`部分` 表示已有底层机制但缺产品闭环；`缺失`
表示当前没有对应能力；`不同` 表示设计不同且不需要机械照搬。

| 能力 | Pi 当前能力 | qì agent 当前状态 | 差距与优先级 |
|---|---|---|---|
| 可替换核心 | 统一模型层、agent loop、coding-agent 上层 | service/tool/hook/effect 微内核，loop 也是插件 | 已具备 |
| 流式生命周期 | message/turn/tool start、update、end，partial assistant state | 统一 state/message/turn/tool/queue live event；state 累积 partial text/reasoning，session 只落 final | 已具备 |
| Abort | UI、SDK、RPC 都能中止模型、重试和压缩 | TUI、line fallback、API、JSON/RPC 可 abort；关闭 SSE/进程/退避并持久化 aborted event | 已具备主路径 |
| Steering / follow-up | 运行中插话；立即进入下一轮或等 agent 自然结束后继续 | AgentSession 双队列按定义在工具批后或自然停止时注入 | 已具备 |
| 工具批并行 | 默认并行，可由全局或工具声明强制串行；结果按原调用顺序写回 | preflight 顺序、只读主体并行、sequential 整批降级、结果稳定排序 | 已具备 |
| 截断工具参数保护 | output token 截断时整批工具失败 | 已实现 `finish-reason=length` 整批失败 | 已具备 |
| Coding 工具 | `read/write/edit/bash/grep/find/ls`，另有 `!`/`!!` shell | ExecutionWorld-backed `read/write/edit/bash/grep/find/ls`，保留 bb_repl | 已具备 |
| 执行世界 | 文件和进程 operation 可替换为 SSH、容器等远程实现 | 统一 fs/process capability；本地 Seatbelt provider 可由同契约 mock/远程实现替换 | 已具备 seam；仓库尚未附 SSH/container provider |
| 工具实时更新 | bash 等工具可持续更新 UI，长输出截断并保留完整结果路径 | `tool.execution/update` 实时 chunk；截断结果含完整日志路径 | 已具备 |
| Schema | TypeBox/JSON Schema 工具参数 | 输入/输出校验含 oneOf/anyOf/allOf、nullable、format 与常见约束 | 已具备主要子集 |
| Session 持久化 | JSONL、恢复、列表、删除、迁移 | JSONL、恢复、诊断、clear、fork、compact | 已具备基础 |
| Session 树 | 同一文件以 `id/parentId` 分支，`/tree` 导航、label/name、分支摘要 | entry parent、active leaf、label/name、checkout、fork 与 session catalog | 已具备基础；大日志 snapshot/index 待优化 |
| 自动压缩 | 根据 context window/reserve tokens 自动语义摘要；手工指令；分支摘要 | 自动预算、语义 summary、append-only checkpoint、确定性 fallback | 已具备 |
| 自动重试 | 可取消的模型错误重试；context overflow 会压缩后重试 | runtime transient retry 可取消；overflow 压缩后只重试一次 | 已具备 |
| Provider / model catalog | 多订阅 OAuth、多 API/cloud provider、本地模型、动态 catalog | 多 adapter registry、metadata、运行时 selection；Codex/compatible/mock 可注册 | 已具备基础 |
| 登录与凭据生命周期 | `/login`、`/logout`、OAuth refresh、auth store、动态 key | 动态 auth resolver；Codex cache/环境 key 每请求解析，无内建 login UI | 部分 |
| 运行时模型控制 | `/model`、provider/model 切换、thinking level、费用和 token 信息 | `/model`、`--provider`、RPC select；metadata 含 context/thinking/modalities | 已具备选择；费用展示待补 |
| Extension API | 工具、provider、命令、flag、快捷键、renderer、UI、全生命周期事件 | reversible tool/service/command/observer/interceptor/provider/UI registry | 主要能力已具备；CLI flag registry 待补 |
| 资源发现与 reload | user/project 自动发现，trust 后加载，`/reload` 刷新全部资源 | trust 后发现用户/项目资源并原子 reload catalog | 部分；整棵 plugin fiber reload 待补 |
| Skill / prompt / context | Agent Skills progressive disclosure、prompt template、AGENTS.md、SYSTEM.md | YAML metadata、`skill://` 资源、slash command、筛选/去重、子 Agent 继承及 AGENTS/SYSTEM/prompt | 已具备主路径；多生态 provider 待补 |
| 包管理 | npm/git/local package，过滤、启停、更新、项目级安装 | 依赖 Babashka classpath 和手工 profile | 缺失，P2 |
| TUI | 多行编辑器、快捷键、命令、主题、工具 renderer、session/model selector | JLine 全屏插件；流式 Markdown、工具折叠、补全、审批 overlay、selector、主题及 UI registry | 已具备主路径；图片与费用 UI 待补 |
| Headless / SDK | print、JSON event stream、stdin/stdout RPC、TypeScript SDK | version 1 JSONL、stdin/stdout RPC、公开 `qi.api` | 已具备（Clojure API，无 TS SDK） |
| 多模态 | typed text/image/thinking/tool content，RPC/SDK 可传图片 | typed text/image user blocks，adapter 转换；reasoning/tool 仍保留 provider state | 部分；无终端图片选择/展示 |
| Project trust | 用户目录 trust store、父目录继承、临时 override、项目资源加载 gate | 用户 trust.edn、canonical nearest-parent inheritance、加载前 gate | 已具备 |
| Sandbox | 官方明确 trust 不是 sandbox，可通过容器/远程 operation 隔离 | macOS bash 与 bb_repl 默认 Seatbelt；其他 OS `:auto` 安全降级为文件工具，显式 `:none` 才开放进程 | 不同且更保守；容器 provider 待补 |

## P0：已实现的 coding-agent 硬门槛

### 1. AgentSession 控制面（已实现）

原实现只有同步 `:agent/run`；现在同步入口仍向后兼容，同时增加了可并发控制的
`:agent/session`，CLI 不再因等待 `run` 返回而停止读取输入。

已增加 `:agent/session` service，把一次运行变为可观察的状态机：

```clojure
{:submit!    (fn [message options] ...)
 :steer!     (fn [message] ...)
 :follow-up! (fn [message] ...)
 :abort!     (fn [] ...)
 :state      (fn [] {:phase :idle|:model|:tool|:retry|:compacting ...})
 :subscribe! (fn [listener] disposer)}
```

实现要点：

- 模型循环在 worker/future 中运行，终端输入和输出渲染继续工作。
- steering 在当前工具批结束、下次模型请求前注入；follow-up 在 agent 原本准备停止时注入。
- abort 关闭 SSE、传给工具执行、终止 retry/compaction，并持久化明确的 aborted event。
- 统一发布 `agent.turn/*`、`agent.message/*`、`tool.execution/*`、`queue/*`，TUI、
  JSON 和 RPC 只做投影，不各自发明状态。

验证结果：阻塞 mock provider 下，steer 和 follow-up 按定义顺序进入上下文；API abort
在一秒内释放 worker，并且只持久化 aborted event、不产生半条 final message。自然结束时的
队列 admission 与最终 drain 位于同一临界区，不会把竞态 follow-up 遗留给下一次运行。

### 2. ExecutionWorld 与完整 coding 工具组（已实现）

`write/edit/bash` 不直接访问主机；文件和进程统一 capability 为：

```clojure
{:read!   ...
 :write!  ...
 :edit!   ...
 :list!   ...
 :search! ...
 :spawn!  ...
 :capabilities #{:fs/read :fs/write :process}}
```

薄工具插件据此注册 `read/write/edit/bash/grep/find/ls`。`bb_repl` 保持独立的
`:execution/repl` provider，因为它是有状态解释器而不是一次性进程 operation。本地
Seatbelt、容器、SSH 或远程 daemon 可以替换 ExecutionWorld provider；process operation
接收 cancellation、deadline、cwd、输出上限和 `on-update`，工具层不形成第二套进程管理。

在开启写和 shell 前同时完成：

- 用户控制的 `~/.qi-agent/trust.edn`，按 canonical root 保存决定，并支持父目录继承；
- 项目 profile/插件只在 trust 后加载，不能由项目自己的 `agent.edn` 自证可信；
- approval rule 支持按工具、路径、命令模式和当前 session 临时放行；
- 审批前显示最终解析后的 cwd、路径、命令和目标 provider。

验证结果：契约测试覆盖本地与 Seatbelt provider；路径穿越、符号链接逃逸、外部读取、
超时和取消均 fail closed；tool result 明确区分 `is-error`，长输出返回截断状态和完整日志
位置。ExecutionWorld 接口已经允许后续无须改工具即可接入容器或 SSH provider。

### 3. 自动上下文预算、语义压缩与恢复重试（已实现）

已新增 `:context/manager`：

```clojure
{:estimate!         (fn [model messages] ...)
 :needs-compaction? (fn [model messages reserve] ...)
 :compact!          (fn [options] ...)
 :prepare!          (fn [request] ...)}
```

压缩器使用当前 LLM 生成结构化 summary，并保留确定性 fallback。
summary 至少记录目标、已完成工作、决策、未完成项、读写过的文件和最近关键工具结果。
压缩结果仍作为 append-only checkpoint 写入，不重写旧日志。

HTTP 连接级 retry 留在 adapter；rate limit、临时 provider error、context overflow 和
compaction 后 retry 由 session/runtime 编排。所有退避等待均可取消，并发布 retry event。

验证结果：小 context-window mock 会自动触发语义压缩并继续完成任务；overflow 压缩后只
重试一次；摘要失败不改写旧 session，并回退到有界确定性摘要。

### 4. 确定性的工具批并行（已实现）

Pi 当前规则值得直接复用：preflight 按模型顺序完成；只要某个工具声明
`:execution-mode :sequential`，整批顺序执行；否则主体并行；最终 tool-result message 始终
按原 tool-call 顺序落盘和回传。实时 update 可以按实际到达顺序发布。

实现不是简单 `pmap`：批次共享 cancellation，每调用有独立 execution id，持久化在并行
主体完成后按原顺序进行，并保留“所有结果均为 terminating 才提前停止”的批语义。

验证结果：不同延迟的只读工具并行完成，但 session 与下一次 LLM request 的结果顺序稳定；
包含 write/bash 或显式 sequential 工具时整批串行；所有 preflight 在任何主体启动前按
模型顺序完成。

## P1：已形成主路径、仍有体验优化的产品闭环

### 5. Session tree 与 catalog（基础已实现）

现已同时支持独立 JSONL fork 与文件内 entry `parent-id` 分支，store 暴露活动 leaf、
label/name、tree 和 checkout；checkout 可直接重放祖先链或写入 branch summary。session
catalog 以 no-follow 目录遍历索引 id、父 session、名称、标签、消息数和更新时间。

剩余优化是为超大日志增加增量 snapshot/index；这不影响当前 append-only 事实模型和基础
树导航。

### 6. Resource catalog（资源路径已实现）

独立 `:resources/catalog` 插件已经统一发现：

- `~/.qi-agent/`、`~/.agents/skills/` 用户级与 `.qi-agent/` 项目级资源；
- `AGENTS.md`、`SYSTEM.md`、prompt template；
- `SKILL.md`，启动时只注入 metadata，命中后通过 `skill://` 读取全文和同目录资源；
- 资源来源、scope 和 trust 状态。

catalog reload 会先扫描并验证完整新快照，再原子切换 context/prompt/skill。项目外置 plugin
namespace 在 boot 前由用户 trust gate 拦截，项目配置不能自证可信。尚未实现的是加载新
plugin namespace 后重建整棵 fiber/context 并逆序 dispose 旧 effects；所以这里仍是“资源
路径已实现”，不是“完整插件热重载”。

### 7. Provider 与 model registry（已实现基础）

单一 `:llm/generate` 已拆成 `:llm/registry` 与选择器，多个 adapter 可同时注册 provider、
model metadata、context window、thinking levels 和 input modalities。认证已拆成动态
`:auth/store` resolver；现有 Codex auth reader 和 OpenAI-compatible 环境 key 都在每次请求
时解析，避免把 secret 或 refresh token 留在 plugin state。

profile、CLI `/model`/`--provider` 和 RPC 已能切换及查看状态。完整 OAuth 登录 UI 与费用
metadata 仍未实现。Codex 订阅 adapter 继续标记 experimental，因为它复用的是登录缓存和
订阅传输，不是稳定公开 API。

### 8. 稳定的 JSON event 与 RPC 模式（已实现 version 1）

AgentSession 事件已通过三种稳定外部入口投影：

- `--mode json`：stdout 只输出版本化 JSONL event，日志走 stderr；
- `--mode rpc`：stdin 接收 prompt/steer/follow-up/abort/state/session catalog/model catalog
  等命令；
- Clojure API：公开 boot、session、subscribe、dispose，避免调用私有 namespace。

stdout JSON 始终带 `version: 1`，日志走 stderr；RPC 支持 prompt、steer、follow-up、abort、
state、clear、compact、sessions、providers、select-provider、reload 和 shutdown。桌面端、
IDE 和测试 runner 可复用同一协议。

### 9. TUI 与可扩展 UI（已实现主路径）

`qi.plugins.tui` 作为 frontend host 插件建立在 AgentSession 之上，采用 Charm/Bubble Tea
式 Model/Update/View，但终端后端直接复用 Babashka 内置 JLine，保持单二进制启动。它支持
partial assistant、tool update/end、scroll、多行编辑、历史、命令/路径补全、工具与 reasoning
折叠、Markdown、主题、主/备用屏，以及 model/session/tree/theme selector。session catalog
选择会销毁当前 context 并用所选日志重新 boot；运行中的普通 Enter、Alt+Enter、Ctrl+S
与 Esc 分别映射 steer、follow-up、steer 别名与 abort。

`qi.ui` 暴露可逆 message/entry/tool renderer、shortcut、status、widget 与 notification；
`:ui/prompt` 提供 select/confirm/input/custom overlay，approval 在 TUI 中复用同一服务。工具
`:render-model` 与 `:render-tui` 分离，旧 `:render` 保持模型文本兼容。详见 `docs/tui-ratatui.md`。

## P2：生态与兼容性

- 包管理：先支持本地目录和 git 固定 revision，再决定是否需要复制 Pi 的 npm 生态；
  Clojure 世界更适合 git/deps、bb.edn 或自有 manifest。
- JSON Schema composition 与常见约束已经补齐；后续只需扩大 provider/tool conformance
  fixture 覆盖面。
- 用户消息已兼容字符串与 typed text/image content block；后续补终端图片选择、渲染和
  更完整的 reasoning/audio block。
- 更丰富的 model usage、费用、cache、reasoning 展示与 session analytics。
- Windows/Linux 的容器或远程 execution provider；不要把 `:sandbox :none` 设为跨平台默认。
- sub-agent、MCP 等可由插件实现，但它们不是 Pi 核心 parity 的前置条件。Pi 本身也把
  sub-agent 示例放在 SDK/extension 用例中，MCP 可通过第三方 extension 接入。

## 推荐实施顺序

```text
[完成] AgentSession 控制面
  -> [完成] ExecutionWorld + trust/approval store + coding tools
  -> [完成] context manager + semantic compaction + retry
  -> [完成] deterministic parallel tool batches
  -> [基础完成] session tree/catalog
  -> [资源完成] resource catalog + skills/context/reload
  -> [基础完成] provider/model registry
  -> [完成] JSON/RPC + Clojure API
  -> [完成] 插件化 TUI 与 UI extension registry
  -> [下一阶段] 包生态、登录 UI 与生态 provider
```

前四项完成后，qì agent 才能从“演示型 harness”跨到“能持续完成真实代码任务的 agent”；
后续项目则主要提升可发现性、交互体验和生态规模。

## 不建议机械照搬 Pi 的部分

- 不必复制 TypeScript 类层级；继续用 EDN、map、函数、atom 和 disposer 表达插件契约。
- 不必一开始建设公网 package gallery；先把本地/项目资源发现、trust、固定版本和 reload
  做可靠。
- 不要把 project trust 当执行沙箱。trust 决定是否加载项目代码，ExecutionWorld 决定
  能访问什么，两者必须保持独立。
- 不要为了功能数量提前加入 sub-agent。没有可中断运行、上下文预算和可靠执行世界时，
  多 agent 只会放大资源与权限问题。

## 官方来源

- [Pi 官方仓库](https://github.com/earendil-works/pi)
- [Pi agent loop 源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/qi-loop.ts)
- [Pi 使用与 session 命令](https://pi.dev/docs/latest/usage)
- [Pi session 格式](https://pi.dev/docs/latest/session-format)
- [Pi compaction 与 branch summarization](https://pi.dev/docs/latest/compaction)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi skills](https://pi.dev/docs/latest/skills)
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi providers](https://pi.dev/docs/latest/providers)
- [Pi custom models](https://pi.dev/docs/latest/models)
- [Pi project trust 与安全边界](https://pi.dev/docs/latest/security)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi RPC mode](https://pi.dev/docs/latest/rpc)
- [Pi JSON event stream mode](https://pi.dev/docs/latest/json)
