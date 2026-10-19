# Design QA — Harness 对照改造

参考固定为 `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`；实现基线为 qi-agent `d3173b5f01b86565bf300d54b7b24ea9d14d6060`。完整说明见 [对照报告](docs/webui-harness-comparison.md)。

## 证据

官方真实构建使用随仓 scaffold 和录制历史；候选/基线使用相同确定性 API fixture。独立真实后端 E2E 使用隔离 Host、daemon、Worker 与离线 provider。未用截图替换可交互组件。

- 官方原图：[reference/](docs/ui-harness-20261019/reference/manifest.json)，1440×1000、768/390/320×844，DPR 1。
- 改造前：[before/](docs/ui-harness-20261019/before/manifest.json)，17 张。
- 最终候选：[after/](docs/ui-harness-20261019/after/manifest.json)，19 张，320/375/390/768/1024/1440px，浅/深色，DPR 1。
- 组合对照：[桌面新会话](docs/ui-harness-20261019/comparisons/desktop-new-session.png)、[移动新会话](docs/ui-harness-20261019/comparisons/mobile-new-session.png)。
- 重点对照：[桌面设置](docs/ui-harness-20261019/comparisons/desktop-settings.png)、[移动设置](docs/ui-harness-20261019/comparisons/mobile-settings.png)。

## 核对与迭代

| 范围 | 已核对的呈现与交互 |
| --- | --- |
| 外框与导航 | 灰阶与蓝色强调、280px 侧栏、紧凑会话项、两行标题、居中自适应正文。平板抽屉入口可用。 |
| 新会话与输入 | 居中标题、圆角输入面板、左右两组控件、空态。移除会影响固定菜单定位的父级 transform。320px 下菜单与输入控件无横向越界；宽度变化重算输入高度，两行提示及长草稿保持可见/可滚动。 |
| 消息与过程 | Markdown、reasoning-only 消息、四种展示、成功轮次折叠；失败/取消/未知结果保持可见，最终答复和审批不被隐藏。 |
| 工具与子任务 | 单项展开、完成/失败/未确认状态、子任务结果 disclosure；活动转完成时保留焦点，历史组头获焦点仍可点击，整轮关闭重置子项。 |
| 设置与返回 | 800px 设置面板及手机重排，主题卡片、展示设置、标签无裁切；portal、背景 inert、Tab/Escape 与关闭后焦点返回。 |

独立只读复核提出的平板导航、手机设置裁切、异常轮次误折叠及工具焦点问题均已修复。两条焦点问题及输入宽度重排都有有效失败断言再修复；最终构建须以 checks/ 中的最终测试记录为准。

## 结果与限制

设计 QA 的已验证页面范围通过；最终只读代码复核范围内无已知 P1/P2。差异保留并记录：qì 品牌、快捷开始、业务设置、手机抽屉；没有声称整个官方产品逐像素一致。

官方真实模型的流式/审批/子任务交互未实测；物理手机键盘与安全区、Electron、浏览器历史按钮未验证。广义 Host 测试仍有 3 项隔离环境失败，冻结基线相同；设计 QA 通过不等于完整维护控制器验收 PASS 或发布批准。

final result: passed（仅本轮已验证的设计范围；完整维护验收仍受上述阻碍）

---

# 基线既有 QA 记录

以下保留基线原文，包含早期 Web 与 TUI 任务；不代表本轮重跑或确认其外部临时截图仍存在。

# Web model-provider settings parity QA

## Comparison target

- Source visual truth: `/tmp/dao-settings-models/source-list.png`,
  `/tmp/dao-settings-models/source-edit.png`, and
  `/tmp/dao-settings-models/source-custom.png`, captured from DeepSeek Harness at
  `http://127.0.0.1:3080/`.
- Implementation captures: `/tmp/dao-settings-models/target-list-final-v2.png`,
  `/tmp/dao-settings-models/target-edit-final.png`, and
  `/tmp/dao-settings-models/target-custom-final-v2.png`, captured from the isolated qì agent
  production preview at `http://127.0.0.1:3185/`.
- Full-view evidence: the three source captures and three implementation captures were opened
  together in one comparison input and judged as matched list, edit, and custom-provider states.

## Capture normalization

