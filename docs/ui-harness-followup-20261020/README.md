# 2026-10-20 像素对齐后续候选

工程候选完成，严格全屏像素验收仍为 **blocked**。28组原图配对均非零，不能以构建通过、局部相等或一个整体百分比宣布“完全对齐”。[原尺寸交互对照](index.html) · [源码/构建指纹](tested-source.json) · [测试索引](checks/index.json) · [独立复核](readonly-review.md)。此前 c72cbf2 的原证据完整保留；本目录不会覆盖旧轮结果。

## 范围与实际修改

- 继续 geb Mac mini 原分支 `codex/web-deepseek-harness-20261019`，基线 `c72cbf2667e90245c9c16149f0bbb8681b8cc12f`，唯一写入者。官方参考 `687f282e8625c6b8d11ff58211a90524be2e4317`（0.2.1-rc.2），交付前再次无凭据核对 HEAD 未变。[官方固定版本](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。
- 新会话右上角补齐真实文件入口；无需创建会话，复用原授权文件 API。七个新会话视口/主题的入口矩形均与参考严格相等。
- 设置使用54px固定顶栏与独立滚动列；主题区改为源结构。工作步骤展示保留四种真实选择，改为同尺寸菜单；经实际UI把两边对照状态统一为“详细”，未改变 qi 默认“标准”。基线设置图仍是“标准”，不能把选中值差异全部算成样式收益。
- 新增真实“回答结束后/下次有新消息时”折叠偏好；保存浏览器本地，手动选择优先，后续用户消息会折叠历史步骤，失败/取消/未知结果和审批决定继续保留。未实现官方Host跨客户端配置同步。
- 工作区管理移至独立设置分区，原添加/移除回调保留；低高度桌面导航支持滚动。品牌采用两行排版，显示实际 package Web版本；裁去 qi SVG 内部空白，保留 qi 身份。
- 文件面板补初始焦点、关闭回焦、移动全屏的背景inert/原生Tab首尾边界、异步控件丢焦恢复；保留pre/iframe预览键盘访问。引用关闭明确回到草稿。iframe仅补键盘属性，原sandbox/CSP/referrer限制不变。
- 后端协议、command_id、Host/daemon/worker、权限、控制器及审批实现均未修改；11项运行/合同指纹与c72证据相同。MIT/OFL归属和随构建分发的许可证一致。

## 浏览器、测试与失败记录

同一Chrome155.0.8059.85、DPR1、zh-CN、UTC、固定时钟2026-10-20T09:00Z；1440×1000及1024/768/390/320×844，浅/深主题、同字体，等待字体与两帧渲染。官方运行实际源码和官方隔离scaffold，使用公开录制会话；qi视觉图使用相同语义数据的离线API夹具。没有给参考注入样式，没有修图、遮罩或从全屏指标排除区域。官方28张、候选38张、c72基线34张原图及逐图DOM保存于本目录。真实后端另有离线Host→Rust daemon→Babashka worker E2E，不用视觉夹具冒充后端验证。

- 最终类型检查、76项前端、完整Chrome浏览器和8项真实后端E2E通过，零取消/跳过，外部模型调用0。覆盖重复提交/原编号对账、取消、人工审批、信任、返回、历史竞态、移动端、预览与引用焦点。构建保留大于500kB提示。
- c72已修复的新会话重载立即后退再次通过；旧红/绿记录仍在上一轮目录，本轮完整回归再次含四个启动竞态与1440/390历史返回。
- 独立只读复核发现新增入口焦点与短窗导航风险，随后又指出pre/iframe及引用回焦回归，均按具体路径修复。未以早期通过覆盖后续失败。
- 第一次移动Tab检查失败；一次诊断重跑通过仍未视为解决。专项重放在320px第2次Tab实拍复现焦点落到body，保留 `followup-focus-repeat-red` 及截图；修复后原专项8轮通过。扩展真实预览路径又暴露静态iframe停靠问题，保留三个失败版本；最终完整预览/引用专项8轮通过，随后完整回归通过。
- 官方新增菜单补拍分别因工作目录错误、两个同名“详细”选择器失败；日志保留，正确目录且按工作步骤行定位后28张采集通过。错误工作目录仅创建3个空目录，已精确rmdir清理。
- 原 `tools/isolation.sb` 未放宽：测试禁止读取Codex/SSH/AWS/钥匙串、真实Chrome配置、NAS，出站限localhost，使用任务临时状态；官方公共HEAD核对单独无凭据只读。未push、建PR、部署、重启现有服务、更改凭据或网络/系统权限。
- 广义Host套件旧有82通过/3项ps EPERM失败未重跑，不能签发该套件全绿；此环境限制记录保留。

## 差异分类和仍需完成的工作

| 分类 | 具体区域与原因 | 结论 |
| --- | --- | --- |
| 可修视觉 | 本轮已补入口、品牌占位、菜单/固定顶栏、设置布局；原13处残差仍在，新增两选择器各40像素差 | 仍未逐像素通过，不能归因后端 |
| 真实前端能力 | 设置仍缺源代码工作视图开关、快捷键编辑、忙时默认行为、角色字体/英语等；不是天然后端障碍 | 尚未补齐；新偏好真实实现而非占位 |
| 背景相关视觉 | 新设置菜单几何和字级匹配，但源下方更多设置行会透过真实模糊材质；qi缺失这些行，两个菜单仍非零，未证明全部残差都来自背景 | 不能用遮罩、伪控件或不透明背景掩盖 |
| 产品身份 | qi标志/名称及真实Web版本与DeepSeek标志/DSH版本不同 | 改身份是产品决定；保持诚实标识 |
| 真实产品/协议能力 | 官方标准/PTC/极简/创造4预设，qi标准/创造/生产只读3预设；源权限设置为新会话默认，qi为当前会话 | 不得改名冒充、不复制误导权限文案；完整等价需实现能力/配置适配 |
| 账户/配置/遥测 | 源配置文件打开、账户/持久反馈/分享及同口径token/cache/TPS并无现成Web等价链路 | 未伪造按钮或统计；需要真实功能适配 |

最小产品范围选择：若“完全一致”包含品牌、预设及Host设置语义，就需要明确授权按官方身份/能力体系替换或完整补齐；保持 qi 身份和现有能力集合时，这些具体差异不能诚实地变成零。此选择不能替代尚待处理的前端或稳定栅格差异。

手机实机软键盘/安全区、Safari/Firefox/Electron、PDF浏览器插件内的完整键盘路径、官方真实模型流式/账户/配置文件打开与所有设置分区没有本轮完整实拍，均未验证。早轮官方子任务公开录制与qi子任务披露证据仍在上一轮目录，本轮未重跑真实模型派发。

## 有界栅格排查

最初7种状态×两侧×3次重复拍摄，42组同页面重复图严格相等，见 stability.json。两次实际候选CSS/容器实验分别调整固定滚动列/主题DOM，以及content-box、继承字级、reduced-motion与菜单绘制；原45区域均仍为32相等/13残差，因此停止无收益调参。原SVG与主要计算样式相同不代表栅格一致，根因尚未完全定位；这些不是已证明可忽略的随机噪声。新参考补拍在主题图标处另有1–2像素跨运行变化，不能用同页面重复结果外推跨运行必定相同。

保留原45个区域与本轮新增11个区域，共56；39严格相等、17非零，所有已记录几何差为0。新增7个右上入口相等，两个选择器各40像素/最大通道差1；两新菜单因真实背景/待补设置行非零。裁切诊断不从全屏中剔除。原45区域仍是32相等，不能把新增相等区域造成的39/56当作消除了旧残差。

| 页面 / 区域 | 非零像素 | 最大通道差 |
| --- | ---: | ---: |
| [new-session-dark-1440 / input-card](comparison/regions/new-session-dark-1440-input-card.png) | 1312 | 1 |
| [permission-menu-light-1440 / menu](comparison/regions/permission-menu-light-1440-menu.png) | 1 | 1 |
| [workspace-menu-light-1440 / menu](comparison/regions/workspace-menu-light-1440-menu.png) | 1 | 1 |
| [model-options-light-1440 / menu](comparison/regions/model-options-light-1440-menu.png) | 1 | 1 |
| [model-options-light-320 / menu](comparison/regions/model-options-light-320-menu.png) | 1925 | 1 |
| [settings-light-1440 / appearance-light](comparison/regions/settings-light-1440-appearance-light.png) | 109 | 17 |
| [settings-light-1440 / appearance-dark](comparison/regions/settings-light-1440-appearance-dark.png) | 77 | 1 |
| [settings-light-1440 / appearance-system](comparison/regions/settings-light-1440-appearance-system.png) | 76 | 1 |
| [settings-light-1440 / font-size-stepper](comparison/regions/settings-light-1440-font-size-stepper.png) | 40 | 1 |
| [settings-dark-1440 / appearance-light](comparison/regions/settings-dark-1440-appearance-light.png) | 228 | 16 |
| [settings-dark-1440 / appearance-dark](comparison/regions/settings-dark-1440-appearance-dark.png) | 16 | 1 |
| [settings-dark-1440 / appearance-system](comparison/regions/settings-dark-1440-appearance-system.png) | 341 | 1 |
| [settings-dark-1440 / font-size-stepper](comparison/regions/settings-dark-1440-font-size-stepper.png) | 12 | 1 |
| [settings-transcript-menu-light-1440 / preference-menu](comparison/regions/settings-transcript-menu-light-1440-preference-menu.png) | 13528 | 66 |
| [settings-collapse-menu-light-1440 / preference-menu](comparison/regions/settings-collapse-menu-light-1440-preference-menu.png) | 9734 | 13 |
| [settings-light-1440 / transcript-selector](comparison/regions/settings-light-1440-transcript-selector.png) | 40 | 1 |
| [settings-light-1440 / collapse-timing-selector](comparison/regions/settings-light-1440-collapse-timing-selector.png) | 40 | 1 |

## 全部原始全屏结果

新会话品牌图标变大使部分整屏非零比例增加；设置有所下降。整体比例并非单调收益或验收阈值。

| 状态 | c72 基线非零像素 % | 当前非零像素 % |
| --- | ---: | ---: |
| [account-menu-light-1440](comparison/account-menu-light-1440-side-by-side.png) | 0.97986 | 0.97986 |
| [conversation-light-1440](comparison/conversation-light-1440-side-by-side.png) | 0.91417 | 0.91417 |
| [model-menu-light-1440](comparison/model-menu-light-1440-side-by-side.png) | 0.92361 | 0.92361 |
| [model-options-light-1440](comparison/model-options-light-1440-side-by-side.png) | 0.90625 | 0.90625 |
| [model-options-light-320](comparison/model-options-light-320-side-by-side.png) | 1.37885 | 1.43883 |
| [model-options-light-390](comparison/model-options-light-390-side-by-side.png) | 0.57632 | 0.62553 |
| [new-session-dark-1440](comparison/new-session-dark-1440-side-by-side.png) | 0.37215 | 0.37375 |
| [new-session-dark-390](comparison/new-session-dark-390-side-by-side.png) | 0.57692 | 0.62614 |
| [new-session-light-1024](comparison/new-session-light-1024-side-by-side.png) | 0.4501 | 0.45264 |
| [new-session-light-1440](comparison/new-session-light-1440-side-by-side.png) | 0.28097 | 0.2825 |
| [new-session-light-320](comparison/new-session-light-320-side-by-side.png) | 0.70238 | 0.76237 |
| [new-session-light-390](comparison/new-session-light-390-side-by-side.png) | 0.57632 | 0.62553 |
| [new-session-light-768](comparison/new-session-light-768-side-by-side.png) | 0.30084 | 0.32413 |
| [permission-menu-light-1440](comparison/permission-menu-light-1440-side-by-side.png) | 0.91444 | 0.91444 |
| [preset-menu-light-1440](comparison/preset-menu-light-1440-side-by-side.png) | 4.74278 | 4.74431 |
| [preset-menu-light-320](comparison/preset-menu-light-320-side-by-side.png) | 25.22845 | 25.28843 |
| [process-open-dark-1440](comparison/process-open-dark-1440-side-by-side.png) | 1.27687 | 1.27694 |
| [process-open-light-1440](comparison/process-open-light-1440-side-by-side.png) | 0.92361 | 0.92361 |
| [reasoning-body-open-light-1440](comparison/reasoning-body-open-light-1440-side-by-side.png) | 0.9184 | 0.9184 |
| [reasoning-open-light-1440](comparison/reasoning-open-light-1440-side-by-side.png) | 0.92139 | 0.92139 |
| [settings-collapse-menu-light-1440](comparison/settings-collapse-menu-light-1440-side-by-side.png) | 未拍 | 3.06208 |
| [settings-dark-1440](comparison/settings-dark-1440-side-by-side.png) | 3.18778 | 2.46778 |
| [settings-dark-390](comparison/settings-dark-390-side-by-side.png) | 2.36177 | 2.47205 |
| [settings-light-1440](comparison/settings-light-1440-side-by-side.png) | 3.14687 | 2.40021 |
| [settings-light-390](comparison/settings-light-390-side-by-side.png) | 2.36086 | 2.47114 |
| [settings-transcript-menu-light-1440](comparison/settings-transcript-menu-light-1440-side-by-side.png) | 未拍 | 3.31708 |
| [tools-open-light-1440](comparison/tools-open-light-1440-side-by-side.png) | 1.03882 | 1.03882 |
| [workspace-menu-light-1440](comparison/workspace-menu-light-1440-side-by-side.png) | 0.29826 | 0.29979 |

## 重算与复核

在本目录用带Pillow的Python运行 `scripts/compare-pixels.py .` 和 `scripts/compare-followup-regions.py .`。指数和热图均用原始RGB；热图显示×4，Δ>16仅为诊断。脚本保留本任务路径，不是可在任意宿主直接运行的安装器。

提交后的完整浏览器/真实后端回执保存在任务根 `pixel-followup-20261020/postcommit/receipt.json`，避免为记录回执再次改变已测试提交。Git提交SHA以该回执及最终交付为准。
