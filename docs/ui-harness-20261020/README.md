# 2026-10-20 Web UI 像素对照候选

本轮已形成可复核的本地实现，工程门禁通过。严格的“所有页面逐像素一致”验收结果为 **blocked**：原始图像仍有非零差异，真实功能集合、品牌和验收语义也不同。下列比例不是像素通过阈值；没有把这些区域遮罩或从全屏指标剔除。

[打开交互式截图索引](index.html) · [独立复核](readonly-review.md) · [全屏指标](comparison/metrics.json) · [区域指标](comparison/regions.json) · [源码/构建指纹](tested-source.json) · [测试索引](checks/index.json)

## 基线和隔离

- 工作区：geb Mac mini，/Users/geb/Documents/Codex/2026-10-19/task-2/qi-agent；分支 codex/web-deepseek-harness-20261019。
- 本轮基线：315860136df47f896ad61268ff29b408c2103351。旧证据 docs/ui-harness-20261019 原样保留。
- 官方参考：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)，SHA 687f282e8625c6b8d11ff58211a90524be2e4317，0.2.1-rc.2。交付前再次用无凭据 ls-remote 核对仍为该 HEAD，见 reference.json。
- 先核对 AGENTS、LESSONS、Web/架构/工作区文档及贡献要求，并应用 Product Design 的截图对照/QA、官方客户端 UI 与响应式技能。只由主代理写入，复核者只读；没有修改其他工作区、NAS、main 或旧候选 8ef3ca4。
- 依赖与脚本先检查后运行；本轮无新依赖、无外部模型调用。原隔离策略保持不变：禁止测试读取 Codex/SSH/AWS/钥匙串、真实 Chrome 配置、NAS；仅允许 localhost 出站，使用临时 qi 状态和独立浏览器配置。
- 所有预览、官方 scaffold、真实后端 E2E 服务均为本任务新建并由测试清理。没有 push、PR、部署、重启既有服务、修改凭据或网络/系统权限。

## 同条件真实浏览器证据

官方使用实际构建和官方隔离 scaffold、公开录制会话；候选/3158601 使用相同语义内容的确定性 qi API fixture。静态 fixture 用于视觉对照；真实后端另由 Web Host → Rust daemon → Babashka Worker 的离线 E2E 验证，不能相互替代。

同一 Chrome 155.0.8059.85、DPR 1、zh-CN、UTC、固定时钟 2026-10-20T09:00:00Z、相同视口和浅/深主题、同系统字体与官方 Montserrat，等待字体/两帧渲染/350ms 稳定。静态页面中性焦点归一化，两边菜单保留焦点，另以功能测试验证键盘焦点。没有注入样式修改参考界面。官方 26、候选 34、冻结旧候选 14 个状态；源与候选都有逐图 DOM 几何和 manifest。菜单截图断言菜单仍打开，思考有两层真实展开状态。新增两组模式菜单保留各自真实预设集合：官方4种，qi使用仓库3种和实际说明，因此这两组内容不完全同态，不伪装成相同功能。

26 组原尺寸并排、50% 叠加及差异热图均在 comparison/。全屏指标计算原始 RGB 的严格相等、非零像素数和 MAE；Δ>16 比例仅用于诊断，绝不是通过阈值。不排除任何像素，全部 26 组 exact_equal=false。差异图仅显示放大 4 倍。另有 45 个明确矩形的控件诊断，均不从全屏指标中剔除。两侧原图尺寸完全相同；并排图额外有 32px 标签栏。

| 状态 | 旧候选全屏非零像素 % | 当前全屏非零像素 % | 当前卡片非零像素数 |
| --- | ---: | ---: | ---: |
| new-session-light-1440 | 6.41312 | 0.28097 | 0 |
| new-session-dark-1440 | 6.24868 | 0.37215 | 1312 |
| new-session-light-1024 | 10.14364 | 0.45010 | 0 |
| new-session-light-768 | 9.59469 | 0.30084 | 0 |
| new-session-light-390 | 25.09509 | 0.57632 | 0 |
| new-session-light-320 | 29.62604 | 0.70238 | 0 |
| conversation-light-1440 | 10.23153 | 0.91417 | 59 |
| settings-light-1440 | 37.47542 | 3.14687 | 5016 |
| settings-light-390 | 47.17615 | 2.36086 | 296 |

