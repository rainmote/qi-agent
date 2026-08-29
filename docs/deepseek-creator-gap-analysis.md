# DAO 创造模式与 DeepSeek Harness 对齐分析

更新时间：2026-08-28  
DeepSeek Harness 基线：[`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)（`0.1.2-alpha.1`）

## 结论

DAO 已从“可选择的特殊配置”补成可完成真实交付的创造模式：它继承标准编码能力，能够检查当前运行时，创建、读取、复制、原子更新、校验和删除用户 Agent Preset，也能以不可变版本管理受控的临时插件实验。Creator 现在还可提交 Clojure EDN Blueprint，在当前 Session 动态创建带 Schema 的有状态工具，并热更新或回滚。

它仍不等价于 DeepSeek Harness 的 Dynamic Cordis Plugins。DAO 执行的是能力封闭的 EDN 数据程序，而不是模型提交的任意 Clojure/JavaScript 源码；同时还没有浏览器 Client half、Slot UI、完整 Inspect Provider 类型目录和异步页面审批链。这些差异是明确的安全/产品边界，不应被描述为已经完全对齐。

## 能力矩阵

| 能力 | DeepSeek Harness 创造模式 | DAO 当前状态 | 结论 |
|---|---|---|---|
| 模式发现与新 Session 选择 | `standard`/`cordis` 等 Preset roster | daemon、TUI、Web 共用 Preset roster；按 Preset 创建独立 Agent | 已对齐 |
| 标准能力超集 | `cordis` 复制标准模式全部工具，再增加创造能力 | `creator` 是 `standard` 严格超集 | 已对齐 |
| Session 隔离与恢复 | Preset 按 Session mount；选择持久化 | 每个 Agent 独立 worker/config snapshot；选择持久化，fork 继承 | 已对齐 |
| 系统/用户 Preset 边界 | shipped 只读，用户目录可创作 | `presets/` 只读，`~/.dao/agent-presets` 可写 | 已对齐 |
| Preset 发现、读取、复制、删除 | roster service | `:agent/presets` service + `preset_inspect`/`preset_author` | 已对齐 |
| 用户 Preset 修改 | 复制后通过文件工具修改 composition | `preset_author update` 接受完整 EDN，先校验再原子替换 | 已对齐；DAO 边界更窄 |
| Preset 校验 | shape check + standing mount validation | structural validation；可信宿主可选 boot/dispose mount validation | 已对齐 |
| 创作入口 | 设置页“用创造模式起草” | Web 新会话页提供同类入口并预填创作请求 | 已对齐 |
| 创作指导 | 两个随 Preset 分发的 progressive skills | 随 Creator 分发的 `creating-agent-presets` skill + `preset_guide` | 已对齐 |
| 运行时拓扑检查 | Inspect Providers：Service/Event/Builtin/Tool/Slot/Theme | `runtime_inspect`：plugin/service/tool/command/hook 所有权摘要 | 部分对齐 |
| 临时插件版本 | immutable Package、current/next 指针 | 审核目录或 EDN Blueprint Package 支持 define/inspect/run/update/stop/undefine | 生命周期已对齐 |
| 失败诊断与回滚 | package source、host/client diagnostics、修复后 update | 保存 Blueprint 精确源码和包级错误；失败 update 不推进 current，并尽力恢复上一运行版本 | Host 核心语义已对齐 |
| 动态 Host 行为 | `node:vm` 执行模型提交的 JavaScript；官方明确不是安全边界 | Clojure EDN Blueprint 编译为工具闭包，支持 Schema、词法变量、集合变换、有界 Atom 状态和热替换 | 效果部分对齐，权限更窄 |
| 任意 Host 源码 | JavaScript 可直接使用进程内能力 | 禁止任意 Clojure 源码、symbol/Var、Java interop、文件、网络、线程、eval/load-string | 有意不对齐 |
| 动态 Client UI | Client half、React、Slot、Theme、Host RPC | 无浏览器动态插件运行时 | 未对齐 |
| Client 审批与异步状态 | browser package awaiting-approval/starting/steering | 普通工具审批可用；无 Client package round trip | 未对齐 |
| `@pluginId` 会话引用 | 自动注入精确 package/update 上下文 | 需显式 `runtime_plugin inspect` | 未对齐 |
| 配置 patch/HMR | Cordis loader 支持 ordered patch 与 HMR | Preset 是完整有序 EDN 快照；新 Session 生效 | 未对齐，优先级较低 |

## 本轮补齐

1. 新增随 Creator 分发的 `creating-agent-presets` progressive skill，以及 Creator 专属 `preset_guide`、`preset_inspect` 与 `preset_author`，形成“检查 → 复制 → 更新 → 校验 → 新建 Session”的完整链路。
2. 用户 Preset 更新在发布前完成 EDN 解析、插件依赖检查和 core namespace 限制；配置与元数据使用同目录临时文件原子替换。系统 Preset 始终拒绝修改和删除。
3. Preset 复制允许从健康的系统或用户 Preset 派生，和 DeepSeek Harness 的 authoring service 一致。
4. `runtime_plugin` 保留旧的 activate/deactivate/status，并增加不可变 Package 定义、版本指针、run/update、stop、undefine、精确检查、失败诊断和回滚。
5. Web 新会话页增加“用「创造模式」起草自定义 Agent”入口，自动选择 `creator` 并预填要求先读取创作指南的请求。
6. 补齐 Web Session 初始化失败时的 worker 关闭和 Preset 选择回滚，避免失败的创造会话留下错误 profile。
7. 新增 Clojure EDN Blueprint 编译器：模型可用纯数据 AST 定义最多 8 个动态工具，声明输入/输出 Schema，并使用词法绑定、条件、字符串/数值/集合算子及有界状态；AST、值、集合、字符串和数值均受限。
8. Blueprint 和审核内置插件复用不可变 Package 生命周期。逻辑插件的 Atom 状态跨成功 update 与失败回滚保留；Kernel 单所有者注册阻止动态包覆盖 Host 工具，Session dispose 会回收工具和状态。
9. 新增 `creating-runtime-blueprints` progressive skill，提供完整 source shape、操作符目录和 define/run/test/update/stop/undefine 工作流。

## 后续优先级

### P1：继续补强，但不扩大代码执行权限

- 为 `runtime_inspect` 增加只读、带 schema 的 Inspect Provider 目录，先覆盖 Service、Event 和 Tool 的精确契约。
- 在 Web 设置中补用户 Preset 的复制、校验和删除列表；写 composition 仍交给 Creator Agent。
- 为 Blueprint 增加事件观察器和声明式 UI manifest；仍通过能力代理，不开放宿主对象。
- 增加更多经过审计、配置固定的 runtime experiment，并做并发/失败恢复测试。

### P2：需要单独安全设计后再决定

- 模型提交的通用 Clojure/JavaScript Host 源码执行。
- 浏览器 Client half、Slot/Theme UI、Host/Client 私有 RPC 与异步审批。
- `@pluginId` 引用注入和动态插件卡片。

P2 等价于给创造模式接近 shell 的通用代码权限。当前 Blueprint 已覆盖动态工具的主要产品效果，不需要也不会在主 worker 中加入 `eval` 或 `load-string`。若未来确需通用源码，至少需要独立进程/容器、能力代理、资源限额、审批、可取消协议和完整审计。
