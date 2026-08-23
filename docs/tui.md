# Qwen Code 对齐的 Ink TUI（兼容实现）

> 默认前端已迁移到 Rust/Ratatui；构建、运行、能力矩阵和验证方式见
> [Rust/Ratatui TUI](tui-ratatui.md)。本文保留 TypeScript/React/Ink 实现的协议细节和回退
> 说明，`bb tui-ink-build` 可继续构建该兼容前端。

## 兼容方案

默认 profile 使用 `agent.plugins.tui-ink`。Agent runtime 仍然完全运行在 Babashka 进程中；
TypeScript、React 与 Ink 只实现终端表现层。这一边界让 TUI 可以贴近 Qwen Code 的布局和
交互，同时继续复用本项目的 session、工具、策略、审批、模型 registry 与 slash command。

当前已经落地的界面包括：

- Qwen Code 默认暗色语义色、蓝紫粉 banner 渐变和宽/窄终端断点；
- 随历史滚动的欢迎 banner、运行信息面板与 Tips 行；
- snapshot 恢复和 live event 增量投影；
- 流式 Markdown、reasoning 与错误信息；
- `> / ◆ / ∵ / ∴` 消息层级与紧凑的工具状态行；
- 多行、grapheme-safe 的输入编辑与输入历史；
- Qwen 的双横线输入 chrome、软件光标和底栏提示；
- slash command 补全；
- steer、follow-up 和 abort；
- model、session、tree、theme、approval、select、confirm、input 与 custom JSON 对话框；
- 与 Qwen Code 同步的内置主题、运行时高亮预览、取消回滚和 host 状态同步；
- 打开对话框时由它独占控制区，不再同时显示 composer 与 footer；
- JSON-safe status、widget、notification 投影，以及 host-side shortcut 调用；
- 有界选择列表和长会话虚拟滚动；
- alternate screen、resize 与异常退出清理。

当前还没有实现鼠标滚动、文件路径补全、图片剪贴板、语音和内嵌 shell。Clojure
message/entry/tool renderer 函数不能跨进程变成 React 组件。

## 安装、构建与启动

要求：

- Babashka 1.13 或更新版本；
- Node.js 22.12 或更新版本；
- 一个可访问的 controlling TTY。

首次安装或前端依赖变化后运行：

```bash
npm install
bb tui-build
```

构建产物是 `apps/tui/dist/main.js`。默认 profile 可直接启动：

```bash
bb agent
bb agent --mode tui
bb agent --session .bb-agent/sessions/demo.jsonl
```

未显式传入 `--session` 时，CLI 会创建
`.bb-agent/sessions/<时间>-<ID>.jsonl`。之后可通过 `/sessions` 恢复。profile 若明确只需要
临时会话，可给 session 插件设置 `:ephemeral true`。

完全离线的 mock 不需要模型凭据：

```bash
bb tui-build
bb agent --config examples/tui-mock.edn --mode tui
```

该 profile 使用固定 mock response，适合验证启动、输入、session 投影和退出流程，不代表
真实 provider 的连续多轮能力。

开发时可分别运行：

```bash
npm run test:tui
npm run typecheck
bb test
```

`npm run tui:dev` 本身仍需要由 Clojure 插件提供 JSONL 协议，不能当作独立聊天程序启动。

## 插件配置

默认配置形态：

```clojure
{:ns agent.plugins.tui-ink
 :config {:command ["node" "apps/tui/dist/main.js"]
          :theme "Qwen Dark"
          :shutdown-timeout-ms 1500}}
```

可用配置：

- `:command`：启动前端的 argv vector；默认是
  `["node" "apps/tui/dist/main.js"]`。不经过 shell 展开。
- `:entrypoint`：没有显式 `:command` 时使用的 Node entrypoint。
- `:cwd`：可选的前端工作目录；相对 entrypoint 会在该目录下解析。
- `:env`：可选的子进程环境变量 map。
- `:theme`：初始主题；默认与 Qwen Code 一致为 `"Qwen Dark"`。
- `:shutdown-timeout-ms`：等待前端退出后再强制终止的时间。
- `:interaction-timeout-ms`：UI prompt 等待用户响应的时间；默认 300000ms。

插件启动 Node 子进程时默认设置 `TERM=xterm-256color`、`FORCE_COLOR=1` 和
`NODE_ENV=production`，并先移除从宿主继承的 `NO_COLOR`。这让 Ghostty 等终端稳定启用
Qwen 的 256 色语义色，同时避免 React/Ink 开发渲染器长期累积 performance measures 后出现
`MaxPerformanceEntryBufferExceededWarning`。显式 `:env` 最后应用，因而仍可用
`{:env {"FORCE_COLOR" "0" "NODE_ENV" "development"}}` 覆盖默认值进行诊断。