## 实现变化

- 对齐主题灰阶、字体、抗锯齿、行高、间距、圆角、边框、阴影和非品牌 SVG。桌面 280px 侧栏、窄屏 56px rail 与展开导航可用；恢复真实 preset 标记、子任务入口及工作区新增图标。
- 首页输入卡片在 1440/1024/768/390/320px 的 x/y/宽/高实测全部为零差；浅色卡片区域原始像素全部一致。旧候选同一 0.1 CSS px 几何门禁失败，geometry-baseline.json / geometry-candidate.json 保留 red/green。深色桌面卡片仍有最大通道差 1 的非零像素，不记像素通过。
- 会话输入区实测为 98px；首页 114px，空文本输入高度 36/52px，长草稿上限 336px。可见发送按钮 34px、添加按钮 28px；用透明命中区保留至少 44px 的操作目标，并做真实点击命中检查。
- 对齐用户气泡、过程行、思考行、bash 摘要和最终正文。桌面同内容下 process y228/h33、思考按钮 y277/h20、Reading 段 y309、bash 摘要 y345/h20、DONE 段 y377 对照一致。思考按官方呈现“已完成分析 → 思考/首行预览 → 正文”两层折叠，bash 保留两层参数/结果披露。
- 模型选择改为同一张卡片中的层级切换；模型/推理等级、provider 分组、官方模糊匹配排序、搜索、选中样式和键盘导航接入现有真实回调。Escape/Shift+Tab 先返回，搜索方向键保持输入焦点，Tab 接受当前项；多模型与单模型均回归。
- 菜单采用参考的外层、背景材质层及滚动层，portal 到 body；点击边界同时识别触发区和菜单。移除会让文字亚像素漂移的进入 transform。设置内 Tab/Shift+Tab 关闭菜单后正常移动并留在模态内，未顺便选择权限。
- 设置公共行、Medium 主题图标及字号步进器与源布局对应；保留直接输入与 10–22 范围、失焦恢复、持久化。权限仍按当前会话真实策略；Full Access 仍必须明确风险确认。修复内层 Escape、叠置模态、取消后焦点返回、权限拒绝后的回滚/再次确认，以及打开设置后导航遮罩残留。
- 修复新会话重载后立即后退的启动竞态：初次路由订阅前错过的 popstate 只补偿一次，并用允许目录中的语义路由校验初次 open 的迟到响应。合法 A/B 切换、同 A 的 hash 参数换序、非法目标都不追加历史或重放提交；正常导航范围和目录校验保留。
- 顶栏会话菜单接入现有重命名/分支/归档动作；取消重命名与 Escape 返回焦点，不触发发送或导航。
- 工作区/模式一行按参考的普通文本和独立按钮压缩，修复 native select 字形、宽度和窄屏分配。模式菜单使用原有真实预设和说明，选择只更新草稿模式，创建时仍传原 presetId。1440/320px 下取消、方向键/Enter、Tab、重复点击、零提交及焦点返回均回归；真实 E2E 通过该菜单选择离线 preset 后验证信任/审批/写入链路。
- 快捷任务、工作台、插件、自动化、附件、工具原始内容、子任务真实返回及“完成≠验收”均可访问。api.ts、Host/daemon/Worker 协议、command_id、未知结果先核对、审批和停止去重链路未改。显示偏好不授权操作。
- MIT/OFL 及来源声明随源码和 dist/licenses/ 分发；保留 qi 标识，未复用 DeepSeek 商标冒充官方产品。

## 验证结果与边界

