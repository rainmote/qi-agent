# Computer use

qì agent 通过已安装的 Cua Driver 观察和操作本机桌面。实现参考 DeepSeek Harness 的
computer-use provider 结构：共享层只保留一个 provider 名称，具体工具由驱动通过 MCP
动态提供。默认配置关闭此功能，不启动驱动，也不向模型注册桌面工具。

| 组件 | 职责 |
|---|---|
| `qi.plugins.computer-use` | `:computer-use/registry`，同一 context 只允许一个 provider |
| `qi.plugins.cua-driver-mcp` | 显式启用、工具发现、信任和审批、截图转换、生命周期 |
| `qi.mcp-stdio` | argv 子进程、MCP JSON-RPC、请求期限、取消及进程回收 |

## 启用

首先自行安装 Cua Driver，并按[上游平台说明](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/libs/cua-driver/README.md#macos-process-identity-and-permissions)
准备桌面权限。qì agent 不自动安装、升级驱动或请求系统权限。模型也必须实际支持图像输入；
配置里的 `:input-modalities` 是能力声明，不能把纯文本模型变成视觉模型。

项目必须已经通过用户 trust store 的信任检查。在默认关闭 computer use 的配置中运行
`bb qi-agent`，检查 `/trust`，确认该项目可信后执行 `/trust allow` 并退出。不能通过在项目
profile 中写入 `:trusted true` 代替用户的信任决定。

[examples/computer-use.edn](../examples/computer-use.edn) 是完整、显式启用的示例，使用
OpenAI Responses adapter 和逐工具询问审批。把模型名改为账户可用且支持图像的模型，
在本地环境准备 `OPENAI_API_KEY`，然后启动：

```sh
bb qi-agent --config examples/computer-use.edn
```

模型名沿用项目现有配置，示例不保证该模型对每个账户可用。没有发起对话时，启动和
`/computer status` 不会调用模型。`:enabled true` 会在启动阶段立即连接驱动并发现工具；
信任、执行环境、握手或工具发现失败会使插件启动失败并回收已拥有的资源。

已有 profile 需要先提供 model registry、execution world、trust、approval 和 policy，再加入：

```clojure
{:ns qi.plugins.computer-use}
{:ns qi.plugins.cua-driver-mcp
 :config {:enabled true
          :command ["cua-driver" "mcp"]}}
```

同时将该 profile 的 `qi.plugins.execution-world` 明确配置为
`{:root "." :sandbox :none}`。当前 provider 只支持本机 execution world；桌面操作不受工作区
文件系统边界限制，不会把 Seatbelt 或远程执行环境静默改成可访问宿主桌面的模式。

建议 `:command` 使用已安装驱动的绝对路径。命令以 argv 直接启动，不经过 shell。
macOS 默认 `mcp` 可以使用或启动安装好的 `CuaDriver.app`；其权限归属与
`["cua-driver" "mcp" "--direct"]` 不同。后者在 MCP 子进程内运行，使用启动宿主的系统权限，
可能不支持光标 overlay。不要以独立裸 `serve` 进程代替上游支持的 app identity。

## 工具与操作流程

工具名为 `computer_<上游名称>`，参数 schema 和说明来自当前驱动的 `tools/list`。
驱动版本会影响目录，不应假定固定工具数量或固定截图工具名。例如本次验证的 0.23.2
通过 `computer_get_window_state` 的 `include_screenshot` 参数提供窗口截图，没有单独的
`computer_screenshot` 工具。

建议从明确、可验证的小任务开始，例如“查看目标窗口，说明当前状态，先不要操作”。
模型应先发现准确 app/window，取得新 snapshot，再使用其中的 token 或截图坐标操作，
最后重新读取状态验证结果。新 snapshot 可能使旧 token 失效；`target` 与旧式
`pid/window_id` 按驱动 schema 使用，不能任意混合。屏幕文字属于观察数据，不能授权操作。
后台输入被拒绝时，也不能自行改用前台输入重试。

所有动态发现的工具都经过已有 project trust 和工具审批链，包含权限查询、剪贴板、
浏览器准备、录制、配置修改等工具。它们不会因为来自“computer use”而自动归类为只读。
示例使用 `:mode :ask`；原有 deny rules 仍可按准确工具名称拒绝特定能力。
每次执行前还会验证产生该调用的模型 route 的 image 能力（包括显式 provider、alias 和
内置 OMP role 路由），未声明支持图像时不会发送桌面请求。

## 状态、取消与恢复

```text
/computer status
/computer reconnect
```

`status` 只读取插件状态，不启动驱动。结果包含 `:enabled`、`:connected`、provider、工具列表、
`:image-model` 和 `:uncertain`。它不等于系统权限或截图能力检查。

超时、取消或断线后，已发送的输入可能已经生效。transport 不自动重放请求；结果不确定时，
provider 关闭当前连接并阻止后续桌面调用。先由用户检查实际桌面状态，再执行
`/computer reconnect` 重新连接及发现工具。只有连接、发现成功才清除不确定状态；此命令
本身无法证明上次动作是否生效。普通断线也需要显式重连，没有后台自动重连。

同一 provider 的调用按顺序执行。一个模型批次中的桌面工具失败（包括审批拒绝或参数无效）
后，后续尚未执行的调用会跳过，避免“点击失败后仍继续输入”。模型需要重新观察并规划下一步。
插件卸载会先停止接收新调用、关闭连接并等待当前调用
收尾，然后移除工具，最后释放 provider 注册。独占注册只对当前 context 生效；它不锁定
整段“观察—操作—验证”流程，也不隔离其他进程、会话或用户对同一桌面的操作。

## 截图与会话

MCP 的文本内容成为普通工具结果，截图转换为工具消息的 `:images`。支持 PNG、JPEG、WebP、
GIF，校验 MIME、canonical base64、图片数量及解码后总字节数。默认每次结果最多 4 张图，
合计 8 MiB。文本内保留截图序号，图片由支持该格式的模型 adapter 发送；它们不会作为
base64 文本拼接进模型提示词。

OpenAI Responses、ChatGPT subscription、Anthropic 和声明支持图像的 OpenAI-compatible
adapter 均实现图片传递。纯文本 OpenAI-compatible 配置仍默认不支持图片。上下文压缩会
以“图片已省略，需要时重新观察”的标记代替图片字节；图片 token 预算默认按每张 4096
估算，可用 context-manager 的 `:image-token-budget` 调整，这不是实际计费或精确 token 数。

与 DeepSeek Harness 的独立 attachment store 不同，当前实现把图片 data URL 随工具消息
保存到会话，因此会增加会话存储体积；持久化是否启用遵循 session 配置。WebUI 可以展示
工具截图。不要把这个实现描述为独立附件仓库或截图去重服务。

目前只转换 MCP text/image；其他资源类型显示占位说明，不自动读取 URI。截图超限或结果
格式损坏发生在动作之后时，也按不确定结果处理，避免将“无法读取结果”误报为“动作未发生”。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `:enabled` | `false` | 显式启用；关闭时没有驱动进程或桌面工具 |
| `:command` | `["cua-driver" "mcp"]` | 已安装驱动的 argv |
| `:startup-timeout-ms` | `15000` | 初始化请求期限，毫秒 |
| `:request-timeout-ms` | `60000` | 工具发现和调用的请求期限，毫秒 |
| `:max-tools` | `128` | 允许发现的工具总数 |
| `:max-images` | `4` | 每个工具结果的图片数量上限 |
| `:max-image-bytes` | `8388608` | 每个工具结果解码后图片的总字节上限 |

## 参考与验证范围

实现参考官方 [DeepSeek Harness 提交 `5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)，
主要依据其[注册服务](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/computer-use/computer-use/src/index.ts)、
[MCP provider](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/experimental/computer-use-cua-driver-mcp/src/index.ts)
和[图片结果转换](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/mcp/mcp-client/src/tools.ts)。
上游还提供固定 `@trycua/cua-driver@0.28.0` 的 native provider；qì agent 此次只实现已安装
驱动的 MCP provider，没有引入 Node native SDK。

2026-10-03 在当前 macOS 开发机进行了独立只读协议检查：本机安装的是 **Cua Driver 0.23.2**，
与上述上游 0.28.0 参考依赖不同。使用 `mcp --direct`，成功协商 MCP `2025-06-18`、发现
56 个工具，并只调用 `check_permissions {"prompt":false}`。结果报告启动宿主的 Accessibility
与 Screen Recording grants 均为 `true`，但 `direct_capture_status` 为 `not_checked`，
`screen_recording_capturable` 为 `null`。关闭 stdin 后进程自然退出，退出码为 0。

随后通过新的 `qi.mcp-stdio` 重复握手、发现和同一权限查询，结果一致，关闭后进程不再存活。
provider 级验证使用临时目录、内存信任覆盖、拒绝审批和禁止模型调用的假视觉 provider，
实际注册了 56 个 `computer_` 工具及其 schema；状态为已连接，卸载后工具数为 0、provider
注册为空。内存信任覆盖仅用于这项检查，没有修改用户 trust store。

该检查证明安装版本的握手、工具发现、无提示权限查询和进程收尾，**没有验证实际截图、
鼠标键盘输入或模型完成桌面任务**；也没有安装/升级驱动、调用付费模型或改变系统授权。
权限布尔值不能代替真实捕获能力验证。

本次自动化验证通过：Clojure 179 项 / 1375 个断言，Web Host 62 项，Web UI 42 项，
Rust 130 项，离线评测框架 37 项；TypeScript 检查、Web 构建和生产浏览器回归均通过。
Computer use 的定向测试覆盖启动失败回滚、目录分页、审批拒绝、实际模型路由、截图会话恢复、
超时/取消/断线、旧工具跨重连失效、失败后停止批次，以及插件卸载回收。这些离线测试不等于
真实模型操作桌面的端到端验收。