- Source and implementation captures are 1280 × 720 image pixels from the same 1280 × 720
  CSS-pixel viewport at device scale factor 1.
- State: light theme, settings modal open, Models tab active. The three comparisons cover the
  provider list, collapsed built-in-provider editor, and expanded custom-provider form.
- qì agent intentionally shows OpenAI and the temporary `Local Test` QA provider in addition to
  DeepSeek. Comparison therefore judges frame geometry, hierarchy, cards, controls, form order,
  typography, and interaction behavior rather than identical provider-row count.
- Focused crops were not needed: labels, inputs, status dots, borders, radii, and button states are
  legible at the normalized native resolution, and the edit/custom states isolate the dense regions.

## Findings

No actionable P0, P1, or P2 differences remain in the model-provider settings flow.

- Fonts and typography: modal/nav headings, 12–13 px labels, secondary copy, provider identity,
  and button weights follow the source hierarchy without wrapping or truncation.
- Spacing and layout rhythm: the 800 × 704 modal, 190 px navigation rail, 24 px content inset,
  provider-card height, inset editor, two-column add actions, and custom-form field rhythm align
  with the source. Content naturally scrolls when the real provider list is longer.
- Colors and tokens: white provider cards, gray inset editors, subtle borders, focus rings, muted
  status dots, and configured-key green state use existing qì agent tokens while matching the source
  contrast and surface hierarchy.
- Image and asset fidelity: this settings surface has no raster imagery. Existing project icon
  components are used consistently; no placeholder or generated visual asset is present.
- Copy and content: Chinese labels and action names match the DeepSeek flow. qì agent uses its own
  provider IDs and exposes three supported protocols, which is required by the backend contract.
- Interactions exercised in the browser: 13 preset providers can be selected; advanced settings
  expand; a custom provider can be created with a model catalog; the saved model immediately
  appears in an already-running session's model selector; editing its display name refreshes the
  option without changing the selected model; model rows can be added/removed; custom providers
  expose guarded deletion; and no browser console warnings or errors were emitted.
- API keys are persisted only in the local Host state file with mode `0600`; API responses are
  redacted to an `apiKeyConfigured` flag. OpenAI-compatible completions, OpenAI Responses, and
  Anthropic Messages settings are loaded into the live runtime and can be reloaded without restart.

## Comparison history

### Iteration 1

- P2 finding: the first settings modal was 920 px wide, repeated a content-level “设置” heading,
  and used gray provider cards, making the content column and surface hierarchy visibly different.
- Fix: matched the 800 × 704 frame, 190 px rail, source content inset, direct tab heading, white cards,
  and gray inset editor.
- Post-fix evidence: `/tmp/dao-settings-models/target-list-final-v2.png`.

### Iteration 2

- P2 finding: built-in provider editing used a full editable display-name field and the disclosure
  arrow pointed upward, producing a taller form and the wrong collapsed affordance.
- Fix: replaced it with the source-style provider-name/ID identity row, kept API key plus collapsed
  advanced settings, corrected the right/down disclosure rotation, and aligned action placement.
- Post-fix evidence: `/tmp/dao-settings-models/target-edit-final.png`.

### Iteration 3

- P2 finding: the custom-provider form placed the API key before URL/protocol and stretched the
  protocol selector across the whole editor, unlike the source field order and half-width control.
- Fix: ordered Provider ID, name, API URL, protocol, API key, and model catalog; removed the redundant
  disclosure in custom mode; constrained the protocol selector to 240 px.
- Post-fix evidence: `/tmp/dao-settings-models/target-custom-final-v2.png`.

final result: passed

# Web new-session, slash-command, and context parity QA

## Comparison target

- Source visual truth: `/tmp/dao-three-fixes/source-new.jpg`, `/tmp/dao-three-fixes/source-slash.jpg`, and `/tmp/dao-three-fixes/source-context.jpg` from DeepSeek Harness at `http://127.0.0.1:3080/`.
- Implementation captures: `/tmp/dao-three-fixes/target-new-final.jpg`, `/tmp/dao-three-fixes/target-slash-final.jpg`, and `/tmp/dao-three-fixes/target-context-final.jpg` from an isolated authenticated qì agent preview serving the same production build as `http://127.0.0.1:3081/`.
- Full comparison: `/tmp/dao-three-fixes/comparison-all-final.jpg`, with DeepSeek on the left and qì agent on the right for all three states.
- Focused slash-menu comparison: `/tmp/dao-three-fixes/comparison-slash-focused.jpg`.

