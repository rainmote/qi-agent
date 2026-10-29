# Web / Codex 真实链路验证 · 2026-10-29

状态：独立待审候选；本轮 Web 核心流程与真实 Codex 验收已完成，不宣称完整 DeepSeek 功能等价。基线 `9d191214f386f0700b8fb5cf1ebcc9a5f9896ece`。
本次修复前端状态投影、默认子代理配置与消息生命周期，后续真实浏览器复验又修复常驻会话标题恢复与私有 Host 冷重启。冷重启涉及 daemon 生命周期，已单独审查；没有修改权限策略、维护规则或发布链。未合入、发布。

## 已修复

1. 后台超时裁定将同一 run 的 `completed` 更正为 `uncertain` 时，Web 曾丢弃更正，仍显示“运行完成”并自动折叠过程。现在识别 Rust `host_arbitrated` 和 Clojure `host-arbitrated`，在原位置更新唯一结果行，保留所有原始事件；晚到普通终态不能覆盖裁定。
2. 清空会话后，后续状态通知携带旧 `last-outcome` 会使旧结果重新出现。现在保留已清空 run 的身份，覆盖仅有临时状态、乱序事件、迟到 clear 和重新加载；有明确 clear 后事件的新 run 正常显示。历史修正也不会覆盖较新 run 的状态。
3. 默认、standard 和 creator 的子代理 profile 缺少 `auth/store`，真实委派在模型请求前即因 provider-settings 依赖缺失而失败。三个子 profile 现在装配现有 auth-store；未增加工具、复制凭据或改变认证实现。
4. daemon 转发给已完成子代理的消息绕过了注册表的 completion watcher：子代理已经生成新回答，但 `subagent.status` 仍返回旧 run 和旧结果。现在该入口复用消息生命周期，保留其他 provider/RPC 的原有转发，且不重复记录 daemon 已负责写入的发送日志。
5. 重复 inbox 回执，以及普通排队回执与任务完成相遇时，曾把终态改回 `running`。重复回执现在不修改任务与日志，排队消息沿用现有 watcher。迟到的新消息回执也不能复活已停止或删除的子代理。

6. 常驻会话重开时直接返回创建时缓存的 summary，导致刷新后标题变为“未命名会话”。现在在快照后刷新持久元数据，保留预设与同一 worker，重新校验访问授权，并拒绝同路径文件被替换成另一会话后的身份混用。
7. 指定 stateDirectory 的私有 Web Host 关闭时曾将会话归档，立即重启后 open 因 agents.session_path 唯一约束失败。现在关闭显式保留可恢复会话，核对实例绑定的清理回执后才删除 runtime；关闭期间拒绝新 HTTP 请求并禁止启动替代 daemon。缺省 CLI 显式停止、已经停止/归档的记录保持原语义；失败/未知结果保留现场，历史关闭回执不能停止新实例。

候选外冻结的首批 6 项断言在原实现全部失败，修复后通过；独立复核发现的边界也保留失败记录。仓库新增 10 项回归，独立只读复核确认本轮已发现问题均修复。中间曾出现测试文件类型/合并错误，已修正，未计作有效 red。

子代理补充了候选外冻结的 5 项测试、70 个断言：profile 缺依赖、重复消息、daemon 转发、排队/完成竞态及停止/删除竞态均保存有效 red/green。竞态使用确定性的内存交错，不声称是真实浏览器或 provider 并发验收。配置与生命周期改动另外进行了只读复核。

## 真实在线链路

前期通过本机 HTTP API / SSE 使用生产 Web Host → 隔离 Rust daemon → 真实 Babashka worker → 已有 Codex 登录。以下早期结果与随后实际浏览器验收分别记录。

- 官方订阅目录返回 8 个模型；刷新后保留当前模型和推理强度。
- `gpt-5.6-sol` 真实回复，第二轮读取隔离样例文件 `hello.txt`，正确返回 `BLUE-742` 并记住前轮结果 `56`。
- 读取过程中收到 53 个 `llm/stream` 事件，工具调用与结果成对、终态完成。
- 运行时排队消息得到 `QUEUE-OK`；停止实际运行得到 `cancelled`，重新打开保留取消状态和 70 条事件。
- 清空后真实下一轮确实携带旧 `last-outcome`；候选投影没有复活旧结果，新回答 `CLEAR-OK` 只有一个结果行。
- 文本附件正确读出 `ATTACHMENT-PURPLE-593` 和数量 `17`。
- 真实 write 审批：拒绝后文件不存在；单次允许后才创建指定内容。测试结束恢复隔离项目的原策略与信任状态。
- 子代理实际调用 read 读取 `hello.txt`，返回 `CHILD_OK` 与文件内容。父任务、子任务 JSONL、工具结果和子任务终态分别保留。
- 通过公开 `agent.message.send` 重现并修复旧结果问题；新回合返回 `CHILD_FOLLOWUP_COPPER_461`，注册表更新 run-id/result，SSE 收到 start/end。重放同一 commandId 的回执、子会话和任务状态保持一致。
- 在真实模型运行中调用 `turn.steer`，插话被消费，最终返回 `STEER_GREEN_882`，仍只有一个 run 的 start/end。

测试项目、信任库、Web 状态与 daemon 单独隔离。登录凭据未打印、复制或提交；测试程序通过已有适配器使用原登录。

## 实际浏览器复验

