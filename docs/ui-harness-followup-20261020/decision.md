# 严格像素目标的最小范围决策

严格目标尚未完成。这不是以 blocked 代替完成，也不建议用阈值将现有差异改判通过。

需要明确的一项产品范围选择是：**“完全对齐”是否同时包括官方品牌、四种预设和 Host 配置语义？**

- 若包括，后续工作需要将官方身份与 qi 分支关系标注清楚，并真实补齐 PTC/极简等预设、Host 默认权限与配置等能力，不能只替换标签或画空控件。当前保留 qi 后端协议、权限与审批边界，尚未做这类能力迁移。
- 若保留 qi 身份和现有能力集合，须明确批准这些具名差异作为验收例外；目前没有此批准，严格状态继续 blocked。

两种选择都不豁免普通前端和稳定栅格残差：快捷键、角色字体、英语、忙时默认偏好等仍是具体待开发的前端能力；原13处栅格残差在两轮有界实验中没有消除。不能把它们全部归因于后端或品牌。

可复核证据：[首页](comparison/new-session-light-1440-side-by-side.png)、[设置](comparison/settings-light-1440-side-by-side.png)、[模式菜单](comparison/preset-menu-light-1440-side-by-side.png)、[窄屏模式菜单](comparison/preset-menu-light-320-side-by-side.png)、[13处及新增残差](comparison/regions.json)、[完整报告](README.md)。