## Capture normalization

- All source and implementation states were captured at a 1280 × 720 CSS-pixel viewport and retained as 1280 × 720 image pixels.
- States: focused empty new session with a model selector, `/` entered with the command list open, and a populated trajectory with a real runtime-context row.
- Provider/model values, available runtime commands, session contents, and run length differ by product and test environment. Comparison is limited to the shared interaction contract, hierarchy, spacing, menu/composer geometry, and semantic trajectory presentation.

## Findings

No actionable P0, P1, or P2 differences remain in these three surfaces.

- A new session loads model, policy, and command metadata before the first submit. The chosen model is retained when the first message creates the durable session.
- Entering `/` immediately opens a real runtime command list. Arrow navigation, `Tab`/`Enter` selection, `Escape` dismissal, filtering, and execution after a command plus whitespace were exercised in the browser.
- Each new model turn records a durable `context/snapshot` before the provider request. The trajectory renders its actual prompt content as a green `CONTEXT` row, including when a provider request fails before returning a response.
- The final browser state contained no console warnings or errors. The full suite passes: 8 web UI tests, 4 web-host tests, 76 Rust library tests, 5 Rust binary tests, 15 daemon fault tests, and 80 Clojure tests with 621 assertions.
- Expected P3 differences are the native select treatment versus DeepSeek's nested model/reasoning menu, the provider-specific command catalog, and one consolidated context snapshot versus the two historical context records in the reference session.

## Comparison history

### Iteration 1

- P1 finding: the new-session path cleared runtime metadata and rendered model controls only for an active session.
- Fix: introduced draft-session metadata plus pending model/policy state and applied those selections before the first submitted turn.

### Iteration 2

- P1 finding: `/` had no response before a session existed, and a selected command ending in whitespace could leave Enter trapped in menu selection.
- Fix: retained the runtime command catalog for empty sessions, added complete keyboard handling, and closed suggestions once command arguments begin.

### Iteration 3

- P1 finding: trajectory rows inferred context-like labels from unrelated events but had no durable record of the actual provider prompt.
- Fix: recorded `context/snapshot` immediately before the provider call and rendered its exact content through the semantic trajectory projection.

### Iteration 4

- P2 finding: the first command-menu pass was too wide and short, and `follow-up` wrapped across lines.
- Fix: aligned the menu to the reference composer width and height, widened the command-name column, and prevented command labels from wrapping.

final result: passed

# Web trajectory visual parity QA

## Comparison target

- Source visual truth: `/tmp/dao-trajectory-ui/01-deepseek-trajectory.jpg` from DeepSeek Harness at `http://127.0.0.1:3080/`.
- Implementation capture: `/tmp/dao-trajectory-ui/07-dao-final.jpg` from qì agent Harness at `http://127.0.0.1:3081/` (verified through an isolated authenticated preview serving the same build).
- Full-view comparison: `/tmp/dao-trajectory-ui/08-comparison-final.jpg`, with DeepSeek on the left and qì agent on the right.
- Focused trajectory comparison: `/tmp/dao-trajectory-ui/09-comparison-final-main.jpg`, cropped to the shared 1160 × 390 main trajectory surface.

## Capture normalization

- Both pages were captured at a 1440 × 900 CSS-pixel viewport and normalized to 1440 × 900 image pixels before comparison.
- State: dark theme, populated session selected, `轨迹` tab active, equal-width timeline mode, turns and calls expanded, search empty, and no event detail selected.
- Session payloads differ, so comparison is limited to the shared trajectory shell, hierarchy, spacing, typography, controls, timeline lanes, event ledger, composer, and responsive behavior.
- A separate 760 × 900 check confirmed that the trajectory surface has no document-level horizontal overflow and that toolbar, timeline, table, and composer remain usable.

## Findings

No actionable P0, P1, or P2 differences remain in the trajectory surface.