| 检查 | 结果 |
| --- | --- |
| npm run typecheck / npm run web:build | 通过；保留 Vite >500kB 包体提示，JS 593.66kB / gzip180.27kB；三份字体共约185.7kB |
| npm run test:web-ui | 75 通过，0 失败/取消/跳过 |
| npm run test:web-browser:ci | 通过；pageErrors=[]；含重复提交、丢响应/恢复、停止、会话竞态、后退/前进、离开/返回、单/多模型、IME、取消、模态、两层思考、子任务及 320–1440px |
| 真实本地后端 interaction-e2e | 8 通过，0 失败/取消/跳过；真实文件写入在信任和批准后发生，外部模型调用0 |
| 官方/候选/旧候选截图 | 26 / 34 / 14；捕获脚本退出0，无页面异常 |
| 首页五视口几何 | baseline red；candidate green；实测全部0差，检查容差0.1 CSS px |
| 本地截图索引 | 独立Chrome逐项加载26状态、144张原图/对照视图；12个缺失旧候选入口禁用，页面异常0；见gallery/results.json |
| 独立只读复核 | 见 readonly-review.md；不冒充复核者重新执行测试 |
| 广义 Host / 维护控制器全测 | 本轮未重跑。上一轮基线和候选均82通过/3失败，原因是隔离拒绝 /bin/ps；此项仍未验证，不记全绿 |

checks/intermediate/ 保留真实历史重载失败及修复前确定性 bootstrap red。此前“门禁全绿可归档”的复核结论在发现该失败时撤回；不能用早先终审覆盖新失败。修复后 4 组确定性启动竞态、桌面/移动重载立即后退、离开返回、目录挂起及旧目录响应均通过。最终本地提交后重跑完整浏览器和真实 E2E，结果写入[本任务提交后收据](/Users/geb/Documents/Codex/2026-10-19/task-2/pixel-20261020/postcommit/receipt.json)，不回写 Git，从而保持被测提交及已归档证据不变；收据绑定实际提交、84项源码、9项构建及 runtime/profile/控制器指纹。最终结果以收据实际退出码为准，不预记通过。

同目录还保留新增焦点帧断言、模型搜索 Tab 误命中、参考思考定位及真实 E2E 按钮省略号定位失败。最终脚本修正后通过；采集/定位失败不是产品通过证据。几何 red 来自冻结的真实旧候选。未把旧 failure.png 当成本轮通过截图。

12:21 的一批执行会话在完成前消失；类型和UI75有完整收据，浏览器/真实E2E/采集仅有部分或空日志，明确记为 incomplete、exit_code=null。其旧 JSON 收据早于新日志，不属于该次执行，未记通过。确认任务端口释放后，按原隔离重跑这三项。run-check.py 现在启动前先写 running/null，完成后才写真实退出码；最终索引只接受完整 exit0。

## 补充实际界面及未验证项

reference-extra/ 来自官方公开 live-interactions 录制重放：实际子任务、弹层、窄屏、无工作区、等待连接和断开传输状态。候选 extra-* 为 qi 真实数据结构的隔离 fixture。它们的任务状态/描述符/时间不完全同态，仅作人工功能与视觉核对，不计算伪精确的跨图像素比例。

保留 replay-exhausted-* 是官方录制耗尽的实际错误界面；不是生产网络失败的验证。正常重放 liveProviderCalls=0。断开 WebSocket 后的官方短时画面保留最后内容，不能声称已验证真实离线/鉴权失败错误页。

未验证：官方真实在线模型流式生成/审批执行/子任务调度全链路，官方 Full Access 风险框的全部状态、账户登录、完整设置模型/插件/Agent预设编辑、全部会话上下文菜单、附件各格式和工具种类；物理手机软键盘/安全区、Electron、Safari/Firefox 及其他 DPR。qi 的离线真实 E2E 不替代这些验证。

## 残余差异与严格验收结论

