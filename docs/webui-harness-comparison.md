# Web UI 对照与改进

对照日期：2026-10-11。DeepSeek Harness 源码固定于
[`d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)。
依据为官方源码及官方轨迹截图；官网展示页本次出现脚本加载错误，没有将其视为完整产品实测。

| 交互 | Harness 的参考点 | qi-agent 本轮落地 |
| --- | --- | --- |
| 执行过程 | 简洁/标准模式通过组头汇总活动，细节按需展开 | 沿用现有 step 分组，默认显示类别、数量与结果状态；多项调用逐项展开，单项直接查看。收起时保留失败原因，停止后的缺失结果标为未确认。 |
| 待确认操作 | 在 composer 中展示待审批操作和明确选择 | 审批嵌在输入区或当前工作台底部，上文仍可操作；保留可编辑草稿，审批期间阻止新提交。确认失败可原地重试，保留停止入口。 |
| 模型选择 | 超过四项时提供搜索，处理键盘选择和弹层定位 | 按名称和标识符搜索，提供空态；方向键、Home/End、Escape、焦点返回；菜单根据可用视口定位，保留已有推力选项。 |
| 会话轨迹 | 三通道概览和细节查看 | 项目已有相近实现，本轮保留现有轨迹、虚拟列表和搜索，没有重复搭建。 |
| 输入与导航 | 操作集中在会话底部 | 继续沿用上一轮的单行标题导航、同宽正文与输入区、合并的工作区/模式/快捷开始以及“+”菜单。 |

参考实现：

- [过程展示与折叠规则](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/conversation-nodes/README.zh.md)
- [ApprovalPanel](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-approval/src/client/ApprovalPanel.tsx)
- [ModelSelect](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-model-selection/src/client/ModelSelect.tsx)
- [官方轨迹截图](https://deepseek.com/harness/images/feat-trace-zh.webp)

保留当前产品的浅色/深色主题和绿色强调色。没有引入四套展示模式、额外设置页或新的前端依赖。
项目可信确认仍在开始任务之前；授予项目信任不等于取消工具审批。
没有给普通 Enter 增加批准操作的快捷行为。工具摘要描述实际记录，不把调用次数当成成功次数。

验证入口：`npm run typecheck`、`npm run test:web-ui`、`npm run web:build`、
`npm run test:web-browser:ci`、`npm run test:web-e2e`。
浏览器回归使用生产构建和模拟 API；交互 E2E 使用真实 Web Host、隔离 Rust daemon 与 Babashka Worker，
模型为确定性的离线 fixture，检查审批前后真实临时文件变化。两者均不代表真实模型效果或已部署服务验证。