- The 46 px session header, tab row, 32 px toolbar, 50 px Input/Model/Tools overview, full-width semantic event rows, and fixed composer geometry now follow the DeepSeek reference.
- Durable events are presented as `SYSTEM`, `USER`, `CONTEXT`, `ASSISTANT`, `TOOL`, and error rows instead of raw JSON blocks. Tool calls are paired with their results and expose arguments, output, and duration.
- Duration mode, turn folding, tool-call folding, search dimming, timeline selection, and event detail selection were exercised against a 32-call session.
- The final browser console contained no warnings or errors.
- Expected P3 differences are limited to project branding, session data, provider/model values, and telemetry availability outside the shared trajectory contract.

## Comparison history

### Iteration 1

- P1 finding: qì agent rendered the durable event stream as a raw JSON-oriented list and lacked the DeepSeek toolbar, three-lane overview, semantic tags, folding controls, search, and linked tool-call presentation.
- Fix: introduced a dedicated trajectory projection and view with paired tool lifecycle records, semantic rows, timeline lanes, filtering, folding, selection, and details.
- Evidence: `/tmp/dao-trajectory-ui/04-comparison-1.jpg`.

### Iteration 2

- P2 finding: the first pass still differed in header/tab spacing, composer proportions, timeline density, and bottom-run summary.
- Fix: aligned those dimensions and added run telemetry derived from the selected session.
- Post-fix evidence: `/tmp/dao-trajectory-ui/08-comparison-final.jpg` and `/tmp/dao-trajectory-ui/09-comparison-final-main.jpg`.

final result: passed

# TUI visual parity QA

## Comparison target

