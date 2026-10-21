# 桌面工作区运行时与终端

参考为官方 Harness `687f282e8625c6b8d11ff58211a90524be2e4317` 的
`scripts/primary-runtime/lock.json`、`pnpm-lock.yaml`、Office provider 和终端职责。
本轮未运行新的参考界面。下面区分源码、静态验证和实际能力；没有依赖归档、真实
运行或原生 E2E 的条目不能按已完成交付。

## 随包依赖

`apps/desktop/workspace-runtime-sources.json` 固定 macOS arm64 Python 3.12.14、
13 个 Python wheel、pnpm 11.28.5、Office kit 0.1.5 的 20 包闭包，以及 xterm 6.0.0
与 fit 0.11.0，共 37 个输入。每项记录官方来源、大小上限及 SHA256/SRI。
Python 提供 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml、
XlsxWriter 及其锁定依赖。未包含 JVM、系统 PATH 注册、扩展或系统权限安装。

归档下载与准备分开；项目内的[国内镜像预设及校验下载](desktop-dependency-mirrors.md)
提供离线计划和显式下载命令。默认仍为官方来源，不自动更改 npm/pip 或系统配置。

`scripts/desktop/workspace-runtime.py` 仅从 `QI_DESKTOP_CACHE/workspace/<name>`
读取已锁定归档，不下载、运行安装脚本、执行包或查找宿主 Python。先核验整个闭包，
再写入新的 build-owned 目录；缺失或哈希不符时不创建输出。Tar 链接仅解析归档内
普通文件并物化成文件；拒绝路径越界、设备、外链、重复身份和解压超限。Wheel 按
METADATA 的 Name/Version、dist-info 目录及锁定版本精确比对，并要求闭包完整。
保留实际许可证/通知文件；许可证缺失不能用包元数据声明代替。
Wheel 的 `.data` 根也须严格匹配同一发行身份。`purelib`/`platlib` 进入包目录；
XlsxWriter 的 `vba_extract.py` 等辅助 `scripts` 仅保留在
`python/share/qi-wheel-data/<发行名-版本>/scripts/`，普通文件模式 0644，不进入
PATH 或 Python 导入目录，不改 shebang、不执行安装。未知安装 scheme 仍拒绝。

pnpm 原归档同时包含部分其他平台的可选 reflink 模块。arm64 派生输出仅在同归档
父包 `optionalDependencies` 与子包的名称、精确版本、`os`、`cpu` 一致时筛除
darwin-x64、win32-arm64-msvc、win32-x64-msvc 三个目录，保留 arm64 原字节；
缺少目标模块或身份/平台不明确均失败。`workspace-manifest.json` 记录排除清单，
不按验证失败结果泛删 native 文件，原锁定归档和失败暂存目录不变。

npm 归档未附许可证正文时，只接受固定 `apps/desktop/notices` 中精确包版本绑定的
补充正文：文件名和 SHA256 一致、许可证标识匹配，并提供冻结 Git commit/原文
blob 绑定，或同版本已锁定父包的精确依赖关系、归档 pin、路径及原文字节证明。
组装说明、README 的单个 SPDX 声明和标准模板不能代替发布者正文。
实际已取得 saxes 6.0.0 的冻结 ISC 正文及 Koffi 3.1.1 父包的原 MIT 正文。
fontkit 2.0.4、dfa 1.2.0、brotli 1.3.3 的锁定包及冻结源码仍缺库级正文；brotli
另有 Google 2013 的 Apache-2.0 文件头，不能被单一 MIT 声明覆盖。它们继续阻塞
完整准备；未将标准 Apache 文本或字体测试资料的许可证冒充这些库的授权正文。

桌面 prepare 必须完成整个闭包，之后才编译 Rust/Web 并组装 runtime。普通 Web
构建不包含 xterm，明确显示不可用。桌面构建把锁定 xterm 静态打进前端；无 CDN、
动态代码求值、自动终端输入或剪贴板 addon。运行时逐文件清单封存最终字节，静态
验证遍历所有 Mach-O，而非只检查 Node/bb/qi 三个入口，检查 arm64、最低 macOS、
依赖与 rpath。只有实际选中 arm64 header 为 `MH_EXECUTE` 的主程序才能解析自身
`@executable_path`；FAT 表、CPU subtype、对齐和 load-command 长度须有效。
库和未知类型仍不能猜测嵌入 Node/Python/engine 的路径上下文。

Pillow 12.3.0 的固定 libjpeg 原文含一条构建机绝对 rpath。构建只对原 wheel pin
及 libjpeg 原 SHA256 双重绑定的新副本，删除这条未被静态依赖使用的路径，并做
无密钥/时间戳服务的 ad-hoc 重签与严格验证。变换须保持 `MH_DYLIB`、完整架构、
`LC_ID_DYLIB`、依赖和最低系统版本；没有外部路径白名单或泛化重写。工作区清单
记录原/派生哈希、移除项和工具哈希，再绑定最终 runtime 字节。源码和纯 fixture
通过不代表此原生变换、Python 导入或完整包已实际通过。

