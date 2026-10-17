# Harbor 导出桥接

这部分把本仓库的开发题导出成 Harbor 数据集。导出和结构检查不调用模型、不安装依赖；**Docker 构建、Harbor 容器运行和三种 agent 的真实对比尚未在本机验证**。开发题用于调试评测链路，不能当成独立留出集发表排名。

## 已实现

- `export.mjs` 读取 `task.json`、`prompt.md`、`workspace/`、`verifier/`、`solution/`，导出 Harbor 标准目录。
- `environment/` 构建上下文仅包含原始 workspace；隐藏验收和参考解分别保留在 `tests/` 与 `solution/`。
- 显式使用独立 verifier 容器，从可信 workspace 和验收文件重建 `/grade`，只导入 `allowed_files` 指定的交付文件。
- 验收断网运行，提交代码使用 UID 1000，验收结果目录由 root 持有。拒绝软链接和超过 1 MiB 的单个交付文件。
- 除了要求测试退出码为零，还逐项核对 `acceptance_tests` 声明的测试名称与 TAP 结果，提前 `process.exit(0)` 不会被视为全部通过。
- 记录源任务内容哈希、导出器/验收器/评分逻辑 SHA-256、Node 镜像和所依据的 Harbor 源码版本。输出目录必须不存在，避免覆盖历史导出。

当前桥接只支持 `split: "dev"`、已有文件的修改、无额外包依赖的 `node --test tests/*.mjs` 题目。它只验收指定的交付文件，**不检查 agent 对原始 workspace 中其他文件的修改或删除**，因此不能声称它验证了完整的文件修改约束；不同 runner 的结果不要在未对齐口径时混算。权限隔离并不等于已完成恶意提交对抗评估。

## 导出与本地检查

从仓库根目录运行：

```sh
node --test evals/tests/harbor-export.test.mjs
node evals/harbor/export.mjs evals/tasks /tmp/qi-harbor-dev
```

也可仅导出一个或多个任务，在命令末尾增加任务 ID。程序接口：

```js
import { exportHarbor } from './evals/harbor/export.mjs';
await exportHarbor({ tasksRoot: 'evals/tasks', outputDir: '/tmp/qi-harbor-dev', taskIds: ['task-id'] });
```

可传入 `nodeImage` 覆盖默认 `node:22.14.0-bookworm-slim`。该标签包含版本，但不是不可变 digest；正式跑分应换成已验证的 `node@sha256:...`，保存最终导出目录和 `export-manifest.json`。不要将整个任务源目录挂载进 agent 容器。

## Docker 主机上的验证顺序

需要可用的 Docker daemon、Python ≥ 3.12，以及包含独立 verifier 功能的 Harbor。文档和源代码核对日期为 2026-10-03；本次依据的 Harbor 源码为 `bf991e490394ef9c3250a6db2bc5cbda903cb4c3`（包声明 `0.23.0`）。在线文档示例使用 schema `1.3`，该固定源码的默认值已是 `1.4`；导出跟随固定源码使用 `1.4`。由于版本号不能唯一表示源码，建议在独立虚拟环境按 commit 固定：

```sh
python3 -m venv .venv-harbor
.venv-harbor/bin/python -m pip install 'git+https://github.com/laude-institute/harbor.git@bf991e490394ef9c3250a6db2bc5cbda903cb4c3'
.venv-harbor/bin/harbor run -p /tmp/qi-harbor-dev -a oracle -n 1 -k 1 -r 0
.venv-harbor/bin/harbor run -p /tmp/qi-harbor-dev -a nop -n 1 -k 1 -r 0
```

这两项是待运行的集成验证命令，不是已通过记录。要求 oracle 每题 reward=1、nop 每题 reward=0；镜像构建或传输系统故障要单列为环境失败，agent 删除了必须交付的文件则是任务失败。执行后确认实际用的是独立 verifier、artifact 恢复路径正确，再进行收费模型运行。

## Claude Code 与 Codex

两者使用 Harbor 的内置适配器。以下命令要求事先在当前 shell 配置对应 API 凭证，并把模型和 CLI 版本变量设为本轮冻结的值；不要把密钥写入任务、镜像或命令行参数。

```sh
.venv-harbor/bin/harbor run -p /tmp/qi-harbor-dev -a codex \
  -m "${CODEX_MODEL:?Set a fixed provider/model}" --ak "version=${CODEX_VERSION:?Set a fixed CLI version}" \
  -n 1 -k 3 -r 0
.venv-harbor/bin/harbor run -p /tmp/qi-harbor-dev -a claude-code \
  -m "${CLAUDE_MODEL:?Set a fixed provider/model}" --ak "version=${CLAUDE_VERSION:?Set a fixed CLI version}" \
  -n 1 -k 3 -r 0
```

