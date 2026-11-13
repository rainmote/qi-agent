# 独立 UI 回归

页面、样式、交互、会话显示、影响页面的共享代码或构建依赖发生变化时，必须补充对应场景并通过 UI 检查。构建成功、接口测试通过或手工截图不能替代本检查。测试使用生产 Core Preview 页面、真实浏览器和确定性的隔离 API，不需要 Rust、Babashka、Magpie、模型凭据或用户会话。

## 本地入口

```bash
npm ci
npx playwright install --with-deps chromium webkit
npm run test:ui
```

`test:ui` 依次执行 TypeScript 检查、UI 单元测试、测试回执负例和两种浏览器的完整场景。浏览器版本来自 `package-lock.json` 中锁定的 Playwright；CI 不使用系统 Chrome 替代。独立生产构建写入每轮证据目录，不覆盖日常 `apps/web/dist`。

```bash
# 开发时只调试多工具显示；提交前仍需完整 test:ui
npm run test:ui:transcript
# 单引擎诊断 / CI 矩阵入口
npm run test:ui -- --browser webkit --artifacts /absolute/ui-evidence
# 只运行浏览器部分，或使用已打包资源
npm run test:web-headless
npm run test:web-headless -- --suite composer --ui-root /absolute/production-assets
```

单引擎或单套件通过只代表所选范围，不代表完整 UI 验收。默认 `--suite all --browser all`，每个浏览器必须执行 **11 个输入区场景 + 16 个对话过程场景，共 54 个场景**。每个引擎、每套场景限时 180 秒；无自动重试。

## 用例目录

| 文件 | 职责 |
| --- | --- |
| `apps/web/tests/ui-cases.mjs` | 固定场景 ID、窗口尺寸、模式和必需断言名称 |
| `apps/web/tests/fixtures/transcript.mjs` | 七次工具调用、过程回复、最终回复、命令失败后恢复、持续执行事件 |
| `apps/web/tests/transcript-browser.mjs` | 多工具显示、密度、键盘、焦点、折叠、长列表滚动 |
| `apps/web/tests/composer-browser.mjs` | 输入区几何、信任提示、审批、草稿和缩放 |
| `apps/web/tests/headless-e2e.mjs` | 构建、独占浏览器和静态服务、有界清理、指纹与总回执 |
| `apps/web/tests/ui-results.mjs` / `ui-results.test.mjs` | 拒绝缺项、重复、跳过、错误引擎、失败断言、缺图和未确认清理 |

多工具数据根据 2026-11-14 的 Harness / qi-agent / Magpie 对照场景手工构造，保留真实持久化事件形状，包括工具调用消息、结果消息和工具事件。测试确认这些记录不会重复显示同一次调用；不读取本机临时快照或真实供应商配置。

| 场景 ID | 必须保持的行为 |
| --- | --- |
| `transcript-{compact,standard,detailed,verbose}-{1440,390,320}`（12） | 四种模式、三种宽度；七次调用完整且不重复；两段回复保留；桌面工具行 24–25px，窄屏 24–36px；分组跨模型步骤；键盘展开；重新打开分组保留详情；无横向溢出或运行时写入 |
| `transcript-default-live` | 无保存偏好时默认 detailed；运行中的过程平铺，七次调用可访问 |
| `transcript-failure-recovery-320` | `ok:true` 但 `status:error`、exit 127 的命令仍显示失败；折叠摘要、分组和详情一致；后续成功不能抹除失败；八次调用完整 |
| `transcript-focus-settlement` | 流式结束保留原焦点控件；整轮折叠重置子详情；历史分组标题焦点稳定；可重新打开结果 |
| `transcript-scroll-cap-320` | 实际制造超长列表；分组高度不超过 `min(400px,50vh)`；内部可滚动，最后一个工具可点击 |
| `trusted-empty-*`、`restricted-empty-*` | 不同窗口中的完整输入卡、提示、底部状态条和工具栏 |
| `trusted-running-*`、`trusted-pending-*` | 运行中和审批状态保持可操作输入区 |
| `trusted-long-*`、`trusted-resize-*`、`trusted-height-only` | 长草稿、手机、宽度/高度变化后输入区不溢出 |

既有 `test:web-browser:ci` 的八组浏览器回归仍由 CI 的 `Test (ubuntu-24.04)` 执行，覆盖设置、工作区、交互、信任等页面。真实 daemon/worker 的离线 E2E 继续由 `test:web-e2e` 负责；需要端到端运行时验证可运行 `npm run test:ui:e2e`。真实 Magpie / DeepSeek 模型验证属于另行记录的在线集成证据，不作为确定性 UI 测试的数据依赖。

## 证据与失败判定

默认产物：`out/web-headless/<时间-随机ID>/`。每轮保存 `result.json`、构建资源哈希、源码 SHA/dirty、profile、锁文件、控制器/用例/fixture 指纹、平台与浏览器版本，以及 `<engine>/<suite>/result.json`、逐场景截图和失败 trace。可使用 `npx playwright show-trace /absolute/trace.zip` 排查。

只有完整且唯一的场景 ID 集合、完整且为布尔 `true` 的断言、有效截图、零页面错误、正常进程退出及确认清理同时满足时才标记 PASS。失败、缺项、跳过、取消、超时、浏览器缺失和清理不明均返回非零。单个失败后继续保存其他场景结果；不能把未执行项统计为通过。

新增场景时先在 `ui-cases.mjs` 声明稳定 ID 和行为断言，再实现浏览器操作。不得为了通过而删除失败用例、放宽断言或修改期望数。行为变化应明确说明新预期，并先证明测试能识别旧行为；布局修复可对候选外冻结的测试进行故障注入，确认断言确实失败。截图用于复核，布局由几何和交互断言判定，避免跨系统字体像素差异造成噪声。

## CI 与维护门禁

所有 PR 和 main CI 都执行 UI 检查，不按路径跳过。Linux Chromium、macOS WebKit 分别运行完整 UI 入口，`always()` 上传原始日志、截图和失败 trace，保留 7 天。

稳定检查名 **`UI Gate`** 同时依赖 `Test` 和 `Headless UI` 的完整矩阵；失败、跳过或取消任一依赖都会阻止通过。发布检查另明确要求两个浏览器 job 和 `UI Gate` 都属于同一源码提交、同一次 CI attempt 且成功。维护任务修改页面时也须按 `AGENTS.md` 执行完整 UI 入口，并由后续 CI 提供同一提交的证据；历史基线容器检查不因本次新增命令而改写。

仓库分支保护应将 `UI Gate` 设为必需检查。工作流和发布检查代码不能自动配置远端分支保护；本变更不修改 GitHub 规则。验收器、维护规则及发布链改动须单独审查，候选不得借新规则激活、合入或发布自身。