Office kit/engine 声明 MPL-2.0。除许可证外，重新分发前还须核验所携对应源版本、
修改与构建资料；上游来源为 `https://github.com/deepseek-ai/dsh-libreoffice-kit`。
实际归档、许可证和对应源材料未到齐、未审查前，不能称该闭包已获重新分发验收。

## 执行与 Office

仅显式 `QI_AGENT_REPOSITORY_ROOT` 的桌面 payload 且清单校验成功才选用这些运行时。
不从项目目录、用户 PATH、pip/npm 配置或宿主 Python 回退。ExecutionWorld 保留原
沙箱和工作区写范围，只增加 payload 的只读授权；子进程使用私有工作区 HOME/tmp、
清空继承环境、关闭 Python 用户包和 pnpm 联网/安装脚本。

`office_preview` 在运行时齐备时才注册，走既有工具、项目信任、计划和人工审批。
策略中的 bash 禁止也约束此工具。输入须是已授权工作区文件，受大小/变更校验；
固定引擎在同一 ExecutionWorld 内转成新的 PDF，检查签名、大小和发布 inode，
排他创建，不覆盖原文或既有目标。取消/超时/失败为未确认结果，不自动重放。
文件面板对支持的 Office 文件提供明确的“生成 PDF 并预览”，用户确认新的输出路径后
才走同一工具门禁，正常文件读取不触发转换。成功回执须来自实际工具执行，包含规范
输出路径、大小和 converted 标志；计划拦截不能被当成生成成功。复用既有同源 PDF
内容接口，未新增 Host 执行入口或放宽 CSP；超过 8 MiB 仅显示信息。取消先到也会
留下有界、不可淘汰的请求记录，满额关闭新准入。重载后保留原 command_id、路径和
取消入口，不自动重做或预览未知结果。实际引擎与浏览器交互仍未验证。这与 Harness
自动、无用户副本的内嵌 Office 预览有产品差异，界面明确说明新 PDF 会保留。

## 终端源码与强制不可用边界

提供了会话内租约、有限 RPC、命令幂等、审批/信任/计划、输入大小、取消和关闭、
输出游标、UTF-8 与配额源码。Web 面板只把用户明确发送的文本提交审批；输入不随
终端输出自动回写。切换会话、关闭面板、未知结果均不重发输入。此设计与 Harness
直接键入交互存在差异，不能描述成完全等价。

**本机 production PTY 仍强制不可用。** 独立复核确认：仅以 session/process group
或 ps 快照，不能证明 double-fork/setsid 后已 reparent 的后代退出；macOS SDK 的
NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD 自 10.5 起已不受支持。因此 world 不提供
terminal factory，controller 在创建状态目录/进程前拒绝，Python helper 在 census/
fork 前拒绝。该门禁没有环境变量、配置、模型参数或用户输入覆盖开关。需要实现并
验证可证明后代归属与销毁的执行提供者，不能靠放宽沙箱或授予 TCC 来替代。

保留的守护进程协议不把未知清理变成成功；超时/权限错误后 sticky UNKNOWN，后续
close 不重做本机观测/发信号。未确认的 guardian 保留身份。Native 私有 ACK 仅使用
RAM 中独立一次性 UUID，不把 capability 放进可继承环境；注册持久化后才允许进入
下一步。严格 retire 在 proxy 已证明退出后再读取最终同代 descriptor，合并所有
已登记 helper，拒绝新/异 PID，再检查退出，不用提前快照证明清理。

这些清理源码只获得 mock/纯数据/编译证据，没有运行本机 PTY 或原生进程探针。
当前不可用状态是保留未完成功能，不能将它当作“终端验收通过”。

## 本轮验收状态

归档/协议、策略/审批和链接器测试均是纯 fixture 或 mock。用户授权正式本机开发
入口后，37 项真实依赖已下载并按原 hash 全量重算；旧网络失败、截断文件和预算
中断材料保留。首次完整准备因 XlsxWriter 辅助脚本的 wheel scheme 被拒，修复仅
保留惰性辅助资料并加强身份边界；随后准备被真实 npm 许可证缺口阻断。
辅助脚本与许可证来源回归均有目标失败/通过对照；实际 Office/Python/pnpm 与
原生 E2E 仍待验证，未以模板通过许可证门禁。

真实 App 首次在原执行器启动于 AppKit 注册阶段 SIGABRT，未进入 qi setup；随后
限定同一 PID/时间段的只读系统日志查询也被 sandbox 拒绝。该历史日志查询未重试；
新本机执行授权与原产品工具隔离分别记录，不能据此把所有失败关闭。
LCU、DMG、TSX 及完整后端既有失败也保留，详见外部验收收据与功能对照。构建存在、
绿色子集或 mock 不能关闭真实 E2E 门槛。