一个 profile 必须只配置一个提供 `:frontend/interactive` 的 TUI 插件，并且 Ink 插件之前
必须已有 `agent.plugins.remote-registry` 与 `agent.plugins.remote-api`。默认 `agent.edn` 和
`examples/tui-mock.edn` 已按此顺序配置。

## TTY 与 JSONL 边界

运行时进程关系如下：

```text
controlling TTY
   ▲      │ keyboard / resize / Ink frames
   │      ▼
Node + React + Ink child
   stdin  ◀── ready | response | event ── Babashka tui-ink plugin
   stdout ── request{id,method,params} ──▶ remote registry
                                                │
                                                ├─ session / turn
                                                ├─ model / commands
                                                └─ approvals / prompts
```

子进程的 stdin/stdout 专门承载逐行 JSON，不能用于 UI 或日志：

- Babashka 发 `ready`、`response` 和 `event`；
- Node 只发 `{type:"request", id, method, params}`；
- Ink 通过 `/dev/tty`（Windows 为 `CONIN$`/`CONOUT$`）或已有 TTY stream 读写界面；
- 诊断写 stderr，协议 stdout 不得出现 `console.log` 等额外内容。

因此，交互启动需要 controlling TTY。把整个命令放进没有 TTY 的后台管道、CI step 或
重定向环境，通常无法打开界面；CI 应运行测试而不是启动交互 TUI。

前端不会拿到模型凭据、adapter 函数、工具执行函数或任意 Clojure service。它只调用
remote registry 暴露且经过 schema 校验的方法。child EOF 或异常退出时，插件会中止当前
turn，并把尚未处理的审批安全地解析为 deny。

## 快捷键

### 编辑器

| 按键 | 当前行为 |
|---|---|
| `Enter` | 空闲时提交；运行中立即 steer |
| `Ctrl+Q` | 运行中加入下一轮 follow-up 队列 |
| `Alt+Enter` / `Ctrl+N` / `Ctrl+Enter` / `Shift+Enter` | 插入换行 |
| `Esc` | 运行中 abort；空闲时清空编辑区 |
| `Ctrl+C` | 运行中 abort；空闲时清空并提示，500ms 内再按一次退出 |
| `Ctrl+D` | 空编辑区退出；否则向前删除 |
| `Tab` | 接受当前 slash command 补全 |
| `↑` / `↓` | 多行内移动；位于首/末行时浏览输入历史 |
| `←` / `→` | 按 grapheme 移动光标 |
| `Home` / `Ctrl+A` | 移到当前逻辑行首 |
| `End` / `Ctrl+E` | 移到当前逻辑行末 |
| `Backspace` / `Delete` | 向后/向前删除 |

### Transcript 与对话框

| 按键 | 当前行为 |
|---|---|
| `PageUp` / `PageDown` | 按一页滚动 transcript；向上后停止自动跟随底部 |
| `Ctrl+O` | 展开/折叠全部 reasoning 和工具详情 |
| `↑` / `↓` 或 `j` / `k` | 在 selector/approval 中移动 |
| `Enter` | 确认 selector/approval 当前项 |
| `Esc` | 取消 selector；approval 中等价于 deny |

默认没有 `Ctrl+T`、`Ctrl+S`、鼠标滚动或路径补全。主题通过 `/theme` 选择；运行中 steer
直接使用 `Enter` 或 `/steer`。通过 `agent.ui/register-shortcut!` 注册的同名快捷键会优先于
内置行为；它的 handler 保留在 Babashka host，Ink 只发送 `ui.shortcut.invoke`。

## Slash commands

输入 `/` 会显示从 host 动态取得的命令列表，继续输入可过滤，`Tab` 或 `Enter` 接受补全。
常用命令：

| 命令 | 行为 |
|---|---|
| `/model`、`/model PROVIDER` | 打开模型选择器或直接选择 provider |
| `/sessions` | 刷新并打开 session catalog；选择后重启同一 frontend 到该 session |
| `/theme`、`/theme NAME` | 预览并应用 Qwen Code 内置主题；默认 `Qwen Dark` |
| `/session` | 查看当前 session 信息 |
| `/tree` | 打开 append-only session tree selector；选择后 checkout |
| `/name TEXT`、`/label TEXT`、`/checkout ID` | 修改 session metadata 或活动 entry |
| `/compact`、`/clear` | 追加 compact/clear checkpoint，不重写旧日志 |
| `/state`、`/abort`、`/steer TEXT`、`/follow-up TEXT` | 控制当前 turn |
| `/trust`、`/trust allow`、`/trust deny` | 查看或修改当前项目 trust |
| `/plugins`、`/tools`、`/commands` | 查看 runtime inventory |
| `/reload` | 重新加载资源 catalog |
| `/role [ROLE]`、`/lsp [status\|reload]` | 默认 profile 的 OMP/LSP 扩展命令 |
| `/skill:NAME [ARGS]` | 调用资源 catalog 暴露的 skill command |
| `/quit` | 安全退出 TUI |

