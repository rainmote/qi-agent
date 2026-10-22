# Tauri Core Preview

本发行配置响应 2026-10-22“qiagent 快速出一个可用版本”的优先级。它先交付对话与
会话、模型配置入口、本机命令及原生终端的最小桌面包；完整 Harness 对齐继续保留。
实际启动、核心交互和模型连接结果须以该包精确源码 SHA 的运行收据为准，不能把
构建或 mock 对话当成真实模型通过。

## 真实包含与排除

- 复用现有 Tauri 壳、Rust daemon/CLI、Node Host、Babashka 和共享 Web。
- 工作区锁为 `apps/desktop/workspace-runtime-core-preview.json`，仅含原全量锁中
  Python 3.12.14、xterm 6.0.0、addon-fit 0.11.0 三项原 pin 归档及其许可证正文。
  Python 原发行包的标准库、pip 和随附通知保留，没有安装额外 wheel。
- 不携带 Office kit/engine、fontkit/dfa/brotli 闭包、pnpm 和额外 13 个 Python wheel。
  不运行 Pillow 变换，因为它未进入本发行包；全部实际 Mach-O 仍需逐文件验证。
- 两层清单标记 `core-preview` 及分项组件。PTY 可独立解析 Python；Office 工具
  不注册、不执行，文件面板复用已有不可用原因展示。主界面明确标注预览版范围。
- LCU 仍默认关闭、需要独立连接/许可；未配置模型时使用现有模型设置入口，不创建
  凭据、不读取或复制用户其他应用的密钥。未配置连接不能宣称真实模型对话通过。

默认 `desktop:prepare/build/build-app` 仍是完整发行合同及全量许可证门禁；预览入口
没有跳过同一组件的许可证检查。预览版同样保留归档 pin、依赖闭包、通知正文、
资源封存、架构/链接器验证、项目可信、人工审批和原文件/网络沙箱。

## 包与状态隔离

应用名为 `qi-agent Preview.app`，identifier 为 `dev.rainmote.qi-agent.preview`。
单实例、应用数据和输出目录与正式版分开；不覆盖或安装正式应用。
采用 [Tauri 官方配置合并](https://v2.tauri.app/develop/configuration-files/) 的
`--config src-tauri/tauri.preview.conf.json`，没有增加 renderer capability 或 shell IPC。

开发者在原锁定缓存和离线 Rust 工具链齐备时运行：

```sh
npm run desktop:prepare-preview
npm run desktop:build-preview
npm run desktop:verify-preview
```

打包必须来自干净本地提交。产物位于
`out/desktop/0.1.0-core-preview-aarch64-apple-darwin-<commit>/qi-agent Preview.app`，
相邻 `build-receipt.json` 记录源码、资源和应用文件哈希。此入口只构建 `.app`，
不制作/挂载 DMG、不发布、不自动安装，不使用签名密钥或公证服务。
用户试用应直接打开交付的 `.app`，无需重走构建；本机 ad-hoc 包不等于已公证发行。

桌面从 Tauri 页面进入本地 Host 时，认证先经过受 CSP 限制的同源落地页，再移除 URL 中的
token；保留 `HttpOnly + SameSite=Strict`，避免 WebKit 在跨站 303 链中未发送 Cookie 而显示 401。
原生验收使用 schema 2：两个独立进程共享私有 fixture 的 state 和专用持久 WebKit store。
必须同时观察到无 token 的地址、真实可输入 App DOM，以及 WebKit 自身仅通过 Cookie 的
`/api/bootstrap` 成功；`PageLoadFinished` 和 Rust Bearer 探针不再单独构成启动通过。
第一阶段清理未知时不启动第二阶段，测试不复用用户应用状态或凭据。

ChatGPT 登录复用本机 Codex 的正常凭据读取路径，不把登录信息写入应用包。
含可选参数的内置工具使用 `strict: false`；两个 Responses 适配器对未声明的
`strict` 也明确发送 `false`，避免服务端将可选字段改为必填。显式且兼容的
`strict: true` 保留，执行前仍使用原 schema 做本地参数校验并经过原权限流程。
协议依据见 [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)。

桌面应用正常退出时，已确认清理的会话保留为可恢复的 inactive 状态；再次打开
复用原会话、worker 身份和配置快照。显式停止、归档以及普通 daemon 的退出语义
保持不变。清理结果未知时不会发布可恢复状态，未结算任务记录为 uncertain。

原生终端沿用 [明确的清理与权限范围](desktop-workspace-runtime.md)：登记进程组与
直接子进程回收，脱组后代和 TTY 路径复用风险仍存在。它的组件验收已完成；本包还
须实际验证启动、配置/会话、合成命令/终端、关闭和再次启动。Office、Platform、
完整 LCU 和全功能 E2E 保持后续目标，预览交付不会触发全功能完成 Bark。
