# Rust/Ratatui TUI

## 定位

唯一受支持的外部终端前端位于 `apps/tui-rs/`，使用 Rust、Ratatui 0.30 和 Crossterm 0.29。
旧 TypeScript/React/Ink 实现和过渡性的 `agent.plugins.tui-ink` bridge 已经删除。Rust 前端是
常驻 daemon 的普通客户端；session、agent loop、模型、工具、审批、策略和命令由 resident
Babashka worker 持有，关闭 TUI 只产生 detach。

## 构建与运行

```bash
bb tui-build
apps/tui-rs/target/release/dao
```

完全离线的真实工具批次：

```bash
apps/tui-rs/target/release/dao --repository-root . --config examples/tui-mock.edn
```

Rust 前端直接打开 controlling TTY。它通过 TTY 读取按键，并使用 Ratatui inline viewport
维护屏幕底部的动态区；公开 JSONL 协议运行在 owner-only Unix socket 上，诊断只写日志或
stderr。完成的消息和工具组由
`insert_before` 提交到 terminal scrollback，流式 assistant、运行中工具、composer 和 dialog
留在动态区重绘。程序不启用 alternate screen 和鼠标捕获，所以终端原生滚动条、滚轮与历史快捷键
可以直接查看已经完成的对话。没有 controlling TTY 时应运行测试，不应启动交互界面。

## 已对齐范围

- 160×44 宽屏 banner、运行信息面板、Tips、双横线 composer 与 footer；
- 80 列窄屏断点，不显示 ASCII wordmark，但保留完整信息面板和输入区；
- `> / ◆ / ∵ / ∴` 消息层级、GFM 风格 Markdown、流式 assistant/reasoning、错误与通知；
- search/read/list 的单行 Qwen 语义摘要，以及 shell/edit/write/agent 的独立动作、实时输出、耗时、超时、错误和六态生命周期；
- `Ctrl+O` 全局详情和 `Ctrl+T` 单组工具聚焦，可逐组展开、折叠和浏览；
- 74 条处理中趣味短句、15 秒轮换、耗时计数、tmux spinner 回退和窄屏双行状态；
- Unicode grapheme 编辑、保持目标列的多行移动、CRLF 粘贴归一化、输入历史、软件光标与 slash command 补全窗口；
- 空闲 submit、运行中 steer、`Ctrl+Q` follow-up、abort、双击 `Ctrl+C` 与空输入 `Ctrl+D`；
- model、session、tree、theme、approval、select、confirm、input 和 custom JSON 对话框；
- Qwen 内置主题名称、宽屏代码/diff 预览、即时预览、Esc 回滚和 host 同步；
- 已完成历史提交到 terminal scrollback，运行中工具框在 inline viewport 内局部重绘；
- queue 三条预览、溢出计数、排队提示、审批等待行、status、widget、notification 和窗口 resize；
- host 注册快捷键优先调用、snapshot/buffer 去重、流式增量投影、异常中断工具收口与安全退出恢复；
- 所有宿主文本在渲染前移除 ANSI、控制字符和双向文本覆盖字符，避免终端注入。

## 常用按键

| 按键 | 行为 |
| --- | --- |
| `Enter` | 提交；运行中即时 steer |
| `Shift+Enter` / `Alt+Enter` / `Ctrl+N` | 插入换行 |
| `Ctrl+A` / `Ctrl+E` | 移到当前行首 / 行尾 |
| `Ctrl+Q` | 运行中加入 follow-up 队列 |
| `Ctrl+O` | 展开或收起全部工具详情 |
| `Ctrl+T` | 聚焦最近工具组；方向键浏览，Enter 展开，Esc 退出 |
| 终端滚动条 / 鼠标滚轮 / 终端历史快捷键 | 由终端原生浏览已经完成的长会话历史 |
| `Esc` / `Ctrl+C` | 终止当前运行 |

## 验证

```bash
bb tui-test
cargo clippy --manifest-path apps/tui-rs/Cargo.toml --all-targets -- -D warnings
npm run typecheck
npm run test:tui
bb test
```

Rust 测试使用 Ratatui `TestBackend` 验证 160×44、80 列、Markdown、多行 composer、命令补全、dialog
独占、主题、inline viewport/scrollback、queue/approval、extension slots 和完整工具画面；状态机测试验证事件投影、
异常生命周期收口、去重和按键到 RPC 的路由。
`bb tui-test` 还会使用真实的 160×44 PTY 验证启动渲染、消息提交、响应显示和干净退出，断言不会
启用 alternate screen 或鼠标捕获，并防止协议 stdout 与控制终端 `/dev/tty` 再次混用。

## Daemon 架构

Rust TUI、headless CLI 和 WebUI 使用同一个 daemon 协议与 supervisor SQLite 事实源。daemon
崩溃时 resident worker 继续运行；新 daemon 会收养 live worker。worker 重启只恢复 transcript、
durable state 和显式 `replay_safe` REPL cell，不会重放结果不确定的副作用。完整进程边界与协议见
[Daemon-backed Agent 架构](daemon-agent-architecture.md)。

原生 Clojure TUI 仍是 `agent.plugins.tui`。一个 profile 只能配置一个
`:frontend/interactive` provider。