使用仓库 Playwright 的隔离 Chromium 156.0.8078.4，真实生产前端、Host、Rust daemon、Babashka 和已有 Codex 登录。未再使用或排查桌面操作工具。

- 真实网页读取 `hello.txt`，返回 `WEB_BROWSER_OK BLUE-742`；修复后新会话回答 `TITLE_REFRESH_OK BLUE-742`，刷新保留正确标题、消息与终态。
- 浏览器上传 `browser-proof.txt` 后返回 `AMBER-816 23`。工作区文件侧栏实际预览 `hello.txt`；字号设置修改后刷新仍保留，并恢复原值。
- 通过网页点击 Deny 后目标文件不存在；点击 Allow once 前文件仍不存在，之后才写入 `BROWSER_ALLOW_TEAL_492`。测试结束恢复隔离项目的权限与信任设置。
- 运行中 Enter 排队成功返回 `BROWSER_QUEUE_SUCCESS_583`；Ctrl+Enter 插话后返回 `BROWSER_STEER_VIOLET_927`；点击停止得到 `cancelled`，刷新仍显示取消结果。
- 另一次故意重复读取相同文件触发 no-progress，已记录 failed 和 queue/discarded；未计作成功排队验收。改用三份不同文件的成功回合完成上述排队验证。
- 1251×1368 桌面、375×812 与 320×740 窄屏检查无稳定横向溢出，模型菜单可操作。窄屏截图在布局动画结束后判定。
- 最终代码 `ddd1bd9530bfe080f185cb167eda7254d83d96be` 的新进程真实读取文件，返回 `FINAL_WEB_COLD_RESTART_641 BLUE-742`。关闭后立即重启，原 session/agent 身份保持，generation 1→2，标题、唯一历史回答和完成状态均从持久事件恢复。新 worker 的瞬时 state 不包含旧 last-outcome，不将它误认作历史丢失。

本轮浏览器未收到 pageerror。截图、逐项快照、命令记录和冷重启报告位于私有 `evidence/browser-resume/`。观察超时和不成立的测试前提保留在记录中，不充作产品失败或有效 red。

## 检查与证据

最终代码提交 ddd1bd9：类型检查与生产构建通过；前端 109/109、Host 124/124、真实 Host 浏览器 E2E 10/10、Rust 165/165、Clojure 404 项 / 3455 断言通过。无失败、跳过或取消。另有先前同一前端产物上的 Chromium/WebKit 各 11 项与 7 组生产浏览器脚本通过。

标题外部冻结回归 4 项、关闭入口 2 项、既有前端结果投影 9 项通过；独立实际 Host 关闭→立即重启验收通过；关闭协议 7/7 通过，覆盖非法参数、显式停止、冲突模式、命令去重、跨实例重放和回执权限。新增 Rust 仓库回归初版缺少取得控制权步骤而失败，修正测试前提后通过；该失败没有计为产品 red。源码、profile、控制器、验收器、二进制、产物指纹与逐命令日志均见私有回执。不同阶段 worker 不混作同一版本证据。

私有证据目录：`/Users/geb/.codex/qi-web-live-20261029/`。

- `task-contract.json`：范围与完成要求。
- `logs/`：命令、退出码、时间与原始输出。
- `verifier/`：候选外冻结的回归断言。
- `evidence/live-*-report.json`：本次在线结果；对应原始快照和 SSE 另存。
- `candidate-receipt.json`：最终候选绑定信息；不能代替完整体验验收。

## 当前 DeepSeek 参考

已访问[官方 Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)，并通过原生 UI 实拍已安装 DeepSeek Harness `0.2.1-rc.2`；不是旧截图，也不是其 Web 端的等价证明。

| 步骤 | 当前观察 | 证据 |
| --- | --- | --- |
| 1 新会话 | 页面正常，工作区/模式/输入/权限/模型集中于任务区 | `evidence/01-deepseek-native-new-session.png` |
| 2 模型菜单 | 模型和推理等级分层显示，Esc 返回入口 | `evidence/02-deepseek-native-model-menu.png` |
| 3 通用设置 | 可见工作步骤展示、收起时机、代码视图和快捷键；未改偏好 | `evidence/03-deepseek-native-settings.png` |

三张原图已保存。随后使用固定 npm 版本 `0.2.1-rc.2` 启动了独立 Web 参考，状态、共享指令和 Documents 均在私有 reference 目录。实际检查了相同尺寸的空会话、通用设置、模型入口、文件预览及窄屏。参考 Web 未登录，所以模型入口为空；没有把它当作 DeepSeek 在线生成或账号功能的验证。

两端保留必要语义差异：DeepSeek 设置中的权限是新会话默认值，qi-agent 明确标为当前会话权限；qi-agent 的相对文件链接设置与外部网页链接分开说明。没有为了视觉相似而修改这些权限语义。新截图见 `evidence/browser-resume/10-…`、`11-…`、`12-…`、`17-…`、`26-…`。

## 验收范围

旧的“Work 本地浏览器不可用”阻塞已被仓库隔离 Playwright 路径解决，不再作为未完成原因。

移动实机软键盘/安全区、完整无障碍审计、DeepSeek 已登录在线生成及其全部功能未验收；本轮未运行容器验收，镜像字段 NOT_RUN。本机检查不产生维护控制器的 review_ready/PASS，也不代表已合入或发布。
