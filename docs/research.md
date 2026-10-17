# LLM Agent Harness 调研与 Babashka 插件化实践

调研时间：2026-08-15。源码基线：Pi `086c32e74530564922d011ade23ff582c9d63116`；DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`。

DeepSeek Harness 当前明确标记为 Developer Preview，并警告会发生兼容性破坏；本文应视为带时间戳的架构快照，不是稳定 API 承诺。

## 一、结论先行

Pi 和 DeepSeek Harness 代表两个互补方向：

- Pi 把 agent 的必要运行时压缩到很小：统一模型接口、消息状态、一个可观察的工具调用循环；产品能力通过 TypeScript extension、skill、prompt、theme 和 package 叠加。
- DeepSeek Harness 把可替换边界推到更深：模型 adapter、tool registry、session log、agent loop 都是 Cordis plugin；配置负责组合插件树，effect 负责卸载回滚。

适合 Babashka/Clojure 的落点不是复制 TypeScript 类层级，而是利用 data + function + atom：用 EDN 描述 profile，用 map 描述插件和工具，用函数作为 service，用 atom 保存注册表，用 disposer 实现可逆 effect，用高阶函数实现 waterfall middleware。

## 二、Pi Agent 实现

### 2.1 分层

Pi 仓库主要分三层：`pi-ai` 统一不同模型供应商，`pi-agent-core` 管理 tool calling 与状态，`pi-coding-agent` 提供会话、CLI/TUI、extension 和具体工具。官方仓库也明确说明它本身不提供文件、进程、网络和凭据权限隔离，强边界需要容器或沙箱。

### 2.2 Agent loop

核心 loop 的结构值得保留：

1. outer loop 在 agent 原本准备结束时接收 follow-up；inner loop 在存在 tool call 或 steering message 时继续。
2. `AgentMessage[]` 到供应商 `Message[]` 的转换只发生在 LLM 调用边界；UI-only 或扩展消息可以在这里过滤。
3. 流式响应通过 `message_start/update/end` 事件公开，状态中先放 partial message，再原位替换成 final message。
4. 工具调用先查找、准备和校验参数，再经过 `beforeToolCall`、执行和 `afterToolCall`。
5. 默认可并行执行同一 assistant message 中的工具，但 preflight 保持顺序，最终 tool-result message 仍按模型原始调用顺序写回。
6. 若模型因 token limit 截断了 tool arguments，所有相关调用直接失败，不冒险执行“恰好能解析”的不完整参数。

这套设计的关键不在循环代码本身，而在边界：消息转换、上下文压缩、动态凭据、steering/follow-up、工具前后钩子都是显式注入点。

### 2.3 Extension 与 Skill

Pi extension 是接收 `ExtensionAPI` 的 TypeScript factory。它可以注册工具、命令、provider、renderer，订阅或拦截 lifecycle/tool/model/session 事件；项目级扩展只有在项目被信任后才加载。工具可以在运行中动态添加，`/reload` 可热重载自动发现的 extension。

Pi skill 使用 progressive disclosure：启动时只把 skill 名称和描述放进系统提示，完整 `SKILL.md` 在任务匹配时再读取。这个机制适合大量能力目录，因为不会把每个能力的完整说明永久塞入上下文。

## 三、DeepSeek Harness 实现

### 3.1 Everything is a Plugin

DeepSeek Harness 基于 Cordis。共享 Context 承载 service、typed event 和 reversible effect。官方架构文档强调：没有需要打补丁的特权核心；model adapter、tool registry、session log 和 agent loop 都可从配置替换。插件卸载时，其注册 effect 自动反向撤销。

运行实例由有序插件树组成。Profile 声明 bundle，bundle 提供 Cordis 配置行；上层 `cordis.patch.yml` 或命令行 overlay 可以按 id 整行替换或插入。这使“发行默认值”和“用户组合”分离。

### 3.2 Service、Event 与 Scope

Harness 把扩展点分成三类：

- durable session event：必须在 reload、fork、replay 后仍然存在的事实；
- live agent event：只在运行中拦截 inbox、step、request、validation 和 stopping；
- capability event：在 fs、tools、telemetry 等 seam 上挂策略或 adapter，避免依赖 agent loop。

每个 agent 还可以拥有 scoped context。于是同一个进程中不同 agent 可以暴露不同工具集、系统提示或后端，而不用 fork 全局注册表。

### 3.3 Turn、Step 与 Session Log

DeepSeek 将一次 model request 及其工具调用称为 step，一个 turn 可以包含零到多个 step。`turn/*`、`step/*`、user/assistant/tool 事件写入 session log；`deriveMessages()` 从日志投影模型历史。其强约束是：模型可见的内容必须能从日志重建。

由此，resume、fork、transcript、telemetry 和 UI replay 都依赖同一事件流，避免“内存 context 一份、持久化 session 另一份”的双写漂移。

### 3.4 Tool pipeline

工具不是一个随意返回字符串的 callback，而是一条受控管线：

1. schema 进入 prompt；模型 arguments 在执行前校验并冻结；execution identity 与 token 不可变。
2. `tools/pre-execute` 是可重排策略 waterfall，可 allow、deny 或 ask。
3. `tools/execute` 适合 deadline、retry、metrics 这类 around wrapper。
4. `tools/post-execute` 可以显式转换结果；`tools/result` 只观察最终不可变 outcome。
5. 工具主体返回一个符合 output schema 的 canonical JSON value；单独的 renderer 再生成模型 content 和 UI presentation。
6. 注册是 effect，插件 fiber 销毁时工具自动注销；热替换通过“销毁旧 effect + 注册新定义”，而不是原地修改 callback。

这比只验证输入多了一层重要保证：成功结果也是机器可验证的数据，跨工具编排不必解析自然语言。

### 3.5 Capability seam

一个完整 seam 至少包含 Service Definition、Provider 和 Consumer。比如 filesystem 与 subprocess provider 共享执行世界；换成远程 sandbox provider 后，Bash、PTY、LSP 可以整体迁移，不需要各工具分叉实现。LLM adapter 也通过统一 `LlmAdapter` 注册，provider-specific 传输、SSE 和 replay state 封装在 adapter 内。

## 四、对比

| 维度 | Pi | DeepSeek Harness | Babashka 实践 |
|---|---|---|---|
| 核心边界 | 小型 agent runtime，coding agent 在上层扩展 | 微内核式插件树，loop 也是插件 | kernel 只持有 registry/event/effect |
| 组合方式 | 自动发现路径、settings、package、CLI extension | profile + bundle + ordered patch | `agent.edn` 有序 namespace profile |
| 生命周期 | extension factory、session/reload 事件 | Cordis fiber + reversible effect | 每次注册返回 disposer，逆序卸载 |
| 消息状态 | AgentMessage 与 LLM Message 边界转换 | append-only session event 投影 message | session 插件为 message source of truth |
| 工具策略 | before/after tool hooks，可串行或并行 | pre/execute/post/result 分层 waterfall | 三段 waterfall，policy 独立插件 |
| 工具结果 | content/details | canonical JSON + render/presentation | canonical value + output schema + render |
| 能力加载 | extension + skill progressive disclosure | scoped tool restrict/skill inject | 当前为 profile 静态加载；可继续加 catalog |
| 稳定性 | 成熟但仍演进 | Developer Preview、API 快速变化 | 自有小契约，adapter 隔离上游变化 |

## 五、可复用的插件化实践

### 5.1 微内核只保留机制

核心应该只知道“如何注册、查找、排序、调用和撤销”，不应该知道 DeepSeek、文件工具、会话格式或某种 agent policy。否则所谓插件只是被大核心调用的 callback，无法替换核心行为。

### 5.2 注册必须可逆

`register-service!`、`register-tool!`、`on!` 和 `intercept!` 都产生 disposer，并绑定到插件 id。卸载按逆序执行，既适用于热重载，也能避免测试之间的全局污染。

### 5.3 显式声明依赖与产出

插件 descriptor 的 `:requires` 在 start 前校验，`:provides` 在 start 后校验。失败时立即回滚该插件已注册的 effect，启动过程保持 fail-fast 和近似事务性。

### 5.4 Durable fact 与 live hook 分离

用户消息、assistant message、tool result 属于 durable fact；请求改写、权限判断、metrics wrapper 属于 live hook。不要把 transient hook 结果偷偷塞进模型 context，也不要让必须 replay 的事实只存在内存 atom。

### 5.5 Tool schema 是双向契约

输入 schema 防止模型幻觉参数直接进入执行层；output schema 防止插件悄悄改变返回结构。canonical JSON 与 renderer 分离后，模型文本、UI 卡片、审计数据可以从同一值投影。

### 5.6 Policy 走管线，不写进工具

工具负责能力本身；是否允许、是否审批、如何超时、如何审计由独立 hook/plugin 负责。这样本地与远程 provider、交互与批处理模式可以共享工具定义而采用不同策略。

### 5.7 配置组合优于运行时条件分支

用不同 EDN profile 选择默认 OpenAI 公共 API、实验性 Codex/ChatGPT 订阅、DeepSeek 或 mock，以及只读/完整
工具、console/OTel telemetry。避免在 loop 中堆积 `if benchmark`、`if web`、
`if plan-mode`。

### 5.8 外部代码默认不可信

Pi 和当前 Babashka 实现中的插件都与主进程同权限。项目级插件需要 trust gate；生产环境还应把 filesystem、subprocess 和 network 下沉到受限 provider 或容器，而不是仅依赖 system prompt。

## 六、本仓库如何映射这些结论

- `qi.kernel`：service/tool/listener registry、waterfall、effect 和卸载；不含 LLM 或 agent loop。
- `qi.plugin`：读取 EDN，动态 require namespace，检查 requires/provides，失败回滚。
- `qi.plugins.session`：append-only event store，并从 `message` event 推导模型 history。
- session store 会跳过并诊断损坏 JSONL 行；clear、compaction 都是 append-only
  checkpoint；fork 原子创建新文件并生成独立 session id。
- `qi.plugins.openai`：隔离 OpenAI-compatible/DeepSeek HTTP 协议。
- `qi.plugins.openai-responses`：默认生产 adapter；限制 API key 只发往 OpenAI 公共
  Responses endpoint，并保留/replay 完整 output items。
- `qi.plugins.chatgpt`：隔离 ChatGPT 订阅的 Responses/SSE 协议；每次请求
  重读 Codex auth cache，只把 access token 放进 Authorization header，并保留、
  replay 完整 response output items 以维持 reasoning/tool-call 连续性。传输默认使用
  HTTP/1.1；TLS/连接错误会轮换 HTTP client 并指数退避，且不会与 runtime 形成乘法重试。
- 根目录 `agent.edn` 默认选择 `qi.plugins.openai-responses`；实验性 ChatGPT 订阅 adapter
  仍可通过 `/model` 或 `examples/chatgpt.edn` 使用，DeepSeek adapter 保留在
  `examples/deepseek.edn`。模型切换只替换 provider/profile，不修改 kernel 或 loop。
- `qi.plugins.runtime`：有 step 上限的默认 tool-calling loop；本身通过 `:agent/run` service 可替换。
- `qi.cancellation` 与 `qi.streaming`：所有 adapter 共享取消 token 和 SSE framing；
  `:llm/stream` 对外发布统一 start/delta/completed/error live event。
- `qi.plugins.bb-repl`：提供 `:execution/repl` capability，管理持久化 Babashka
  子进程、单行 EDN request/response、输出边界和超时重启。
- `qi.plugins.clojure-repl`：消费执行 capability 并注册模型可见的 `bb_repl`
  工具；因此未来切换容器或远程执行只需要替换 provider。
- `qi.plugins.policy`：在 `:tool/pre-execute` waterfall 拒绝工具，不修改 loop。
- `qi.plugins.trust` 与 `qi.plugins.approval`：把 project trust、allow/deny/ask
  决策和 durable audit 从工具实现中分离。
- `plugins/example/math.clj`：位于独立 classpath 根下的外置工具插件。
- `qi.plugins.mock`：离线 deterministic adapter，使整个 harness 不依赖真实 API 即可端到端测试。

## 七、已完成基线与下一步

按 Pi 当前官方版本重新核对后的完整能力矩阵、P0/P1/P2 优先级和验收标准，见
[qì agent 与 Pi 当前能力差距](pi-gap-analysis.md)。

本轮已经补齐此前最关键的三个缺口：

- Codex Responses 与 DeepSeek Chat Completions 都做增量 SSE 消费，并发布统一
  `:llm/stream` 事件；取消 token 会关闭 transport，runtime 提供 `:agent/cancel`。
- `bb_repl` 在 macOS 默认进入无网络、工作区只读的 Seatbelt sandbox；trust、
  allow/deny/ask approval 和 durable audit 由独立插件组合。
- session 支持损坏行恢复、resume、独立 id fork、append-only clear 与 compaction。

它仍是小型 harness，接下来最值得做的是：

- 工具并行执行，同时保持“并行完成、模型原始顺序写回”的确定性。
- 扩大 JSON-Schema 覆盖并增加 provider/tool conformance test kit。
- 将 profile 内的 trust assertion 升级为用户目录中的 trusted-root store，并给 Linux
  接容器/远程 sandbox；同进程第三方插件仍拥有主进程权限。
- 用可插拔 LLM summarizer 改善 compaction，并增加 snapshot/index，避免超大 JSONL
  每次从头扫描。
- 最后再增加热重载、MCP、scoped child context 和 subagent；这些是能力扩展，不应
  先于可中断、可审计和权限边界。

## 八、主要来源

- [Pi 官方仓库](https://github.com/earendil-works/pi)
- [Pi Extension 文档](https://pi.dev/docs/latest/extensions)
- [Pi Skill 文档](https://pi.dev/docs/latest/skills)
- [Pi agent loop 源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/qi-loop.ts)
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness extension cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
- [DeepSeek Harness tool authoring](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [DeepSeek Harness LLM adapter guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md)
- [Cordis 官方仓库](https://github.com/cordiverse/cordis)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Responses streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses)
