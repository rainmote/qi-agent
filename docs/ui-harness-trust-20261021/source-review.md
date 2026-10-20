# 官方参考与 qi 信任语义

官方仓库固定为 `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`（0.2.1-rc.2）。2026-10-20 16:10 UTC 公开 HEAD 只读查询仍返回相同 SHA，见 [原始收据](reference-check.json)。没有更新参考副本。

实际查看了本任务前序在相同 SHA 上捕获的工作区菜单、权限菜单、1440/390 设置截图和元数据，已复制到 `reference/`。它们是真实官方运行截图，**不是本轮新增实拍**。目录准入与风险确认的新实拍被自动审批拒绝，两次命令均未执行，目标测试文件不存在；已停止，等待明确范围授权，见 [阻碍记录](blockers.json)。没有以其他路径、工具或环境绕过。

## 源码查证

| 官方源码（全部为上述 SHA） | 实际行为与本次结论 |
| --- | --- |
| `packages/client/ui-workspace/src/client/WorkspacePicker.tsx` | `WorkspacePickFlow` 选择目录后 `createWorkspace({path})`，取消关闭；采用失败提供取消和重新选择；采用过程中避免重复操作。检查到的流程没有项目 allow/deny 信任确认。未补拍的准入状态不能宣称已运行验证。 |
| `packages/client/ui-directory-picker-browse/src/client/flow.ts` 与 `index.ts` | 目录浏览、路径编辑、取消、打开；宿主默认目录可能是用户 home。没有为截图访问真实 home，也未取消宿主访问控制。 |
| `packages/client/ui-permission-presets/src/client/PermissionRow.tsx`、`locales.ts` | 设置控制随后创建会话的默认权限。完全权限有独立风险确认，当前会话选择另有语义；不能把它当作项目持久信任 UI。 |
| `packages/credentials/credentials-local/src/index.ts` 文件头 | 明确写明产品信任启动所在项目；这仅用于理解官方假设，不构成放松 qi 边界的授权。未读取任何凭据文件。 |
| `packages/client/ui-workspace/src`、`ui-permission-presets/src`；全仓 `packages`/`apps` 的项目/目录信任相关词搜索 | 在检查范围内未找到与 qi 持久目录 allow/deny 等价的专门界面。搜到的远程 authority、证书信任、shell 环境等属于其他语义。此结论限定于源码与既有截图，不以“未找到”推断所有未运行页面。 |

## 实现取舍

qi 已有真实后端：`src/qi/plugins/trust.clj` 为 canonical 路径保存 allow/deny，最近父目录设置向未另设的子目录继承；`src/qi/command.clj` 的 `/trust allow|deny` 修改当前目录；`policy.clj` 分别执行信任检查、工具权限与审批。这些文件及协议均未修改，见 [基线指纹对照](unchanged-boundaries.json)。

本轮采用现有 Harness 字体、颜色、按钮、对话框和目录/盾牌图标，完善 qi 的首次进入说明、受限选择、状态、查看与撤销、加载/错误、取消与返回。安全信息保持 qi 语义：

- 未选择的项目默认受限；取消不写入、不发送草稿；明确选择保持受限后，原本请求发送的消息才在受限规则下继续。
- 查看或管理信任不发送草稿。状态行位于输入卡片上方，不撑大已对齐的卡片。
- 显示完整当前路径及实际父目录继承来源，说明本机持久化及未单设子目录的范围。
- 撤销为当前目录写入 deny；不存在“删除父目录决定/忘记设置”假入口，不声称撤回已执行操作或自动停止运行。
- 固定 `:trusted` profile 只读；没有 trust 服务时说明缺失，不伪造管理能力。
- 保存前复核路径/状态；变化后要求重新审阅。旧回执只核对，不覆盖后来发生的撤销；未知结果保留原 command_id；旧响应/查询不能清除或替换新编号。
- 项目信任不改变会话权限、不跳过人工审批、不扩大文件/命令/网络/CSP 边界。

官方与 qi 新信任弹窗没有同状态等价截图，因此没有做“官方信任弹窗像素一致”的认证。关联并排图的内容差异已经标注；严格像素结果仍 blocked。

许可：官方 MIT Copyright (c) 2026 DeepSeek；既有源图标与许可沿用 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)，未引入未注明许可的新资源。