- Source visual truth: `/Users/one/study/qwen-code/docs/design/ctrl-o-detail-expand/assets/main-view-collapsed.png`
- Current Qwen component truth: `/Users/one/study/qwen-code/packages/cli/src/ui/components/`
- Implementation capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-history-160x44.png`
- Dialog-state capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-model-dialog-160x44.png`
- Combined comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/history-comparison.png`
- Theme captures: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-qwen-dark-160x44.png` and `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-dracula-160x44.png`
- Theme selector capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-dialog-160x44.png`
- Theme comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/theme-comparison.png`
- Theme preview comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/theme-preview-comparison.png`
- Tool-summary capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-tool-summary-160x44.png`
- Tool-summary comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/tool-summary-comparison.png`

## Capture normalization

- Source pixels: 1400 × 900.
- Implementation pixels: 1385 × 876 from a 160 × 44-cell xterm viewport, Menlo 14 px, line-height 1.2, device scale factor 1.
- Full-view comparison: both images normalized to 700 × 450 CSS pixels in one 1440 × 486 comparison image.
- State: the source is an active, tool-rich session; the implementation is a completed offline mock turn. Dynamic content density is intentionally different. Only shared shell, hierarchy, typography, tokens, and controls were judged across these two states.
- Focused evidence: the native-resolution source and implementation images were also inspected directly for the header/banner and composer/footer regions. No extra crop was needed because both regions remain legible at native resolution. The dialog capture separately verifies that the dialog replaces composer/footer while preserving history.
- Tool-summary evidence: the Qwen reference and the implementation's real 160 × 44 PTY frame were normalized to equal 700 × 450 panels. The transcript content differs, but both frames show the same completed read/search/list aggregation state.

## Findings

No actionable P0 or P1 differences remain in the shared visual surfaces. The
follow-up section records lower-priority density and telemetry differences that
do not change the core Qwen interaction or hierarchy.

- Fonts and typography: both captures use a 14 px Menlo-class monospace face. Heading, secondary text, input, user, assistant, and status weights preserve the same hierarchy.
- Spacing and layout rhythm: the two-column 37-column wordmark plus single-border runtime panel, two-column breakpoint, two-column margins, scrolling banner, full-width input rules, and two-column footer behavior follow the Qwen layout. The 80-column PTY check hides the wordmark without clipping the panel.
- Colors and tokens: the implementation uses Qwen's default dark semantic mapping and blue-purple-pink gradient. Focus, accent, secondary, success, warning, and error colors no longer use component-local color names. Theme-specific syntax/diff colors retain Qwen's raw built-in palettes.
- Image and asset fidelity: this terminal surface has no raster image assets. The source's native ASCII wordmark treatment is retained with a project-specific `BB AGENT` wordmark of equivalent width and gradient behavior.
- Copy and content: Qwen's placeholder, Tips line, model-change hint, dialog help, and busy/abort affordances are preserved. Product identity and mock response text intentionally remain qì agent-specific.
- Icons: user, assistant, reasoning, and tool status glyphs follow the Qwen vocabulary (`>`, `◆`, `∵`, `∴`, `o`, `⊷`, `✓`, `x`) and force ambiguous symbols to text presentation where needed.
- States and interactions: idle, completed history, model dialog, theme preview/apply/rollback, narrow terminal, selection, approval, input, loading, queue, and long-history states are covered by captures or component tests. Opening a dialog hides composer/footer and keeps the conversation visible.
- Accessibility and resilience: all controls remain keyboard-driven; software cursor and focus border are visible; grapheme editing and constrained-height dialogs are covered. The 80-column PTY capture and narrow component tests show no overlap or clipping.

## Comparison history

### Iteration 1

- Earlier finding: the first implementation used a compact 17-column `BB` mark and the optional gold/orange Qwen Dark palette. Against the source, this left the header visually underweighted and used the wrong default gradient.
- Fix: replaced it with a 37-column `BB AGENT` wordmark and mapped every component to Qwen's default dark semantic tokens and blue-purple-pink gradient.
- Post-fix evidence: `history-comparison.png` and `bb-agent-history-160x44.png`.

### Iteration 2

- Earlier finding: the initial xterm capture did not anchor to the live bottom, making the dialog screenshot appear to lose history even though the Ink frame retained it.
- Fix: matched Qwen's terminal-capture behavior by scrolling xterm to the live bottom before each screenshot; also added an App regression assertion that banner/history remain while composer/footer disappear.
- Post-fix evidence: `bb-agent-model-dialog-160x44.png`.

### Iteration 3

- P1 finding: `/theme` updated only a local `midnight|paper|matrix` label while every component retained the module-load palette, so changing the theme produced no visual change. The host also kept its initial theme and could overwrite the frontend on a later extension snapshot.
- Fix: replaced the placeholder list with Qwen Code's current built-in registry and `Qwen Dark` default; removed the legacy `midnight|paper|matrix` aliases; moved semantic colors behind live getters; made list highlight preview immediately, `Esc` restore the previous selection, and `Enter` update both frontend and host. Tool status colors and fenced-code colors now resolve at render time instead of being captured during import.
- Post-fix evidence: `theme-comparison.png` shows the same 160 × 44 idle state before and after `/theme Dracula`; the wordmark, title, focused input rule, prompt, and status tokens visibly switch together.
- Strictness check: `bb-agent-theme-dialog-160x44.png` contains only Qwen Code theme names. `/theme midnight`, `/theme paper`, and `/theme matrix` are rejected locally and never mutate host theme state.

### Iteration 4

- P1 finding: runtime theme selection and host synchronization were working, but the generic list-only selector hid an important Qwen behavior. `Qwen Dark`, `Default`, and `ANSI` intentionally share the default dark semantic chrome, so an idle screen can look almost unchanged even though their syntax palettes differ. The missing Qwen code/diff preview made those real differences impossible to inspect before applying a theme.
- Fix: theme selection now uses a dedicated Qwen-style 45%/55% dialog. The left pane keeps the numbered, scrolling theme list; the right pane renders the highlighted theme's foreground, background, syntax colors, and semantic add/remove diff colors immediately. Wide terminals get the full preview, constrained heights reduce preview detail, and narrow terminals retain a list-only layout. `Esc` rollback and `Enter` host application remain unchanged.
- Post-fix evidence: `theme-preview-comparison.png` shows the same 160 × 44 dialog with Qwen Dark and Qwen Light highlighted. The code surface changes from dark to light and syntax/diff colors remain readable in both. `theme-comparison.png` separately confirms that applying Dracula still updates the main shell.
- Regression result: 71 TUI tests, the full TypeScript/web test suite, and 58 Clojure tests with 430 assertions pass.

### Iteration 5

- P0 finding: tool lifecycle events were recorded only after an entire parallel batch completed. A fast tool therefore remained visually `running` until the slowest sibling finished, and a cancellation could leave pending/running rows without a terminal state.
- P1 finding: read/search/list calls were grouped structurally but rendered as separate category rows, with static tool and response indicators. The UI did not produce Qwen's single mixed semantic sentence or its active-to-past-tense transition.
- Fix: record one batch boundary per model step, emit each tool's live completion at its actual finish time, preserve durable results in model order, and terminalize canceled work. The renderer now composes search → read → list into one deterministic sentence, uses active wording and an animated toggle while work is running, switches to past tense when complete, displays elapsed time for long-running work, and preserves action-tool output and full `Ctrl+O` detail.
- Status fix: the main response indicator now uses Qwen's animated frames, complete Chinese phrase set, 15-second phrase rotation, elapsed timer, tmux fallback, and width-sensitive layout. Every timer is cleaned up on unmount.
- Post-fix evidence: `tool-summary-comparison.png` and `bb-agent-tool-summary-160x44.png`. The implementation frame shows one completed `Searched …, read …, listed …` line with Qwen's success glyph and semantic color in the same 160 × 44 terminal geometry.
- Regression result: 106 TUI tests, the complete TypeScript/web suite, and 69 Clojure tests with 526 assertions pass. The final consistency pass also covers reused tool-call IDs across steps/runs, every canceled late-provider outcome, and both durable `run_id` spellings. A real PTY run launched with inherited `NO_COLOR=1`, retained 256-color output, completed the mock tool batch, and exited without Node performance or color-conflict warnings.

### Iteration 6 — Rust/Ratatui replacement

- Migration: added `apps/tui-rs`, a Rust 2024/Ratatui frontend that reuses the existing JSONL bridge and leaves the Babashka runtime boundary unchanged. The default and offline mock profiles launch its release binary. The temporary React/Ink fallback was removed after parity validation.
- Visual contract: Ratatui `TestBackend` renders deterministic 160 × 44 and 80-column buffers. Tests cover the wide wordmark/runtime panel, narrow breakpoint, Tips/history hierarchy, double-rule composer, software cursor, footer, dialog-exclusive control region, two-pane theme preview, semantic tool aggregation, multiline input, slash suggestions, queue and extension slots.
- Interaction contract: state-machine tests cover grapheme editing/history, idle submit, busy steer, `Ctrl+Q` follow-up, abort/exit, model/session/tree/theme selection, approval navigation, required input/custom JSON validation, durable-event deduplication, streaming projection and monotonic tool completion.
- Historical cross-implementation result: before removal, the TypeScript baseline was green at 109 TUI tests. The initial Rust replacement passed 23 projection/interaction/UI tests under strict `clippy -D warnings`, and the Babashka bridge suite remained green at 70 tests and 544 assertions, proving that switching the child command did not change host behavior.
- Real terminal result: a 160 × 44 pseudo-terminal smoke run started the offline mock profile, loaded snapshot and commands, submitted a user turn, completed the mixed read/search/list tool batch, rendered the final assistant response, invoked `frontend.exit`, and restored the terminal cleanly.
- Performance fix: the first PTY pass revealed unnecessary continuous redraw. Rendering is now dirty-state driven, with timed redraw only while an animated busy state is visible; the idle frontend no longer consumes a core.
- Terminal-channel regression fix: fullscreen initialization no longer calls `Terminal::clear`, whose cursor-position query writes through process stdout (reserved for JSONL) and can spin forever when no terminal answers. The frontend now clears directly through its `/dev/tty` backend and enables Crossterm's `use-dev-tty` event source. A committed Expect smoke test verifies startup, a complete mock turn, and clean exit; an idle-process check measured 0.1% CPU instead of a saturated core.
- Busy-copy parity fix: Ratatui now ships the same 74 individually written Chinese humorous phrases as Ink, chooses one as soon as work starts, rotates it every 15 seconds, and shows elapsed time plus the cancel affordance. The 80-column row stays compact, 31–79 columns use two lines, and ≤30 columns retain only the essential cancel hint.

### Iteration 7 — Rust feature-completeness pass

- Content parity: assistant output now uses styled Qwen/GFM blocks for headings, rules, quotes, lists, task lists, fenced code, links, emphasis and strike-through. ANSI/OSC escapes, terminal controls and bidi overrides are removed from every untrusted host surface before rendering.
- Tool parity: search/read/list retain the compact mixed sentence, while shell/edit/write/agent calls render as individual actions with live output, elapsed and timeout metadata, complete error/result tails, six-state icons and cancellation styling. `Ctrl+O` remains the global toggle; `Ctrl+T` adds per-group focus, navigation and expansion.
- Long-session parity: transcript rendering now selects only the bottom visible item window plus a small overscan instead of formatting the entire history every frame. Mouse-wheel and page navigation retain bottom-follow behavior, clamp safely at both ends, and an ASCII scrollbar exposes position.
- Interaction parity: queue previews are capped at three with overflow and `Ctrl+Q` guidance; approval dialogs retain Qwen's static waiting row; registered host shortcuts take precedence and surface failed invocation responses. Multiline editing adds `Ctrl+A`, `Ctrl+E`, `Ctrl+N`, preferred grapheme columns and normalized pasted line endings. The humorous phrase continues rotating while tool work pauses only the model-response timer, exactly like the Ink baseline.
- Protocol parity: durable snapshot IDs seed live-event deduplication, duplicate tool calls update in place, LLM text/reasoning deltas project incrementally, and idle/abort transitions terminalize abandoned tools instead of leaving stale running rows.
- Regression result: the Rust suite now passes 41 projection/editor/interaction/UI tests under strict `clippy -D warnings`. The full cross-language and real-PTY results are recorded by the final verification commands in `docs/tui-ratatui.md`.

### Iteration 8 — native terminal scrollback

- Architecture correction: the default Rust frontend now uses Ratatui's inline viewport instead of the alternate screen. Only streaming assistant text, active tool frames, composer, loading state and dialogs are redrawn.
- Stable-history contract: the header and the contiguous completed history prefix are rendered once with `insert_before`. A running or confirming tool blocks later rows from committing, which preserves event order; when it reaches success, error or cancellation, its final frame moves into terminal scrollback.
- Native navigation: mouse capture and the in-app ASCII scrollbar are disabled in inline mode. The terminal owns wheel, scrollbar and history-key navigation, so completed output remains available after redraws and after the frontend exits.
- Protocol safety: Crossterm cursor-position queries are temporarily directed to `/dev/tty`, while stdout remains the JSONL bridge channel. Cleanup clears only the live inline viewport and restores bracketed paste, cursor visibility and raw mode without deleting committed history.
- Regression result: 44 Rust tests include TestBackend scrollback, contiguous-commit and constrained-height dialog assertions. The 160 × 44 real-PTY smoke test completes a mock turn, verifies clean exit, and rejects alternate-screen or mouse-capture enable sequences.

## Upstream-only follow-up polish

These are differences from newer upstream Qwen surfaces, not regressions against
the historical TypeScript/Ink implementation that has since been removed from this repository.

- P3: the checked-in Qwen source screenshot is from v0.19.2 and contains different session content. Current component source was used to resolve later token and layout behavior, but an upstream current-version idle screenshot would make future pixel diffs more exact.
- P2: Qwen can show token/rate telemetry in the wide loading row. The current host protocol does not publish those values, so the Rust frontend cannot display them yet.
- P3: the action-tool output safety cap is applied per tool instead of sharing one constrained budget across all sibling tools; expanded mode still exposes each complete result.
- Expected difference: the wordmark, product title, version, provider, model, path, and transcript content remain specific to qì agent.

## Implementation checklist

- [x] Default Qwen semantic tokens and gradient.
- [x] Runtime Qwen theme registry, two-pane code/diff preview, cancel rollback, and host synchronization.
- [x] Responsive scrolling banner and runtime panel.
- [x] Qwen message, reasoning, Markdown, and tool hierarchy.
- [x] Per-step tool batches, deterministic mixed summaries, six-state lifecycle, and real completion/cancellation ordering.
- [x] Animated response/tool indicators, elapsed time, and static approval-wait state.
- [x] Horizontal-rule composer, placeholder, software cursor, loading, queue, and footer.
- [x] Dialog-exclusive controls with preserved history.
- [x] Wide and narrow terminal validation.
- [x] Full component and transport regression suite.

final result: passed
