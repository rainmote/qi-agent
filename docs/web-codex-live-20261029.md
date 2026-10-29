# Web / Codex 真实链路验证 · 2026-10-29

状态：独立待审候选；完整 DeepSeek 体验验收未完成。基线 `9d191214f386f0700b8fb5cf1ebcc9a5f9896ece`。
本次只修前端状态投影，不改变模型、权限、控制器或发布规则；未合入、发布。

## 已修复

1. 后台超时裁定将同一 run 的 `completed` 更正为 `uncertain` 时，Web 曾丢弃更正，仍显示“运行完成”并自动折叠过程。现在识别 Rust `host_arbitrated` 和 Clojure `host-arbitrated`，在原位置更新唯一结果行，保留所有原始事件；晚到普通终态不能覆盖裁定。
2. 清空会话后，后续状态通知携带旧 `last-outcome` 会使旧结果重新出现。现在保留已清空 run 的身份，覆盖仅有临时状态、乱序事件、迟到 clear 和重新加载；有明确 clear 后事件的新 run 正常显示。历史修正也不会覆盖较新 run 的状态。

候选外冻结的首批 6 项断言在原实现全部失败，修复后通过；独立复核发现的边界也保留失败记录。仓库新增 10 项回归，独立只读复核确认本轮已发现问题均修复。中间曾出现测试文件类型/合并错误，已修正，未计作有效 red。

## 真实在线链路

通过本机 HTTP API / SSE 使用生产 Web Host → 隔离 Rust daemon → 真实 Babashka worker → 已有 Codex 登录。不是浏览器操作证据。

- 官方订阅目录返回 8 个模型；刷新后保留当前模型和推理强度。
- `gpt-5.6-sol` 真实回复，第二轮读取隔离样例文件 `hello.txt`，正确返回 `BLUE-742` 并记住前轮结果 `56`。
- 读取过程中收到 53 个 `llm/stream` 事件，工具调用与结果成对、终态完成。
- 运行时排队消息得到 `QUEUE-OK`；停止实际运行得到 `cancelled`，重新打开保留取消状态和 70 条事件。
- 清空后真实下一轮确实携带旧 `last-outcome`；候选投影没有复活旧结果，新回答 `CLEAR-OK` 只有一个结果行。

测试项目、信任库、Web 状态与 daemon 单独隔离。登录凭据未打印、复制或提交；测试程序通过已有适配器使用原登录。

## 检查与证据

候选的类型检查、生产构建与前端单元测试 109/109 通过；Host 基线测试 114/114 通过，均无跳过或取消。提交后的精确候选复测及源码、profile、控制器、验收器、二进制和产物指纹见私有回执。

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

工具两次返回 `Local browser use is disabled in Work settings`，已请求用户开启。真实浏览器交互、同尺寸视觉比较、桌面/窄屏、键盘焦点和完整浏览器 E2E 均为 NOT_RUN，不能用 API、SSR 或历史截图替代。

移动实机软键盘/安全区、全部官方功能、真实子任务/附件/写入审批、浏览器跨刷新恢复仍需后续验证。本轮未运行容器验收，镜像字段 NOT_RUN；本机检查不产生维护控制器的 review_ready/PASS。目标保持 active，尚不能声称与 DeepSeek 体验一致。
