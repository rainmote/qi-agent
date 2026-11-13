# DeepSeek 功能与交互显示对齐（2026-11-13）

本轮以 qi-agent `bcbc31d280394a5519a0d3c50bf375a21d30bfe7` 为基线，产出独立候选。按用户确认优先对齐 DeepSeek Harness 的功能与交互体验：补齐模型失败后继续生成、指令展开，并统一内容和终态显示；模型接入修正作为配套。矩阵中的“待接入”仍是差异，不代表已经实现。原工作区未提交修改未带入候选。

## 官方参考与变化

- [Harness 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases)：最新可见预发布为 `0.2.2-rc.3`（11 月 13 日），新增 DeepSeek 历史会话导入；近期 `rc.2` 涉及工作树审阅、多层子代理、历史回看、上下文展开及失败恢复。仓库原 Web 对照使用 `0.2.1-rc.2`，不能作为新版全量一致的证据。
- 对照源码固定为 [`dsh-v0.2.2-rc.3` / `38a6a5c`](https://github.com/deepseek-ai/deepseek-harness/tree/38a6a5c965aa99ab525161efb7cc5cf1fe62fced)，重点核对 [Chat 交互契约](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/client/ui-chat/README.md)。继续操作保留独立接纳记录，不伪造普通用户气泡；上下文按需展开，不把历史快照当作当前状态。
- [模型目录](https://api-docs.deepseek.com/quick_start/pricing/)：当前 Flash 正式调用名是 `deepseek-flash`，对应 V4.1-Flash-1017；旧 Flash / Vision Exp 名称仍作为兼容别名。Pro 继续使用 `deepseek-v4-pro`。两者均有 1M 上下文，图像能力需区分模型。
- [思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)与[视觉接口](https://api-docs.deepseek.com/guides/vision/)：思考开关与 low/high/max 强度、工具轮次的 reasoning 回传、Flash 图像输入需要在请求和界面能力声明中一致。
- [11 月 13 日更新](https://api-docs.deepseek.com/updates/)与[聊天应用指南](https://api-docs.deepseek.com/guides/build_a_chatbot/)：新增托管搜索、读链接、文件解析、内容安全和语音相关接口。它们并不因更新模型 ID 自动接入。

## 功能矩阵

| 项目 | qi-agent 现状及本轮处理 | 对齐状态 |
| --- | --- | --- |
| Flash 默认模型 | 主配置、Standard、Creator、子配置及示例统一为 `deepseek-flash`；Web 新目录增加 Pro 选项 | 本轮补齐 |
| 已保存模型及会话 | 保留用户目录、旧模型别名与 daemon 配置快照；不静默重写旧会话或重启 worker | 兼容保留 |
| 思考开关/强度 | 既有 off/low/high/max 保持；保留本产品 off 默认值，用户可明确选择思考模式 | 已有能力 |
| reasoning 回传 | DeepSeek 工具链和恢复历史保留 reasoning_content；其他兼容 provider 不获得此回传字段 | 已有回归覆盖 |
| 图像输入 | 官方 Flash 与两个旧别名声明图像能力，并允许原有截图工具请求；Pro、未知模型、自定义网关保持显式声明 | 本轮补齐 |
| 流式/非流式显示 | JSON 与 SSE 均先发 reasoning 再发正文；同一个 SSE 分片也按该顺序投影 | 本轮补齐 |
| 历史与内容折叠 | 统一字符串/文本块内容判断；空内容不占行、不遮住最终回答；四种详情模式复用真实结果状态 | 本轮修正 |
| 只读工具并行、计划、团队 | 已有有界并行、持久任务板和恢复语义；默认子代理仍限一层只读能力 | 部分对齐，保留权限边界 |
| 大历史回看 | 已有虚拟列表与阅读锚点；目前仍从 snapshot 投影，未实现服务端向前分页 | 待补齐分页协议与重连验证 |
| 工作树/GitHub 审阅 | 有独立维护候选与本轮文件差异；未提供 Harness 同等分支/提交审阅与 GitHub 讨论同步 | 待单独实现 |
| 失败后继续生成 | 最新模型请求失败/输出上限提供“继续生成”；沿用原对话，新运行关联原失败编号；不插入伪用户消息、不自动重放已完成工具 | 本轮补齐受限入口 |
| 指令检查 | 对话内“本轮指令”展示该轮初始系统提示快照，按需展开，最多显示 100000 字符；明确历史时点 | 本轮补齐；不是全部消息/附件的上下文检查器 |
| 继续操作的投递恢复 | 复用现有提交日志、信任检查和对账；草稿/附件不清空，响应丢失先核对，拒绝时不把内部按钮文案写回草稿 | 本轮补齐 |
| 折叠回复与统计偏好 | 四种工作详情和收起时机已有；尚未实现上游独立“全部回复/仅最终回复”偏好及相同统计面板 | 部分对齐，不声称完全等同 |
| DeepSeek 会话导入 | 当前没有对应导入器 | 待实现格式校验、去重与来源标记 |
| 托管搜索/引用 | 当前 `web_search` / `web_fetch` 是本地插件工具，不是 DeepSeek server tools | 待实现 provider 事件、引用与费用投影 |
| 文件解析/OCR、语音 | 当前附件上传保留原件；PDF/Office 未提取正文会明确提示；无对应语音接口 | 待接入，不能声称已读文件正文 |
| Responses / Anthropic | 项目有通用适配器，默认 DeepSeek 路径仍是 Chat Completions | 未做 DeepSeek 专项真实验收 |
| 动态插件/桌面发行 | 已有受控插件和桌面运行时；未复制上游任意代码执行或更新渠道策略 | 独立边界，不随本候选改变 |

托管搜索的后续实现不能直接把远端调用塞进本地工具执行队列：[Web Tools](https://api-docs.deepseek.com/guides/web_tools/)规定服务端执行搜索/读取，客户端保留返回内容并在后续轮次回传。需新增持久事件、来源引用、取消/拒绝状态和按次用量处理，完成端到端验证后才能启用。

## 显示规则

| 事实 | 显示行为 |
| --- | --- |
| model 阶段只有 reasoning | 显示“正在思考”及可展开内容 |
| 正文开始生成 | reasoning 标签改为“已完成分析”，正文继续流式展示 |
| tool / retry / compacting / idle | 不渲染残留的流式内容气泡 |
| 空数组或空文本块 | 不产生空消息行，不作为最终回答，不抢走回答操作按钮 |
| completed + not-run / unknown | 折叠摘要与结果行使用同一状态函数，显示“尚未验收”或“验收结果未知” |
| failed / cancelled / uncertain | 保持可检查的过程，不自动做整轮折叠 |
| 最新 failed + provider-error / output-limit | 空闲且无审批/未知投递时才允许继续；执行前在同一接纳锁内再次核对原运行编号 |
| stale / cancelled / uncertain / 工具策略或预算终止 | 不提供原运行继续；服务端也拒绝，不新建用户消息或触发模型请求 |
| context/snapshot / agent/continuation | 分别展示可展开的历史指令和继续请求回执；会话清空后不保留旧行 |
| 快照与实时回放 | 相同 durable events 在四种视图下得到相同可见内容 |

`message-content.ts` 仅负责显示文本提取，不修改 durable 消息或模型请求。工具参数/结果仍使用原有完整序列化。普通字符串和文本块内部的 Markdown 空白继续保留。未知的 provider 专有结构没有被声明为已支持。

继续操作使用现有 `turn.submit` 的 `options.continuation-of`，保留 daemon 的接纳、权限和幂等记录。worker 校验最近持久终态后创建新的 native run，写入 `agent/continuation`，沿用已保存消息与工具结果，遵守原有预算及审批规则。它不会承诺模型自行决定的后续工具调用不会重复语义；客户端和运行时不自动重放历史工具。恢复为 uncertain 的运行只允许核对，不允许借“继续”绕过。

## 验证与交付边界

目标断言存放在候选外的私有 verifier。旧实现得到内容/能力断言失败，新实现通过；初次 verifier 语法错误另存，未计作有效 red。回归用例随候选交付，测试与 profile 变化应与普通实现一并单独审查，不修改或激活既有控制器规则。

本地验证涵盖完整 `npm test`、生产构建、生产浏览器回归、真实 daemon/Web 离线 E2E、Rust 格式和 Clippy。继续回归覆盖重复点击、并发接纳、持久失败重开、拒绝/未知响应、草稿与附件保留、已完成工具不重放，以及 clear/stale/cancelled/uncertain/预算与策略终态拒绝。真实链路使用离线 provider、真实审批和实际文件写入，不推断真实 DeepSeek 效果。具体命令、起止时间、退出码、原始日志与源码/profile/controller/verifier/镜像指纹保存在私有任务状态目录，最终结果以该目录的 `delivery.json` 为准。

正式维护容器验收为 **NOT_RUN**：所检查的旧镜像 `sha256:b1c9a4779a1542a97156ceb10aeb9b03c8b547ed1d461f03b9d3ee15f82d3361` 缺少当前所需 `/usr/local/lib/qi-dependency-cache.mjs`，兼容探针失败。该镜像未被冒充为可用验收环境。真实 DeepSeek 请求、真实模型视觉效果及桌面发行检查也为 **NOT_RUN**。

候选不等于人工接受、合入或发布。后续 Harness 优先顺序为：历史分页与会话导入 → 工作树/GitHub 审阅与具名多层协作 → 回复折叠与统计偏好；托管搜索/引用/费用及文件解析为独立 provider 能力项。每项均需对应验收，不能用此轮绿灯覆盖。