- 身份：qi 名称和标记与 DeepSeek 的商标不同，保留在所有无遮罩指标中。早先将320px模型菜单背景残差归因于品牌的解释证据不足，已撤回；修正其下方工作区/模式行后，该区域最大通道差从67降至1，说明可修布局确实影响背景模糊。其余非零像素未归因于品牌或后端。
- 真实业务：qi 明确显示“运行完成·尚未验收”、子任务 provider/id/返回，统计为真实轨迹和工具时长；官方赞踩、分享、token/缓存/速度数据缺少等价 qi 协议，未伪造。
- 设置/模式：当前会话权限与官方新会话默认权限不同；qi 仅支持中文，保留真实工作区管理、插件/工具设置。模式菜单保留真实的标准/创造/生产只读模式；没有捏造官方PTC/极简模式。官方配置文件、预设编辑、遥测、快捷键、繁忙时发送方式及各角色字体设置没有等价功能，其内容、分类图标和滚动高度仍不同。没有渲染无实现的字体展开按钮。官方320px模式菜单实拍还出现负x裁切，候选菜单保持12px边界和可操作，这一差异明确保留而不冒充源像素一致。窄屏设置保留参考双栏框架，不等于实机可用性已穷尽。
- 折叠：思考与 bash 的共有状态已同层级；qi 各工具原始参数、失败/缺失结果及未确认状态仍显示，子任务结果披露与官方描述符不同。不能笼统宣称所有工具/子任务像素一致。
- 静态：桌面权限/工作区/模型菜单边缘各剩1个像素、最大通道差1；320px 模型菜单1925像素、深色桌面输入卡片1312像素、字号数值40/12像素，最大通道差均为1。主题太阳图标在浅/深色分别仍有最大通道差17/8，其他主题按钮边缘也有非零差。static-residual-audit.json 与两侧逐图SVG证明太阳图标的实际路径、描画属性、采样样式及几何已对应，但不能证明最终栅格一致。这些不是必要的后端功能差异，原因未完全定位，继续作为明确的视觉阻碍。没有放宽阈值、修图或遮罩来宣布一致。

因此本地候选和工程验证已完成，完整像素目标仍为 blocked，未获得“全屏像素一致”接受结论。没有发布该候选。

## 明确区域诊断

下面按实际 DOM 矩形裁切，包含所有部分边缘像素；固定会话列表矩形另作标记。32/45个区域严格相等不能代表整页相等。字号、主题与窄屏模式行最后一轮修正前图在 refinements-before/；对照原始数值而不只看肉眼。

