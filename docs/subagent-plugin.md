# Subagent 插件

本实现参考 DeepSeek Harness 的
[Subagent 能力族](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.zh.md)
与其子系统约定，把 subagent 保持为默认 agent loop 之外的可选能力，而不是写进内核。

## 为什么采用这套边界

DeepSeek Harness 方案的主要优势不是“多开几个模型请求”，而是把几个容易耦合的职责拆开：

- registry 只维护具名 provider、静态能力与任务生命周期；同一进程可并存 spawn、fork 或未来的远程 provider。
- provider 决定子会话如何建立。当前 in-process provider 为每个任务启动独立 plugin context、session、LLM adapter 和 cancellation token。
- tool adapter 决定模型看到哪些入口；每个委派工具固定绑定一个 provider，模型不能绕过 profile 临时选择后端。
- 能力在启动前检查。`persona`、`tool_filter`、`output_schema` 和深度限制不支持时会直接报错，不会静默降级。
- foreground、background、查询、等待和中断共享同一个任务状态机，卸载插件时 effect 会统一回收仍存活的 child context。

## 组成

| 插件 | 职责 |
| --- | --- |
| `agent.plugins.subagent` | 提供 `:subagents/runtime`，注册 provider，校验能力，管理任务与回收 |
| `agent.plugins.subagent-in-process` | 注册 `:spawn`、`:fork`，创建隔离的子 plugin context |
| `agent.plugins.subagent-tools` | 注册委派与后台控制工具 |

默认工具：

- `delegate_task`：启动不继承父对话的 spawn 子代理。
- `fork_agent`：只继承父 session 中以 `step/end` 闭合的完整轮次。当前尚未结束的 assistant/tool-call 轮次不会复制，避免不平衡历史。
- `list_agents`：列出尚未领取的后台任务。
- `wait_agent`：限时等待并领取结果；领取后释放 child context。
- `interrupt_agent`：通过子任务自己的 cancellation token 协作式中断。

同一 assistant message 内的多个 `delegate_task` 没有声明 sequential，因而会沿用 runtime
现有的 sibling 并行执行与确定性结果排序。

## 安全约束

默认 in-process provider 的最大委派深度是 1。子 profile 虽然加载完整 coding tool
插件，但边界 interceptor 同时：

1. 从发给模型的 tool schema 中隐藏未授权工具；
2. 在执行入口再次拒绝未授权工具；
3. 只允许请求把 provider 的 allowlist 进一步缩小，不能扩大。

默认 allowlist 包含 `current_time/read/read_file/ls/find/grep/load_skill/bb_repl`。每个子代理
可以使用自己独立、持久的 Clojure-family REPL；边界 interceptor 仅在 `bb_repl` 实际出现在
本次 tool schema 时，才把该能力及恢复限制追加到 system prompt。子代理仍不能写项目文件、
编辑文件或启动通用进程。需要更强隔离时，应把 `:child-profile` 中的 execution world 换成
容器或远程 provider，而不是扩大本地 allowlist。

`output_schema` 会在 child 完成后解析最终文本并走项目现有 JSON Schema validator；解析或
校验失败时任务以 `:error` 结束，并保留已有的 partial output。

## 配置

默认 [agent.edn](../agent.edn) 已启用三层插件。provider 的关键配置如下：

```clojure
{:ns agent.plugins.subagent-in-process
 :config
 {:max-depth 1
  :allowed-tools ["read" "grep" "find" "ls" "bb_repl"]
  :child-profile
  {:plugins
   [{:ns agent.plugins.session :config {:path nil}}
    {:ns agent.plugins.model-registry :config {:default-provider :chatgpt}}
    {:ns agent.plugins.chatgpt :config {:model "gpt-5.6-sol"}}
    {:ns agent.plugins.runtime :config {:max-steps 8}}]}}}
```

也可以为 tool adapter 配置其他固定 provider 名称：

```clojure
{:ns agent.plugins.subagent-tools
 :config
 {:delegates
  [{:name "research_agent"
    :provider :spawn
    :mode :spawn
    :description "Run isolated repository research."}]}}
```

## 当前范围

当前版本实现 one-shot foreground/background task。它没有实现 DeepSeek Harness continuable
session 的 `followup`/inbox，也没有 child-to-parent `report` 工具；这两项需要持久保留已完成
child session，而不只是保留结果，适合后续作为独立 provider/tool 插件增加，不需要改动
registry 或默认 agent loop。
