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
| Host/daemon 崩溃与清理 | 壳持两 Child；daemon 受真实父 PID 与 state 级租约保护；有清理回执，未知保留归属且阻止重启 | worker setsid，不能以父进程退出代替子树证明；真实进程回收 E2E OPEN |
| 外链与工作区文件 | 外链协议白名单、无凭据/私有token、原生确认后系统打开；文件权限沿用现有面板 | 系统打开/下载/新窗口兼容待验证，未声明全部完成 |
| LCU 状态与连接入口 | 沿用 1bb 的延迟连接、未知结果、清理与代次边界；不随壳启用 LCU | 实际 LCU 首调历史 BLOCKED；原隔离 true probe 已失败且授权消费，不重试。原生截图/输入 E2E OPEN |
| Chrome computer use | 仍是明确 opt-in，扩展与 origin 未安装/注册 | OPEN，需要独立批准与实际能力验证；不等于侧栏 Browser |
| Harness 侧栏 Browser 的租约/隔离分区 | qi 无等价原生浏览器会话后端 | 明确功能缺口 OPEN；不以普通外链/LCU 标签代替，需新增后端与产品决定 |
| Platform 登录、内嵌账号文档 | qi 无对应 Platform 账号/文档凭据隔离后端 | OPEN；不能冒充同名服务或复制账户凭据，需要产品决定 |
| 终端与 CLI | 随包 Rust CLI 为 Host/daemon 使用；现有 bash 工具不是完整侧栏 PTY | 系统 PATH 注册未授权；侧栏 PTY 是新增后端缺口 OPEN |
| 独立 Python/Office/Node/pnpm 工作区运行时 | 本轮闭包为 Node+bb+Rust+Web 与 qi 资源 | Python/Office/pnpm 未提供，不能称运行时等价；需独立组件/许可证与功能实施 |
| 自动更新/强更、签名公证、发布交接 | 明确禁用；本地包仅 ad-hoc，不新建密钥、签约公证或发布 | OPEN，需要更新服务、产品配置及独立签名/发布授权 |
| 版本与运行时闭包 | core/壳版本、源码 SHA、资源逐文件哈希、目标架构、原生依赖检查 | 最终包与签名后字节验证、离开源码目录及离线 smoke OPEN |

Tauri 采用系统 WebView；[capabilities](https://v2.tauri.app/security/capabilities/) 不给远程 Host 页面原生 IPC、shell 或任意文件权限。目录、外链及进程控制留在 Rust 原生菜单，Web 继续走现有认证 Host。[资源打包](https://v2.tauri.app/develop/resources/) 与 [macOS 应用包](https://v2.tauri.app/distribute/macos-application-bundle/) 按当前 Tauri 2 官方机制实现。

现有完整后端与 Host 失败、LCU 原生失败、真实模型未验均保留。原隔离恢复之前，不通过换执行工具/环境、去掉 sandbox 或接受绿色子集来关闭这些门槛。