| 状态 / 区域 | 非零像素 | 最大通道差（0–255） | DOM 几何差 x/y/w/h |
| --- | ---: | ---: | --- |
| [new-session-dark-1440 / input-card](comparison/regions/new-session-dark-1440-input-card.png) | 1312 | 1 | 0.0/0/0.0/0 |
| [new-session-dark-1440 / title-and-badge](comparison/regions/new-session-dark-1440-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-dark-1440 / workspace-chip](comparison/regions/new-session-dark-1440-workspace-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-dark-1440 / preset-chip](comparison/regions/new-session-dark-1440-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-dark-1440 / session-list](comparison/regions/new-session-dark-1440-session-list.png) | 0 | 0 | 固定诊断矩形 |
| [new-session-dark-390 / input-card](comparison/regions/new-session-dark-390-input-card.png) | 0 | 0 | 0/0/0/0 |
| [new-session-dark-390 / title-and-badge](comparison/regions/new-session-dark-390-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-dark-390 / workspace-chip](comparison/regions/new-session-dark-390-workspace-chip.png) | 0 | 0 | 0/0/0.0/0 |
| [new-session-dark-390 / preset-chip](comparison/regions/new-session-dark-390-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1024 / input-card](comparison/regions/new-session-light-1024-input-card.png) | 0 | 0 | 0/0/0/0 |
| [new-session-light-1024 / title-and-badge](comparison/regions/new-session-light-1024-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1024 / workspace-chip](comparison/regions/new-session-light-1024-workspace-chip.png) | 0 | 0 | 0/0/0.0/0 |
| [new-session-light-1024 / preset-chip](comparison/regions/new-session-light-1024-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1024 / session-list](comparison/regions/new-session-light-1024-session-list.png) | 0 | 0 | 固定诊断矩形 |
| [new-session-light-1440 / input-card](comparison/regions/new-session-light-1440-input-card.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1440 / title-and-badge](comparison/regions/new-session-light-1440-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1440 / workspace-chip](comparison/regions/new-session-light-1440-workspace-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1440 / preset-chip](comparison/regions/new-session-light-1440-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-1440 / session-list](comparison/regions/new-session-light-1440-session-list.png) | 0 | 0 | 固定诊断矩形 |
| [new-session-light-320 / input-card](comparison/regions/new-session-light-320-input-card.png) | 0 | 0 | 0/0/0/0 |
| [new-session-light-320 / title-and-badge](comparison/regions/new-session-light-320-title-and-badge.png) | 0 | 0 | 0/0/0/0 |
| [new-session-light-320 / workspace-chip](comparison/regions/new-session-light-320-workspace-chip.png) | 0 | 0 | 0/0/0.0/0 |
| [new-session-light-320 / preset-chip](comparison/regions/new-session-light-320-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-390 / input-card](comparison/regions/new-session-light-390-input-card.png) | 0 | 0 | 0/0/0/0 |
| [new-session-light-390 / title-and-badge](comparison/regions/new-session-light-390-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-390 / workspace-chip](comparison/regions/new-session-light-390-workspace-chip.png) | 0 | 0 | 0/0/0.0/0 |
| [new-session-light-390 / preset-chip](comparison/regions/new-session-light-390-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-768 / input-card](comparison/regions/new-session-light-768-input-card.png) | 0 | 0 | 0/0/0/0 |
| [new-session-light-768 / title-and-badge](comparison/regions/new-session-light-768-title-and-badge.png) | 0 | 0 | 0.0/0/0.0/0 |
| [new-session-light-768 / workspace-chip](comparison/regions/new-session-light-768-workspace-chip.png) | 0 | 0 | 0/0/0.0/0 |
| [new-session-light-768 / preset-chip](comparison/regions/new-session-light-768-preset-chip.png) | 0 | 0 | 0.0/0/0.0/0 |
| [permission-menu-light-1440 / menu](comparison/regions/permission-menu-light-1440-menu.png) | 1 | 1 | 0.0/0/0/0 |
| [workspace-menu-light-1440 / menu](comparison/regions/workspace-menu-light-1440-menu.png) | 1 | 1 | 0.0/0/0/0 |
| [model-menu-light-1440 / menu](comparison/regions/model-menu-light-1440-menu.png) | 0 | 0 | 0.0/0/0/0 |
| [model-options-light-1440 / menu](comparison/regions/model-options-light-1440-menu.png) | 1 | 1 | 0.0/0/0/0 |
| [model-options-light-390 / menu](comparison/regions/model-options-light-390-menu.png) | 0 | 0 | 0/0/0/0 |
| [model-options-light-320 / menu](comparison/regions/model-options-light-320-menu.png) | 1925 | 1 | 0/0/0/0 |
| [settings-light-1440 / appearance-light](comparison/regions/settings-light-1440-appearance-light.png) | 108 | 17 | 0/0/0.0/0 |
| [settings-light-1440 / appearance-dark](comparison/regions/settings-light-1440-appearance-dark.png) | 77 | 1 | 0.0/0/0.0/0 |
| [settings-light-1440 / appearance-system](comparison/regions/settings-light-1440-appearance-system.png) | 76 | 1 | 0.0/0/0.0/0 |
| [settings-light-1440 / font-size-stepper](comparison/regions/settings-light-1440-font-size-stepper.png) | 40 | 1 | 0.0/0/0/0 |
| [settings-dark-1440 / appearance-light](comparison/regions/settings-dark-1440-appearance-light.png) | 227 | 8 | 0/0/0.0/0 |
| [settings-dark-1440 / appearance-dark](comparison/regions/settings-dark-1440-appearance-dark.png) | 16 | 1 | 0.0/0/0.0/0 |
| [settings-dark-1440 / appearance-system](comparison/regions/settings-dark-1440-appearance-system.png) | 341 | 1 | 0.0/0/0.0/0 |
| [settings-dark-1440 / font-size-stepper](comparison/regions/settings-dark-1440-font-size-stepper.png) | 12 | 1 | 0.0/0/0/0 |

## 全部配对结果

