# LSP 插件

默认 profile 已启用只读、懒启动的 Language Server Protocol 集成。它由三个可独立替换的
插件组成：

| 插件 | Service / 工具 | 职责 |
|---|---|---|
| `qi.plugins.stdio-session` | `:execution/stdio-session` | 在 ExecutionWorld 的根目录和 sandbox 模式内管理长驻 argv/stdio 进程 |
| `qi.plugins.lsp` | `:lsp/runtime` | server registry、JSON-RPC、客户端生命周期、文档同步和结果归一化 |
| `qi.plugins.lsp-tools` | `lsp_query`、`/lsp` | 向模型与交互前端暴露只读查询 |

删除这三个 profile 条目即可完整卸载 LSP；active server、工具、命令和 service 都会通过
微内核 effect 逆序回收。

## 使用

先看本机哪些已配置服务器可用：

```text
/lsp status
```

`status` 不会启动服务器。第一次针对文件执行其他 action 时，runtime 才会从文件目录向上
寻找最近的 root marker，以 `[server-id, project-root]` 为键复用客户端。可执行文件缺失只会
显示 `:available false`，不会阻止 agent 启动，也不会自动下载软件。

`lsp_query` 支持：

- `status`、`capabilities`、`diagnostics`
- `definition`、`references`、`hover`
- `document_symbols`、`workspace_symbols`
- `implementation`、`type_definition`

位置查询使用从 1 开始的 `line`、该行的精确 `symbol`，以及可选的 `occurrence`。runtime
在本地定位 symbol 并按服务器协商的 UTF-16、UTF-8 或 UTF-32 编码换算 character，避免让
模型猜测协议列偏移。

```json
{"action":"definition","file":"src/demo.clj","line":12,"symbol":"handler"}
```

`/lsp reload` 会先发送 `shutdown` 和 `exit`，然后回收仍存活的进程并清除启动失败 cooldown。

## Server 配置

每项 server 至少包含 keyword `:id`、`:command` 和 `:file-types`：

```clojure
{:ns qi.plugins.lsp
 :config
 {:request-timeout-ms 10000
  :startup-timeout-ms 30000
  :max-document-chars 2000000
  :servers
  [{:id :clojure-lsp
    :command "clojure-lsp"
    ;; 也可写成 argv，启动过程不经过 shell：
    ;; :command ["some-language-server" "--stdio"]
    :file-types [".clj" ".cljs" ".cljc" ".edn"]
    :language-id "clojure"
    :root-markers ["deps.edn" "bb.edn" "project.clj" ".git"]
    :initialization-options {}
    :settings {}}]}}
```

同一 server 服务多种语言时，`:language-id` 也可配置成扩展名到协议 language id 的 map，
例如 `{ ".ts" "typescript", ".tsx" "typescriptreact" }`（EDN 中省略逗号亦可）。

`agent.edn` 预置了 clojure-lsp、rust-analyzer、clangd、typescript-language-server 和
pyright 的声明。安装与版本管理仍由用户或项目工具链负责。多个 server 同时匹配时按配置
顺序选择第一个；需要覆盖时可重排、禁用或删除条目。

## 同步与协议行为

每次文件查询前，runtime 都从 ExecutionWorld 重新读取内容并比较 SHA-256：首次发送
`didOpen`，变化后发送 full `didChange` 和 `didSave`。因此文件无论由 `write`、`edit`、
`hash_edit` 还是外部编辑器修改，下一次查询都不会继续使用旧文本。

诊断优先使用 LSP pull diagnostics；旧服务器只推送 `publishDiagnostics` 时使用有界等待的
缓存。跳转位置统一返回 workspace-relative path 与从 1 开始的 line/column；工作区外 URI
只标记为 `external`，不会读取或展示外部文件内容。

transport 使用 UTF-8 byte length 的 `Content-Length` framing、串行 writer 和 pending request
表。请求绑定 agent cancellation token；取消时发送 `$/cancelRequest`。插件还处理常见的
server-to-client 请求，包括 configuration、workspace folders、动态 capability 注册和 progress。
因为当前集成只读，`workspace/applyEdit` 会明确返回 `applied false`。

## 安全边界与当前范围

- 非 `status` 查询要求项目已通过 trust store；默认 policy 也把 `lsp_query` 标记为 trusted tool。
- server 命令只来自 profile 配置，作为 argv 直接启动，不解释 shell 字符串。
- cwd 必须真实解析在 ExecutionWorld root 内；本地 provider 复用其 `:none`、`:seatbelt` 或
  `:unavailable` 模式。插件卸载、进程退出和显式 reload 都会拒绝 pending request 并回收资源。
- 首版只提供语义读取。rename、format、code action 和任意 workspace edit 尚未开放，避免绕过
  现有 `hash_edit`、project trust 与逐工具 approval 链。
- 当前 client 位于主 agent context；隔离 subagent 不共享 client。后续若需要共享，应增加显式
  broker，而不是把可变 client map 注入 child context。

协议实现以 [LSP 3.18 specification](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/specification.md)
为基线，并保持与常见 3.17 server 的 capability negotiation 兼容。
