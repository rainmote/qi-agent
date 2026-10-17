# ACP 编辑器接入

`apps/acp/server.ts` 提供 ACP **v1** 的 newline JSON-RPC 2.0 stdio 入口，复用现有 daemon、session、模型配置和审批。它不是 OpenAI 兼容接口，也不宣称实现 ACP v2。

先安装项目依赖、构建 `qi-agent` 并配置本地模型。编辑器启动示例：

```json
{
  "command": "npm",
  "args": ["--silent", "run", "acp", "--", "--workspace", "/absolute/project"],
  "cwd": "/absolute/path/to/qi-agent"
}
```

必须使用 `--silent` 防止 npm 的脚本横幅进入 JSON stdout。也可直接用 Node 调用项目安装的 `tsx/dist/cli.mjs` 和 `apps/acp/server.ts`。重复 `--workspace` 可授权多个明确的根目录；省略时只授权启动目录。编辑器传来的 `cwd` 不能增加授权范围。`--state-dir` 仅控制 ACP 的会话索引，现有 daemon 的 runtime/state 目录仍由现有环境配置决定。

支持：

- `initialize` 协商 v1；`session/new/list/load/resume/close`，load 回放文字历史。
- `session/prompt` 的文字、PNG/JPEG/GIF/WebP、嵌入文字资源、授权项目内 `file:` 链接；附件保存为引用，到模型请求时才解析。
- `session/update` 的流式文本、工具开始与结果，保留工具调用 ID。
- `session/request_permission`：一次允许、会话允许、拒绝；未知选项、超时及取消均拒绝。新会话采用 ask policy，恢复时保留原会话策略。
- `session/cancel`、`session/set_model`、model 类 `session/set_config_option`。
- 客户端传入的 stdio/HTTP MCP server 经配置审批和连接审批接入；不静默忽略失败。

daemon 决定 turn 的最终 request ID；适配器采用 admission 返回值，并处理完成事件先于 admission 回包的情况。提示超时、断连和未知执行结果明确报 uncertain，不自动重放。关闭连接只取消本连接活动任务并释放连接，不停止共享 daemon。

限制：不接收账户凭证；不实现编辑器文件写入/terminal delegation、audio prompt、远程 resource_link、ACP v2；二进制非图片资源不宣称已解析。文件读取和命令执行由 qi 自身受控工具完成。文档预览、工作流、插件等可由工具使用，ACP 不额外扩大其权限。具体编辑器的配置格式可能不同，本仓库不宣称所有 IDE 的兼容性已经实测。

运行 `npm run test:acp` 验证协议、取消、权限、早到事件、路径边界及隔离 daemon。测试不需要真实模型或付费 API。

协议依据：[官方 ACP v1 文档](https://agentclientprotocol.com/protocol/initialization) 与[官方 schema](https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v1)。