| 状态 | 全屏非零像素 % | 全屏 Δ>16 %（诊断） | MAE (0–255) |
| --- | ---: | ---: | ---: |
| [account-menu-light-1440](comparison/account-menu-light-1440-side-by-side.png) | 0.97986 | 0.58944 | 0.56480 |
| [conversation-light-1440](comparison/conversation-light-1440-side-by-side.png) | 0.91417 | 0.53167 | 0.51548 |
| [model-menu-light-1440](comparison/model-menu-light-1440-side-by-side.png) | 0.92361 | 0.53993 | 0.52017 |
| [model-options-light-1440](comparison/model-options-light-1440-side-by-side.png) | 0.90625 | 0.53993 | 0.52000 |
| [model-options-light-320](comparison/model-options-light-320-side-by-side.png) | 1.37885 | 0.38618 | 0.60385 |
| [model-options-light-390](comparison/model-options-light-390-side-by-side.png) | 0.57632 | 0.31687 | 0.49642 |
| [new-session-dark-1440](comparison/new-session-dark-1440-side-by-side.png) | 0.37215 | 0.26576 | 0.30681 |
| [new-session-dark-390](comparison/new-session-dark-390-side-by-side.png) | 0.57692 | 0.31687 | 0.48271 |
| [new-session-light-1024](comparison/new-session-light-1024-side-by-side.png) | 0.45010 | 0.33115 | 0.52188 |
| [new-session-light-1440](comparison/new-session-light-1440-side-by-side.png) | 0.28097 | 0.19750 | 0.31487 |
| [new-session-light-320](comparison/new-session-light-320-side-by-side.png) | 0.70238 | 0.38618 | 0.60500 |
| [new-session-light-390](comparison/new-session-light-390-side-by-side.png) | 0.57632 | 0.31687 | 0.49643 |
| [new-session-light-768](comparison/new-session-light-768-side-by-side.png) | 0.30084 | 0.16862 | 0.27257 |
| [permission-menu-light-1440](comparison/permission-menu-light-1440-side-by-side.png) | 0.91444 | 0.53993 | 0.52007 |
| [preset-menu-light-1440](comparison/preset-menu-light-1440-side-by-side.png) | 4.74278 | 1.17910 | 0.89457 |
| [preset-menu-light-320](comparison/preset-menu-light-320-side-by-side.png) | 25.22845 | 6.32516 | 4.16036 |
| [process-open-dark-1440](comparison/process-open-dark-1440-side-by-side.png) | 1.27687 | 0.70931 | 0.59655 |
| [process-open-light-1440](comparison/process-open-light-1440-side-by-side.png) | 0.92361 | 0.53993 | 0.52017 |
| [reasoning-body-open-light-1440](comparison/reasoning-body-open-light-1440-side-by-side.png) | 0.91840 | 0.53465 | 0.51717 |
| [reasoning-open-light-1440](comparison/reasoning-open-light-1440-side-by-side.png) | 0.92139 | 0.53521 | 0.51750 |
| [settings-dark-1440](comparison/settings-dark-1440-side-by-side.png) | 3.18785 | 1.68687 | 1.41254 |
| [settings-dark-390](comparison/settings-dark-390-side-by-side.png) | 2.36177 | 1.19607 | 1.10426 |
| [settings-light-1440](comparison/settings-light-1440-side-by-side.png) | 3.14687 | 1.69396 | 1.54903 |
| [settings-light-390](comparison/settings-light-390-side-by-side.png) | 2.36086 | 1.22585 | 1.25236 |
| [tools-open-light-1440](comparison/tools-open-light-1440-side-by-side.png) | 1.03882 | 0.63500 | 0.58678 |
| [workspace-menu-light-1440](comparison/workspace-menu-light-1440-side-by-side.png) | 0.29826 | 0.19750 | 0.31500 |

## 复核/重算

已提交的截图可离线重算，无需启动服务或访问网络。在本目录运行：

    python scripts/compare-pixels.py .
    python scripts/compare-pixel-regions.py .
    python scripts/check-pixel-geometry.py candidate .

Pillow 用于原始像素计算。capture-pixels.mjs、官方两份 scaffold 测试、run-check.py 和原 isolation.sb 作为运行证据保留；它们记录本次任务根及依赖位置，不是可在任意宿主无审查直接启动的安装脚本。重新捕获时应在相同版本的隔离 sibling checkout 中检查这些路径和依赖，使用记录的命令；不会自动下载模型、读取真实浏览器配置或启动既有服务。
