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
- Copy and content: Qwen's placeholder, Tips line, model-change hint, dialog help, and busy/abort affordances are preserved. Product identity and mock response text intentionally remain bb-agent-specific.
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

- Migration: added `apps/tui-rs`, a Rust 2024/Ratatui frontend that reuses the existing JSONL bridge and leaves the Babashka runtime boundary unchanged. The default and offline mock profiles now launch its release binary; React/Ink remains an explicit compatibility fallback.
- Visual contract: Ratatui `TestBackend` renders deterministic 160 × 44 and 80-column buffers. Tests cover the wide wordmark/runtime panel, narrow breakpoint, Tips/history hierarchy, double-rule composer, software cursor, footer, dialog-exclusive control region, two-pane theme preview, semantic tool aggregation, multiline input, slash suggestions, queue and extension slots.
- Interaction contract: state-machine tests cover grapheme editing/history, idle submit, busy steer, `Ctrl+Q` follow-up, abort/exit, model/session/tree/theme selection, approval navigation, required input/custom JSON validation, durable-event deduplication, streaming projection and monotonic tool completion.
- Cross-implementation result: the legacy TypeScript baseline remains green at 109 TUI tests. The initial Rust replacement passed 23 projection/interaction/UI tests under strict `clippy -D warnings`, and the Babashka bridge suite remained green at 70 tests and 544 assertions, proving that switching the child command did not change host behavior.
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
the TypeScript/Ink implementation being replaced in this repository.

- P3: the checked-in Qwen source screenshot is from v0.19.2 and contains different session content. Current component source was used to resolve later token and layout behavior, but an upstream current-version idle screenshot would make future pixel diffs more exact.
- P2: Qwen can show token/rate telemetry in the wide loading row. The current host protocol does not publish those values, so the Rust frontend cannot display them yet.
- P3: the action-tool output safety cap is applied per tool instead of sharing one constrained budget across all sibling tools; expanded mode still exposes each complete result.
- Expected difference: the wordmark, product title, version, provider, model, path, and transcript content remain specific to bb-agent.

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
