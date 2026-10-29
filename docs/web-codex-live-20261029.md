# Web / Codex 真实链路验证 · 2026-10-29

状态：独立待审候选；完整 DeepSeek 体验验收未完成。基线 `9d191214f386f0700b8fb5cf1ebcc9a5f9896ece`。
本次修复前端状态投影、默认子代理配置与消息生命周期。没有修改 daemon、权限策略、维护控制器或发布规则；未合入、发布。

## 已修复

1. 后台超时裁定将同一 run 的 `completed` 更正为 `uncertain` 时，Web 曾丢弃更正，仍显示“运行完成”并自动折叠过程。现在识别 Rust `host_arbitrated` 和 Clojure `host-arbitrated`，在原位置更新唯一结果行，保留所有原始事件；晚到普通终态不能覆盖裁定。
2. 清空会话后，后续状态通知携带旧 `last-outcome` 会使旧结果重新出现。现在保留已清空 run 的身份，覆盖仅有临时状态、乱序事件、迟到 clear 和重新加载；有明确 clear 后事件的新 run 正常显示。历史修正也不会覆盖较新 run 的状态。
3. 默认、standard 和 creator 的子代理 profile 缺少 `auth/store`，真实委派在模型请求前即因 provider-settings 依赖缺失而失败。三个子 profile 现在装配现有 auth-store；未增加工具、复制凭据或改变认证实现。
4. daemon 转发给已完成子代理的消息绕过了注册表的 completion watcher：子代理已经生成新回答，但 `subagent.status` 仍返回旧 run 和旧结果。现在该入口复用消息生命周期，保留其他 provider/RPC 的原有转发，且不重复记录 daemon 已负责写入的发送日志。
5. 重复 inbox 回执，以及普通排队回执与任务完成相遇时，曾把终态改回 `running`。重复回执现在不修改任务与日志，排队消息沿用现有 watcher。迟到的新消息回执也不能复活已停止或删除的子代理。

候选外冻结的首批 6 项断言在原实现全部失败，修复后通过；独立复核发现的边界也保留失败记录。仓库新增 10 项回归，独立只读复核确认本轮已发现问题均修复。中间曾出现测试文件类型/合并错误，已修正，未计作有效 red。

子代理补充了候选外冻结的 5 项测试、70 个断言：profile 缺依赖、重复消息、daemon 转发、排队/完成竞态及停止/删除竞态均保存有效 red/green。竞态使用确定性的内存交错，不声称是真实浏览器或 provider 并发验收。配置与生命周期改动另外进行了只读复核。

## 真实在线链路

通过本机 HTTP API / SSE 使用生产 Web Host → 隔离 Rust daemon → 真实 Babashka worker → 已有 Codex 登录。不是浏览器操作证据。

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

## 检查与证据

前端修复阶段的类型检查、生产构建、前端单元测试 109/109、Host 测试 114/114 通过，均无跳过或取消。后续子代理改动增加了完整 `bb test` 与冻结断言检查；最终候选 SHA 的命令、时间、退出码、测试数，以及源码、profile、控制器、验收器、二进制和产物指纹统一见私有回执。不同阶段的常驻 worker 不混作同一版本证据；最终子任务复测使用提交后新建的 worker。

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

三张原图已保存并打开检查。仅作参考采集，不构成两端对照通过或完整无障碍审计。

## 未完成

工具多次返回 `Local browser use is disabled in Work settings`，已请求用户开启。真实浏览器交互、同尺寸视觉比较、桌面/窄屏、键盘焦点和完整浏览器 E2E 均为 NOT_RUN，不能用 API、SSR 或历史截图替代。

移动实机软键盘/安全区、全部官方功能、以上链路的实际浏览器操作及浏览器跨刷新恢复仍需后续验证。本轮未运行容器验收，镜像字段 NOT_RUN；本机检查不产生维护控制器的 review_ready/PASS。尚不能声称与 DeepSeek 体验一致。
