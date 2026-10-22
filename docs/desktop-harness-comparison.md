# Tauri 桌面与 Harness 功能对照

参考冻结为官方 `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`，本轮只读源码及已有证据，未运行参考应用或新增参考实拍。主要职责依据 [Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/README.zh.md) 与 [打包说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/packaging/README.zh.md)。不复制 Electron API 或品牌，不假称 qi 有 Platform 后端。

**完成条件：下列约定功能实现且真实端到端验收通过。代码候选、mock、构建或安装包存在均不能单独使总验收通过。** 尚未构建/执行的项目保留开放，不自行接受例外。

| 功能/职责 | qi/Tauri 当前实施 | 验收与缺口 |
| --- | --- | --- |
| 共用 Web 会话、消息、工具/思考/子任务折叠、输入、设置、窄屏 | 复用 f7/1bb Web，Tauri 不重建前端 | 既有受控 Web 与真实离线后端证据不等于 Tauri 内通过；桌面真实 E2E OPEN |
| 本地 Host、探活、鉴权 | 原 Host 回环监听、随机 token→HttpOnly Cookie、Origin/CSP；token 只过私有 stdout 管道 | 新壳探活不代表 worker/model 成功；真实打包链 OPEN |
| Rust daemon/Babashka 运行时 | 打包 Node 官方独立发行包、Rust qi-agent、已安装的 Babashka 与 Clojure 资源 | 默认不需要 JVM；显式 JVM REPL/LSP 等未随包，不能声称提供 |
| 配置、会话与 Web 偏好持久化 | 独立 app_data 私有状态；首次随机端口持久化，冲突失败不转接他人 Host | 重新启动与 WebKit localStorage 实测 OPEN |
| 原生项目目录选择 | 原生菜单选择后预填既有 Web 确认框；确认后才走原 allowlist/信任流程 | 取消、重复选择、代次变化、旧结果晚到与真实窄屏 OPEN |
| 首次项目信任、受限、撤销、权限审批 | 沿用 f7 流程与后端命令幂等；选目录不授信、不扩大审批 | Tauri 内拒绝/取消/返回/刷新/项目切换 E2E OPEN |
| 窗口隐藏、退出、重复启动 | macOS 关窗隐藏；原生退出有返回；单实例与私有状态租约 | 真实系统窗口/第二实例/后台生命周期 OPEN |
| Host/daemon 崩溃与清理 | 壳持两 Child；真实父 PID、state 租约、同锁准入/排空；失败启动保留身份和 sticky UNKNOWN；仅 ESRCH 证明进程/组不存在 | worker setsid，不能以父进程退出、stopped 文件或权限错误代替子树证明；真实进程回收 E2E OPEN |
| 外链与工作区文件 | 外链协议白名单、无凭据/私有token、原生确认后系统打开；文件权限沿用现有面板 | 系统打开/下载/新窗口兼容待验证，未声明全部完成 |
| LCU 状态与连接入口 | 沿用 1bb 的延迟连接、未知结果、清理与代次边界；不随壳启用 LCU | 实际 LCU 首调历史 BLOCKED；原隔离 true probe 已失败且授权消费，不重试。原生截图/输入 E2E OPEN |
| Chrome computer use | 仍是明确 opt-in，扩展与 origin 未安装/注册 | OPEN，需要独立批准与实际能力验证；不等于侧栏 Browser |
| Harness 侧栏 Browser 的租约/隔离分区 | 已编写 macOS WK 原生子视图、工作区非持久分区、会话页签保留/显式恢复、前后导航与菜单、弹出请求需明确准备及打开；不向模型暴露网页工具 | 源码与纯单元/编译检查，不等于原生验收。真实分区、导航、焦点、弹层、窄屏、取消与清理 E2E OPEN；详见 `desktop-browser.md` |
| Platform 登录、内嵌账号文档 | qi 无对应 Platform 账号/文档凭据隔离后端 | OPEN；不能冒充同名服务或复制账户凭据，需要产品决定 |
| 终端与 CLI | 随包 Rust CLI；侧栏输入/取消/状态、会话协议和审批；显式 native-process-group，受信单会话分配器与原 Seatbelt 命令子进程分开，严格模式保持拒绝 | 用户明确接受脱离组后代残留，并批准最小分配器边界；仅承诺登记组和直接子进程的有界观察。真实组件结果须看精确收据，不等于完整 App E2E；OPEN。系统 PATH 注册未授权 |
| 独立 Python/Office/Node/pnpm 工作区运行时 | 已锁定 37 项官方输入、无安装执行的准备器、随包 PATH/私有 HOME、审批内 Office→新 PDF 工具及文件面板明确生成后预览、全 Mach-O 验证源码 | 用户授权正式本机开发入口后，37 项缓存均已按原 hash 重算；12 个 wheel 来自 TUNA，其余官方。完整准备仍被 fontkit/dfa/brotli 的实际许可证正文缺口阻断，未用模板通过门禁。实际导入、转换、pnpm、预览/取消/重载和离线 smoke OPEN；MPL 对应源/许可证须核验。qi 明确保留新 PDF 副本，未冒称 Harness 无用户副本预览等价。详见 `desktop-workspace-runtime.md` |
| 自动更新/强更、签名公证、发布交接 | 明确禁用；本地包仅 ad-hoc，不新建密钥、签约公证或发布 | OPEN，需要更新服务、产品配置及独立签名/发布授权 |
| 版本与运行时闭包 | core/壳版本、源码 SHA、资源逐文件哈希、目标架构、原生依赖检查 | 最终包与签名后字节验证、离开源码目录及离线 smoke OPEN |

Tauri 采用系统 WebView；[capabilities](https://v2.tauri.app/security/capabilities/) 不给远程 Host 页面原生 IPC、shell 或任意文件权限。目录、外链及进程控制留在 Rust 原生菜单，Web 继续走现有认证 Host。[资源打包](https://v2.tauri.app/develop/resources/) 与 [macOS 应用包](https://v2.tauri.app/distribute/macos-application-bundle/) 按当前 Tauri 2 官方机制实现。

现有完整后端与 Host 失败、LCU 原生失败、真实模型未验均保留。用户授权正式本机开发入口
只改变开发命令的外层执行条件，不放宽产品信任、审批或 LCU 工具隔离；新检查单独记录，
不用绿色子集覆盖旧失败或未验门槛。
