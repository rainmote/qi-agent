# qi-agent 前端偏好补齐（2026-10-20）

本地功能候选已完成；**严格像素验收仍 blocked**。基于 `08dd55c083fe91ad789c9c7fc51fbd3c3d057fc1`，沿用分支 `codex/web-deepseek-harness-20261019`。官方参考仍为 `687f282e8625c6b8d11ff58211a90524be2e4317`（上一轮无凭据公共 HEAD 核验记录保留）。本轮只补可独立完成的前端能力，不更改品牌、预设或 Host 配置语义。

[完整范围决策](decision.md) · [16张实拍浏览](index.html) · [窄屏修复前后](before-after-mobile.png) · [源码/构建/运行合同指纹](tested-source.json) · [只读复核](readonly-review.md)。上一轮严格对照与13处残差保留在 [历史报告](../ui-harness-followup-20261020/README.md)，不能把历史数字当作本轮新设置行的实测结果。

## 实际变化

| 能力 | 行为与边界 |
| --- | --- |
| 代码工作视图 | 真实隐藏/恢复轨迹与本轮差异；文件列表仍可用。不改真实预设、权限或模型请求。 |
| 快捷键 | 录制、冲突/保留键检查、清除、恢复默认。五项已接线操作：新会话、侧边栏、设置、输入框、文件；默认 Alt/Option+Shift+N/B/S/I/F。原生全选/复制/粘贴/撤销等不可覆盖。 |
| 忙时发送 | 默认排队，可切插话；运行时 Enter/按钮使用默认，Ctrl/Cmd+Enter 使用另一方式，空闲时正常提交。只选既有 turn.follow-up/turn.steer 方法，保留审批、停止及未知结果保护。 |
| 字体 | 正文/界面、代码块/参数、命令输出三种本机字体列表；代码10–16px、命令输出10–20px。校验CSS输入，留空恢复默认，验证实际代码与输出计算样式。 |
| 语言 | 695项中英界面文案及派生日期格式，语言与其他偏好同页更新并可重载。模型、用户、文件、提供方/预设名称、后端错误等数据保留原文；qi身份中文保留。 |
| 持久化/窄屏 | 浏览器本地保存，失败可见并可恢复；320px设置使用横向导航与堆叠控件，检查内层溢出、遮挡和焦点，未冒充Host共享设置。 |

不增依赖。API客户端仅将三条自有恢复错误本地化，原RPC载荷、commandId日志、未知结果对账和异常中断可用性保持原逻辑。未修改Host、daemon、worker、agent.edn、权限控制器或维护验收器。MIT/OFL通知保留并补翻译来源，构建产物带许可证。

## 验证

| 冻结候选检查 | 结果与证据 |
| --- | --- |
| 类型 | [prefs-final-type-v2](logs/prefs-final-type-v2.json)：completed / exit0 |
| 前端 | [prefs-final-ui-v2](logs/prefs-final-ui-v2.json)：81/81，取消/跳过0 |
| 构建 | [prefs-final-build-v2](logs/prefs-final-build-v2.json)：通过，保留约647.7kB主JS超过500kB提示 |
| 完整Chrome | [prefs-final-browser](logs/prefs-final-browser.json)：通过；含旧完整浏览器、协作、新偏好三组；真实模型调用0 |
| 真实后端 | [prefs-final-real](logs/prefs-final-real.json)：Host→Rust daemon→Babashka Worker离线fixture 8/8通过；验证真实文件写入/审批/取消/幂等性 |
| 截图元数据 | [prefs-final-capture](logs/prefs-final-capture.json)：通过；Chrome155.0.8059.85、DPR1、1440×1000/1440×844/320×844，主题/字体/语言/滚动状态见每张旁边JSON；没有遮罩或排除区域 |

完整浏览器继续覆盖新会话重载立即后退、四个启动历史竞态、1440/390历史返回、移动工作台Tab/iframe/引用回焦、Full Access取消/人工确认、重复提交及原编号恢复。新增专项对queue/steer分别覆盖1440/320、按钮双击仅一次、输入法、Shift+Enter、另一发送方式、审批/停止/未知结果拦截和完成回执不重发。

[通用中文](candidate/prefs-general-zh-1440.png) · [通用英语](candidate/prefs-general-en-1440.png) · [字体实际应用](candidate/prefs-fonts-applied-1440.png) · [窄屏字体](candidate/prefs-font-roles-en-320.png) · [窄屏快捷键](candidate/prefs-shortcut-editor-en-320.png) · [本地存储失败](candidate/prefs-persistence-error-en.png) · [忙时排队](candidate/prefs-busy-queue-320.png) · [停止中](candidate/prefs-stopping-steer-320.png)。

## 保留的失败与修复

- 首轮前端3项失败：本地化吞掉截图标签空格。恢复原JSX空格并改整句翻译后81项通过。
- 首轮浏览器超时：语言按钮丢失原有当前语言可访问名称。恢复“语言：中文/Language: English”后完整旧回归通过。
- 二轮新专项断言错误：把客户端JSON字段 commandId 写成 command_id；实际API协议未改。修正断言后两种方式各6次独立意图均有独立编号，未知结果另验证对账不重发。
- v3新专项未展开第二层命令详情；修正测试按真实披露路径点击后，验证代码16px与命令输出19px生效。
- v6新专项在“已完成”对账刷新空闲快照后误等停止按钮；补真实“新运行”事件后检查停止中拦截通过。
- 实拍发现320px竖导航遮住新字段，旧页面宽度断言未抓到。保留[失败截图](red/second-prefs-font-roles-en-320.png)，改横向导航并加内层scrollWidth与elementFromPoint断言；未把旧弱检查当作修复证据。
- 独立只读复核发现可把Cmd/Ctrl+A绑定导航导致草稿风险、共享文案将bash误标Pwsh、错误文案切语言滞留、自动化日期固定中文，均修复。前两项为代码审阅发现，没有捏造修复前浏览器复现。

29组本轮原始JSON/日志均保留于logs，失败结果没有被覆盖。原始终端日志保留其空格与换行；源码另通过diff检查。

## 残余差异和未验证

产品二选一及功能影响见[决策全文](decision.md)。普通前端的完整官方快捷键目录/编辑器结构、链接打开偏好及所有设置分区仍未等价；不能归为品牌或后端就豁免。五项本轮偏好有真实实现和验收，但不能称全部官方设置已经复刻。

旧13处稳定栅格残差未消除，本轮停止无收益调参，新增偏好页面没有逐像素认证；没有用整体非零比例宣称通过。手机实机软键盘/安全区、Safari/Firefox/Electron、PDF插件完整键盘路径、官方真实模型/账户/所有设置分区、本轮真实子任务模型派发未验证。广义Host旧82通过/3项ps EPERM失败仍保留，未重跑或宣称全绿。

继续沿用 tools/isolation.sb：deny Codex/SSH/AWS/钥匙串/真实Chrome配置/NAS，出站限localhost，临时QI状态；不暴露宿主数据。未push、建PR、部署、重启现有服务、改凭据/网络/系统权限，未修改其他工作区/main/旧候选。