`/fork` 有意不穿过 remote command 边界；在 TUI 外使用
`bb agent --session SOURCE --fork DESTINATION`。

主题选择器与 Qwen Code 使用同一组内置主题：Auto、Qwen Light、Qwen Dark、Atom One、
Ayu、Dracula、Default、GitHub、Shades Of Purple、各 Light 变体、Google Code、Xcode 与
ANSI。选择器与 Qwen Code 一样使用左右分栏：左侧移动高亮，右侧立即用该主题渲染代码和
diff，因此即使 Qwen Dark、Default、ANSI 共享相近的界面语义色，也能看清完整调色板差异。
`Esc` 恢复打开选择器前的主题，`Enter` 同步更新前端和 host 主题状态。主题名称严格采用
Qwen Code 的名称，不接受旧 TUI 的
`midnight`、`paper`、`matrix` 配置。

新项目默认处于 deny/restricted 状态，Ink TUI 当前不会自动弹出首次信任向导。先运行
`/trust` 检查 canonical root，再明确执行 `/trust allow`；不信任时保持 `/trust deny`。

## 审批与 prompt

将 approval 插件设为 `:ask` 后，工具审批会显示三项：仅本次允许、当前 session 允许、
拒绝。方向键或 `j/k` 移动，`Enter` 确认，`Esc` 拒绝。普通 `select` 和 `confirm` prompt
也使用有界 selector；required prompt 不能取消。`input` 使用单行文本编辑器，`custom`
当前接受一行 JSON 并在提交前解析；无效 JSON 会留在对话框中显示错误。

## UI 扩展边界

Ink 会从 snapshot 和 live event 中增量接入可逆的 `agent.ui` 扩展：

- `set-status!` 在编辑器下方显示紧凑状态；
- `set-widget!` 按 `:placement :above-editor` 或 `:below-editor` 显示文本组件；
- `notify!` 在编辑器上方显示最新通知，并按 level 区分颜色；
- `register-shortcut!` 发布快捷键名称，前端命中后回调 host handler；注册被撤销时立即从前端移除。

跨进程数据必须是 JSON-safe 值。函数或不可序列化的 host value 会被替换为明确的
unavailable 占位符。message/entry/tool renderer 函数不会发给 Node；如果扩展依赖这些原生
Clojure renderer，请使用旧版 TUI。

## 使用旧版 Clojure TUI

`agent.plugins.tui` 仍保留为兼容方案。它不需要 Node，并继续支持旧的 `agent.ui`
renderer、主屏模式、鼠标滚动与 hardware cursor。要使用它，在自定义
profile 中移除 `agent.plugins.tui-ink`，改为：

```clojure
{:ns agent.plugins.tui
 :config {:root "."
          :screen :alternate
          :theme :midnight
          :mouse true
          :hardware-cursor false}}
```

不要同时加载两个 TUI。CLI 的 `--mode tui` 只负责选择交互模式，不会替你解决两个
`:frontend/interactive` provider 的冲突。

## 故障排查

- `Cannot find module ... apps/tui/dist/main.js`：运行 `npm install` 和 `bb tui-build`。
- Node 版本错误或 Ink 无法加载：确认 `node --version` 至少为 22.12。
- 界面仍然没有颜色：确认 profile 没有通过 `:env` 把 `FORCE_COLOR` 覆盖为 `0`；默认启动命令
  不需要额外设置 Ghostty 环境变量。
- 出现 `MaxPerformanceEntryBufferExceededWarning`：确认没有通过 `:env` 把 `NODE_ENV`
  覆盖成 `development`，并重新运行 `bb tui-build` 后启动。
- `could not open /dev/tty`、界面没有尺寸或无法读取键盘：从真实交互终端启动，不要把 TUI
  放进无 controlling TTY 的 pipe/CI。
- 前端工作目录不是仓库根：给 `:command` 使用绝对 entrypoint，或配置正确的 `:cwd`。
- 界面显示 transport EOF/child exit：检查继承到 stderr 的 Node 错误；协议 stdout 不能混入
  日志。
- 写入、Bash 或 `bb_repl` 不可用：先用 `/trust` 确认项目状态；approval 与 trust 是两层
  独立限制。

设计边界和迁移范围见 [Qwen-style Ink TUI plugin](design/qwen-ink-tui-plugin.md)。
