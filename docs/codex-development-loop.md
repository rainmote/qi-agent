# 用 Codex CLI 开发 qi-agent

`maintenance/codex.mjs` 将现有 ChatGPT 登录的 Codex CLI 接到维护控制器。默认模型为 `gpt-6.1-sol`，推理强度为 `xhigh`，保存在 `maintenance/codex.defaults.json`。模型只负责修改候选；测试、快照和候选提交仍由现有控制器生成。

这是人工发起的开发闭环：**固定任务 → 独立工作区 → 基线与缺陷复现 → Codex 实现 → 独立验收 → 失败反馈与修复 → 待审候选**。最多三次实现，共用原任务 45 分钟期限，最后 10 分钟保留给验收。相同补丁再次失败、模型失败、缺失终态、超时和未知执行结果都会停止；只有已知的验收失败可以在本次调用中自动修复。

## 启动

需要 Codex CLI 0.157.1、已有 ChatGPT 登录、Docker 和合同要求的固定验收镜像。版本升级后先复核 JSONL 协议，不静默接受新的事件格式。完整 qi-agent 代码任务仍需包含 Rust、Babashka、Node、Chromium 和离线依赖的工具链镜像。

```sh
node maintenance/codex.mjs doctor
```

从一个已经检查并固定提交的控制器目录运行。按 [维护说明](maintenance.md) 填写任务合同：精确 base SHA、允许交付的文件、独立验收目录、镜像 digest 以及检查集合。合同中的 `profile_path` 仍作为原维护合同的冻结材料保留；Codex 不读取这个 qi profile，实际模型参数以本入口的 `codex.defaults.json` 与记录的 argv 为准。

```sh
# 专用 profile 是合同材料，不提供 API key，也不启动 qi worker。
node maintenance/profile.mjs gpt-6.1-sol xhigh /absolute/private/agent.edn
node maintenance/run.mjs prepare --state /absolute/private/codex-state \
  --repo /absolute/qi-agent --task /absolute/task.json
node maintenance/codex.mjs plan --state /absolute/private/codex-state --id TASK_ID
node maintenance/codex.mjs run --state /absolute/private/codex-state --id TASK_ID
```

`doctor` 和 `plan` 不调用模型。`run` 使用订阅额度；不要求 OpenAI API key，不继承 API key 环境变量，不复制认证文件。它忽略用户 `config.toml`，明确指定模型、effort、ChatGPT 认证和 `workspace-write` 沙箱；shell 网络访问关闭，不申请全盘写权限。它保留 Codex 本身的登录管理与操作系统沙箱行为。

验收日志以诊断数据传回下一次实现，不能改写允许文件、验收器或任务合同。候选不得存在额外 `.codex` 启动配置，不能交付新的 AGENTS 指令。每次模型结束都同时检查进程结果与 JSONL 终态，模型声称成功不等于测试通过。成功返回 `review_ready`、候选 SHA 和独立验收证据。

## 暂停与恢复

```sh
node maintenance/run.mjs pause --state /absolute/private/codex-state --reason 'operator pause'
node maintenance/run.mjs status --state /absolute/private/codex-state --id TASK_ID
```

暂停、SIGINT 和 SIGTERM 会终止本次 Codex 进程组；验收阶段继续使用原有容器清理。状态目录保存启动意图、PID、argv、原始 JSONL、stderr 和退出结果。若控制器被 SIGKILL 或宿主中断，先核对记录的 PID、进程身份和候选文件；不要仅凭可能被复用的 PID 杀进程，也不要自动重放模型请求。未闭合的启动意图会阻断新任务，确认旧进程已停止后才按 `maintenance/run.mjs action-result` 的既有对账流程处理。

本入口不接收无人值守 API 队列、不创建定时服务。原 DeepSeek 的任务／滚动 24 小时美元预算不适用于 ChatGPT 订阅。记录 Codex 自报 token，小计不重复加缓存或推理 token；完整费用为 `null`，不是零费用。订阅限额或登录失败时停止，不自动切换 API。

## 范围与验证

当前使用宿主 Codex 沙箱写候选、Docker 执行独立验收，属于受监督开发。Codex 的宿主可读范围与原来的断网 qi worker 不同，不能将其作为原无人值守系统的隔离或费用资格。测试通过后继续人工审查；本入口不接受、合入、推送或发布候选。

`node --test maintenance/tests/codex.test.mjs` 覆盖真实本地子进程、独立 red/green、验收失败反馈、三次上限、无进展、暂停、超时、未知终态及中断意图。测试中的模型返回是 fixture；真实订阅和真实 Docker 试跑另行记录，不能用 fixture 声称模型效果。

新增入口为功能扩展，不替换已有缺陷行为，因此不要求在旧版上以缺失模块造成假 red；行为闭环本身在独立 fixture 中验证有效的旧实现断言失败和新实现通过。

参考：[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[Codex 非交互运行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)。