保存每次 job 的 config、trial 结果和原始轨迹。`-k 3` 是每题 3 次尝试，`-r 0` 禁止自动重试，避免隐藏失败开销；环境或限流失败仍需记录并单独分析。正式运行前先用 `harbor run --help` 和固定源码核对参数，确认账号具有所指定模型的权限。这里不假设本机订阅登录会自动进入容器。

## qi-agent 自定义适配器

`qi_agent.py:QiAgent` 已实现固定 Harbor API 的 `BaseInstalledAgent`。它使用明确标识的 `qi-openai-single-agent-v1` 配置：OpenAI Responses、固定模型与 reasoning effort、12 个步骤、基础读写/终端工具和 `hash_edit`，不启用子 agent、REPL、LSP、个人资源和压缩。这是 qi 的单 agent 基线，**不能标为完整默认产品配置的跑分**。

该 profile 设置 `:sandbox :none`，让终端工具使用 Harbor 外层隔离容器；它只能在隔离任务容器内执行 agent，不能用于宿主机真实运行。测试在宿主机只执行不会调用模型或工具的 `--list` 启动检查，并确认 `bash` 工具存在。

适配器只快照上传 `qi_source_dir` 下 `src/`、`plugins/` 中非隐藏的源码/资源文件，拒绝软链接；不会上传根目录配置、`evals/`、凭证或历史状态。它生成专用 profile，工作目录和 trust root 固定为 `/app`，状态目录隔离到 `/installed-agent/qi-home`。只从 Harbor runner 环境读取 `OPENAI_API_KEY`，不读取或复制订阅登录文件。原始事件保存在 `/logs/agent/qi-output.jsonl`，stderr 单独保存；配置、源码/profile/adapter 哈希及 Babashka 版本写入 `qi-config.json`。总 token 与费用保留未知。

**前提仍是镜像中已安装固定版本 Babashka。**适配器不会下载安装器。默认导出的 Node 镜像没有 Babashka，因此 qi 运行前要用经过验证、包含 Node 与 Babashka 且不包含个人认证的镜像重新导出。为保持比较条件一致，三种 agent 应使用同一镜像。

```sh
# QI_EVAL_IMAGE 需是已验证的 Node + Babashka 镜像，正式评测固定 digest。
node --input-type=module -e 'import { exportHarbor } from "./evals/harbor/export.mjs"; if (!process.env.QI_EVAL_IMAGE) throw new Error("Set QI_EVAL_IMAGE"); await exportHarbor({tasksRoot:"evals/tasks", outputDir:"/tmp/qi-harbor-with-bb", nodeImage:process.env.QI_EVAL_IMAGE});'
PYTHONPATH="$PWD/evals/harbor${PYTHONPATH:+:$PYTHONPATH}" .venv-harbor/bin/harbor run \
  -p /tmp/qi-harbor-with-bb -a qi_agent:QiAgent \
  -m "${QI_MODEL:?Set openai/model explicitly}" \
  --ak "qi_source_dir=$PWD" --ak "reasoning_effort=${QI_EFFORT:?Set supported effort explicitly}" \
  -n 1 -k 3 -r 0
```

测试已覆盖源码上传边界、参数必填、shell 引号、凭证传递和费用未知，并在有 Babashka 的本机执行生成 profile 的 `--list` 启动检查；这些检查不发起 API 调用。Node 测试入口会运行 Python 标准库 contract tests，Python 侧的离线启动项在没有 Babashka 时明确 skip。

```sh
node --test evals/tests/harbor-qi-agent.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s evals/harbor -p 'test_qi_agent.py' -v
```

**真实 Harbor 容器与模型请求尚未验证**。接下来仍需在 Docker 主机验证 oracle/nop，再做 qi 单题联调，检查日志中的有效模型、源码快照、工具和实际 artifact 传输，最后扩展到 5 题；未经这些验证不能发布三者排名。没有安装系统软件或复制本机认证文件来代替这些前提。

## 依据

- [任务配置与 schema](https://docs.harborframework.com/core-concepts/tasks/configuration)
- [独立 verifier 与 artifact 恢复规则](https://docs.harborframework.com/core-concepts/tasks/separate-verifier)
- [参考解运行规则](https://docs.harborframework.com/core-concepts/tasks/solution)
- [运行 job 和尝试次数](https://docs.harborframework.com/core-concepts/jobs/run-a-job)
- [内置 agent](https://docs.harborframework.com/core-concepts/agents/pre-integrated-agents)
- [自定义 agent](https://docs.harborframework.com/core-concepts/agents/custom-agents)
- [固定 Harbor 源码](https://github.com/laude-institute/harbor/tree/bf991e490394ef9c3250a6db2bc5cbda903cb4c3)
