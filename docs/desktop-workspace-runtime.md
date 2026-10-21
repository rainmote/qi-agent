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

`scripts/desktop/workspace-runtime.py` 仅从 `QI_DESKTOP_CACHE/workspace/<name>`
读取已锁定归档，不下载、运行安装脚本、执行包或查找宿主 Python。先核验整个闭包，
再写入新的 build-owned 目录；缺失或哈希不符时不创建输出。Tar 链接仅解析归档内
普通文件并物化成文件；拒绝路径越界、设备、外链、重复身份和解压超限。Wheel 按
METADATA 的 Name/Version、dist-info 目录及锁定版本精确比对，并要求闭包完整。
保留实际许可证/通知文件；许可证缺失不能用包元数据声明代替。

桌面 prepare 必须完成整个闭包，之后才编译 Rust/Web 并组装 runtime。普通 Web
构建不包含 xterm，明确显示不可用。桌面构建把锁定 xterm 静态打进前端；无 CDN、
动态代码求值、自动终端输入或剪贴板 addon。运行时逐文件清单封存最终字节，静态
验证遍历所有 Mach-O，而非只检查 Node/bb/qi 三个入口，检查 arm64、最低 macOS、
依赖与 rpath。无法解析的嵌入宿主相对链接保持失败，不能猜测为可移植。

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
生成的 PDF 使用既有文件面板；尚未实现 Harness 的无文件 Office 内嵌预览等价流程。

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

归档/协议、策略/审批和链接器测试均是纯 fixture 或 mock。Office 仅语法及源码
核对，37 项真实依赖归档缺失；一次 Python 归档下载失败、一项 npm xterm 请求
DNS 失败后均已停止，没有换源、重试或执行第三方包。

真实 App 首次在原执行器启动于 AppKit 注册阶段 SIGABRT，未进入 qi setup；随后
限定同一 PID/时间段的只读系统日志查询也被 sandbox 拒绝。没有再次启动或换入口。
LCU、DMG、TSX 及完整后端既有失败也保留，详见外部验收收据与功能对照。构建存在、
绿色子集或 mock 不能关闭真实 E2E 门槛。
