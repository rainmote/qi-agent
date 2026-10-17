# OMP-inspired coding foundation 插件

当前实现把 Oh My Pi 中最适合现有架构的三项能力移植进来：

1. 内容哈希锚定的完整文件读取与批量编辑；
2. 角色到 provider 的请求路由；
3. 稳定模板、项目上下文与覆盖文件分离的 system prompt 装配。

插件不替换默认 agent loop、ExecutionWorld 或现有 `edit` 工具。把它从 profile 的
`:plugins` 中移除后，工具、命令、service 和 interceptor 会按微内核 effect 机制一并撤销。

## 配置

```clojure
{:ns qi.plugins.omp
 :config {:max-file-chars 500000
          :max-edits 32
          :default-role :default
          :roles {:default :chatgpt
                  :plan [:anthropic :chatgpt]
                  :slow :anthropic
                  :smol :deepseek}}}
```

每个角色可配置一个 provider，也可配置按优先级排列的候选 vector。路由只会选择已经在
`:llm/registry` 注册的第一个候选；找不到候选时请求会明确失败，不会静默用错模型。
没有配置映射的角色继续使用 registry 当前选中的 provider。

交互模式使用：

```text
/role
/role plan
/role default
```

嵌入调用也可以为单次请求传入 `:model-options {:role :plan}`，其优先级高于当前 `/role`
状态。路由不会改变 model registry 的全局选择，因此一次计划请求不会污染后续普通请求。

## System prompt 装配

默认 profile 通过以下配置启用内置 OMP 风格模板：

```clojure
{:ns qi.plugins.runtime
 :config {:max-steps 12
          :system-prompt-template :omp}}
```

每次模型请求前，runtime 都会重新组合 provider-facing system prompt：

1. 内置稳定模板，或兼容旧配置的 `:system-prompt` 字符串；
2. 已信任的 `AGENTS.md` 项目上下文和渐进加载的 skill 摘要；
3. 当前工具名、工作目录、日期与项目资源信任状态；
4. 可选的覆盖层。

支持用户目录（默认 `~/.qi-agent`）、项目根目录和项目 `.qi-agent` 目录中的以下文件：

- `SYSTEM.md`：替换稳定基础模板，但保留动态上下文、技能、工具和环境块；
- `APPEND_SYSTEM.md`：追加额外指令；存在 `SYSTEM.md` 时紧随自定义模板，否则位于完整生成提示词末尾；
- `AGENTS.md`：作为项目上下文注入，不会被误当成基础模板。

优先级为项目 `.qi-agent`、项目根目录、用户目录。未信任项目的文件全部忽略，用户目录资源仍可使用。
运行时配置的 `:custom-system-prompt` 和 `:append-system-prompt` 分别高于对应文件，方便嵌入式调用做显式覆盖。
普通的 `:system-prompt` 仍表示稳定基础模板，因此现有 profile 不需要迁移。

## Skills

Skills 使用 progressive disclosure：system prompt 只列出可由模型调用的名称、描述和 glob，
模型匹配后通过普通 `read` 工具读取 `skill://<name>`。`load_skill` 仍保留用于兼容旧 prompt。

默认目录：

```text
~/.qi-agent/skills/<name>/SKILL.md
~/.agents/skills/<name>/SKILL.md
<project>/.qi-agent/skills/<name>/SKILL.md
```

扫描是递归的，因此也允许 `skills/team/domain/<name>/SKILL.md`。与 OMP 的单层扫描相比，
这是当前实现有意保留的扩展。

完整配置：

```clojure
{:ns qi.plugins.resources
 :config
 {:root "."
  :skills
  {:enabled true
   :enable-user true
   :enable-project true
   :enable-agents-user true
   :enable-commands true
   :require-description true
   :agents-user-directories ["/Users/me/.agents/skills"]
   :custom-directories ["vendor/agent-skills"]
   :include ["review-*" "docs"]
   :ignore ["*-experimental"]}}}
```

正常 profile 默认把 `~/.agents/skills` 放入 `:agents-user-directories`；若调用方显式传入
`:user-dir`，则视为隔离用户资源环境，不再隐式加入真实 home，此时可以像上例一样显式指定。
该用户级来源不依赖项目 trust。

相对目录以 workspace 为基准。custom directory 只在项目可信时加载。同名 skill
按“custom directory、project `.qi-agent`、user `.qi-agent`、agents-user”选择第一个，并在 snapshot 的 `:skill-warnings` 中记录
被忽略路径；相同 realpath 会直接去重。include/ignore 是对 skill 名称应用的 glob，ignore
最后生效。

