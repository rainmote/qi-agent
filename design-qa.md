<!-- qi-agent-harness-trust-20261021 -->
# 2026-10-21 项目信任交互 QA

**final result: blocked**（严格官方同状态像素认证）。项目可信交互已形成可审候选；这不豁免下述未验证，也不修改历史严格结果。

- 源视觉：`docs/ui-harness-trust-20261021/reference/` 的同687f282实际工作区、权限和设置截图，1440×1000与390×844、DPR1。源码/公开HEAD再次核实一致。新增官方目录准入/风险确认实拍因自动审批两次拒绝而未执行，等待明确范围授权；在检查范围没有找到与qi持久目录allow/deny等价的专门弹窗。
- 实现截图：`candidate/trust-first-entry-1440.png`、`trust-manage-trusted-1440.png`、`trust-inherited-390.png`、`trust-inherited-320.png`、`trust-english-dark-390.png`、真实Host/daemon/离线worker的`trust-real-inherited-390.png`，均在上述报告目录。24张候选PNG保留原尺寸和未遮罩内容。
- 视口/密度：桌面1440×1000、移动390/320×844，Chrome155.0.8059.85、DPR1；原图无缩放。qi原基线未记录IANA时区，因此另捕获固定基线时钟、匹配+08显示的候选，保留UTC原图并明确元数据缺口，不认证完全同环境。不同内容的官方/qi图片只定性比较。
- 全屏联合比较：`comparison/settings-source-vs-qi.png`、`related-source-vs-trust.png`、`before-after-trusted.png`，实际把两图合在同一画面读取；同时保留原图、透明叠加及原始差异。焦点区域`comparison/settings-focus.png`为原尺寸裁取的权限/信任/语言行，仅补充可读性，不从全图中排除差异。

## 五个视觉表面

1. 字体：继承官方系统字体链与源图标，项目路径用12px/1.6等宽字，正文13px/1.6、状态12px，中文/英文和长路径换行实拍可读；没有把路径截断成不可核对内容。官方无对应信任弹窗的字体/行高目标，不能给该组件逐像素认证。
2. 布局：560px信任弹窗、目录卡片、继承来源、按钮均使用现有tokens；可取消只读加载、持久选择与返回设置可操作。新增状态行在输入卡片上方；真实E2E发现180px卡片回归后已修，保留<165旧断言。390/320边界、完整路径与44px触达通过。设置新增信任一行明显下移后续内容，是实际功能差异，未隐藏。
3. 颜色：浅/深色使用既有surface/text/border/accent/danger tokens，撤销文字使用语义危险色，禁用/加载/错误状态可辨；没有另造品牌色。官方设置的开启开关等既有残差继续存在，未因本轮合理改造宣布严格通过。
4. 图像/资产：使用已带MIT声明的官方目录/盾牌/关闭等图标与qi实际品牌，没有生成、近似绘制或截图替代交互组件；路径/状态都是运行API数据。截图组合不改动原图内容。
5. 文案：首次进入、发送、管理三种目的分开；说明信任不绕过权限/人工审批、父目录继承及未单设子目录范围；撤销只为当前目录设deny、不删父设置或撤回已执行操作。固定profile/缺失能力如实显示。官方默认权限语义与qi目录信任不同，不改标签假冒。

## 迭代与复核

原可信入口0≠1失败；关闭目标不足44px失败；真实卡片高度180px失败；独立只读复核六项UI/API恢复和焦点问题均有确定性red/green。最后冻结12文件匹配`b2e8e9cd52654f3345b7f50a86d078fe3bdced6f9d6715af339363bb1d7bc6cc`，独立复核在所审范围未发现剩余P0/P1/P2。类型、UI88、信任浏览器12组、构建已有通过，最终提交后回归另见任务根`trust-20261021/postcommit/receipt.json`。

**仍阻塞/未验证**：官方新增准入/风险确认实拍缺失，官方没有已验证的同语义信任弹窗目标，上一轮13处栅格残差未消除；广义Host85项82过3失败未关闭。真实手机键盘/安全区、其他浏览器/DPR、官方在线模型/账户与跨进程信任库并发写入未验证。工程候选不等于严格像素或全部测试通过。

[完整范围、失败/通过日志](docs/ui-harness-trust-20261021/README.md) · [可查看原图与叠加](docs/ui-harness-trust-20261021/index.html) · [独立复核](docs/ui-harness-trust-20261021/readonly-review.md)。

---

# 2026-10-20 严格像素对照候选 — BLOCKED

当前分支基线 `315860136df47f896ad61268ff29b408c2103351`；官方参考再次核实为 `687f282e8625c6b8d11ff58211a90524be2e4317`。本轮工程门禁通过，**严格全屏像素一致仍 blocked**。下方旧轮次的 passed 仅是历史范围，不能作为本轮严格验收结论。

[完整报告](docs/ui-harness-20261020/README.md) · [可切换并排/叠加/原图索引](docs/ui-harness-20261020/index.html) · [全屏原始指标](docs/ui-harness-20261020/comparison/metrics.json) · [区域诊断](docs/ui-harness-20261020/comparison/regions.json) · [独立只读复核](docs/ui-harness-20261020/readonly-review.md) · [测试与源码指纹](docs/ui-harness-20261020/tested-source.json)。

同 Chrome、DPR 1、字体、主题、视口与固定语义内容下：官方26、候选34、旧候选14张。首页浅色输入卡片五个视口的几何及原始像素一致；这不代表整个页面一致。新增模式菜单保留各自真实预设，官方4种、qi3种，内容差异明确计入。整屏指标无遮罩、无排除，26组原图仍有非零像素。品牌与真实后端功能差异、未定位的边缘/图标描边栅格残差及未验证的官方状态分别记录，不用百分比放宽验收。

新会话重载后立即后退的失败和确定性修复前 red 已保留，早先可归档判断撤回。修复后类型、构建、75项UI、8项真实后端E2E和完整浏览器回归通过，提交后相关回归须另见最终交付收据。协议、command_id 幂等性、权限及人工审批边界保持，未推送或发布。

---

# 2026-10-19 Design QA — Harness 对照改造（历史）

参考固定为 `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`；实现基线为 qi-agent `d3173b5f01b86565bf300d54b7b24ea9d14d6060`。完整说明见 [对照报告](docs/webui-harness-comparison.md)。

后续历史导航补测及最小修复：[范围与结果](docs/ui-harness-20261019/history-followup/README.md)、[当前源码指纹](docs/ui-harness-20261019/history-followup/tested-ui-source.json)。初次证据及下方基线历史记录保留；“浏览器回归通过”仅限现有 Chrome 脚本实际覆盖的场景。

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

官方真实模型的流式/审批/子任务交互未实测；物理手机键盘与安全区、Electron及其他浏览器未验证。历史按钮已补测桌面/移动基本路径和目录挂起，旧目录覆盖仅桌面验证，详见后续报告。广义 Host 测试仍有 3 项隔离环境失败，冻结基线相同；设计 QA 通过不等于完整维护控制器验收 PASS 或发布批准。

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