`SKILL.md` 使用 YAML frontmatter：

```markdown
---
name: code-review
description: Review changes for correctness and regressions
globs:
  - "*.clj"
alwaysApply: false
hide: false
disable-model-invocation: false
owner: platform
---

Review the complete diff before reporting findings.
```

`name`、`description`、`globs` 和布尔字段会校验类型；未知字段原样保留在 metadata。
`alwaysApply` 会把正文直接加入 system prompt；`hide` 和 `disable-model-invocation` 会把 skill
从模型摘要中移除，但不会禁止 `skill://` 或用户显式调用。

`skill://<name>` 指向 `SKILL.md`，`skill://<name>/<relative-path>` 指向 skill 目录内的附属
文件。解析会拒绝绝对路径、`..` 穿越、逃逸 symlink、目录和不存在的文件。读取仍支持普通
`read` 的 offset、limit 和字符截断语义。

开启 commands 后，每个 skill 动态显示为 `/skill:<name> [args]`。空闲时它启动一次正常
turn；agent 正在运行时则作为 steering message 注入。正文会剥离 frontmatter，并附带虚拟
base directory 和用户参数。`/reload` 后命令列表直接使用新 catalog，无需重启。

in-process spawn/fork 子 Agent 会继承父会话的只读 catalog 和 `load_skill` 工具；其工具
过滤仍不能扩大父 profile 的权限。

## 锚定编辑流程

先调用 `hash_read`：

```json
{"path":"src/example.clj"}
```

它返回文件级 `file_hash`，以及类似 `12:AB12CD34` 的逐行锚点。然后把快照与一个或多个操作
交给 `hash_edit`：

```json
{
  "path": "src/example.clj",
  "file_hash": "12AB34CD56EF",
  "edits": [
    {
      "op": "replace",
      "start": "12:AB12CD34",
      "end": "14:78EF90AB",
      "content": "(defn updated []\n  :ok)"
    },
    {
      "op": "insert_after",
      "start": "20:11223344",
      "content": ";; verified"
    }
  ]
}
```

支持 `replace`、`delete`、`insert_before` 和 `insert_after`。一个调用内的操作先全部验证，
在内存中按从后向前顺序应用，最后只写文件一次。以下情况会在写入前拒绝：

- 没有先调用 `hash_read`；
- 文件级 hash 已过期；
- 行号存在但内容 hash 不匹配；
- 操作范围互相重叠；
- 超过文件大小或单次操作数上限。

成功后会返回新的 `file_hash`。为了避免跨调用沿用已经变化的行号，后续编辑同一文件前仍应
重新执行 `hash_read`。

## 安全边界

- 所有读取和写入都经过 `:execution/world`，不会直接访问宿主文件系统；
- `hash_edit` 使用 ExecutionWorld 解析后的写入目标；
- 默认 profile 已把 `hash_edit` 加入 project trust 和 approval 列表；
- 插件不启动额外进程，不绕过已有 Seatbelt、容器或远程 ExecutionWorld；
- 快照只存在当前插件实例内，不写入 session，也不会携带到下一次启动。

当前 ExecutionWorld 没有 compare-and-swap 写入原语。插件会在最终写入前重新读取并校验
hash，可拦截正常的外部修改；但另一个进程若恰好在“最后一次校验”和“写入”之间修改文件，
仍存在很小的竞争窗口。需要强一致性时，应由后续 ExecutionWorld provider 提供原子条件写。
空文件没有可用的行锚点，初始化内容应继续使用 `write`。

## 与完整 OMP 的边界

当前版本没有伪装成已实现以下能力：

- **DAP**：需要在现有长驻 stdio provider 上增加调试 session 状态机、事件订阅与单独的
  交互审批边界；不能把调试器写内存、启动进程等能力混入只读代码查询。
- **可写 subagent/worktree**：需要子 context、独立 ExecutionWorld 和合并协议，否则并行
  写入会破坏当前确定性的工具批语义。
- **Advisor 二次调用**：当前 provider 的 stream 是全局事件；在工具内部调用第二个模型会把
  两条流混入前端。应先增加 scoped stream/channel，再实现 Advisor。
- **Rust 原生搜索与 AST**：属于性能后端，不应在 Babashka 插件中复制伪实现。

LSP 已由独立的 stdio provider、runtime 和 tool adapter 实现，见
[LSP 插件文档](lsp-plugin.md)。下一阶段可在同一 provider 上单独实现 DAP transport，仍不需要
修改 OMP coding foundation 本身。
