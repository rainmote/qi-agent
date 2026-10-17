# Agent 评测开发工具

这是第一阶段的可复现评测基础，尚无 qi-agent、Claude Code、Codex 的真实成绩。
默认命令完全离线，不加载模型凭据、不调用模型、不修改当前项目运行配置。

## 已实现与未验证

| 能力 | 状态 |
|---|---|
| 5 个合成开发题及中文需求 | 已实现；明确标为 `dev`，不是留出集 |
| 缺陷版本、参考解、37 个独立验收用例 | 已实现；原始版本必须完整执行测试且断言失败，参考解必须全通过 |
| 新工作目录、新验收目录、交付白名单 | 已实现；本地仅用于可信 fixture，不构成 OS 安全沙箱 |
| 独立 JSON 结果、日志、候选文件、HTML/Markdown 报告 | 已实现 |
| qi / Codex / Claude 参数规划、原始输出归一化 | 已实现；只规划，不在本机直接启动真实 agent |
| Harbor 任务导出及独立 verifier 配置 | 已实现；容器联调尚未验证 |
| qi 的 Harbor 适配器 | 已实现显式模型的单 agent 基线；离线接口和 profile 启动已验证，尚未容器联调 |
| 全任务模型费用账本及硬费用上限 | 尚未实现；缺失费用保持未知 |
| 30 个真实留出任务与三产品成绩 | 尚未建立，不用开发题自检冒充 |

本地工具按 Node >=22.12 设计；不需要新增 npm 依赖。正式容器环境和 CLI 都要固定版本。

## 使用

在仓库根目录运行：

```sh
npm run eval:doctor
npm run test:eval
npm run eval:validate
npm run eval:smoke
```

`doctor` 仅检查 Node、Babashka、Codex、Claude、Docker、Harbor 的程序版本，不读取登录文件，
也不能证明账号已登录或模型可用。

`validate` 对每题运行一次原始版本和参考解；`smoke` 默认各运行三次，共 30 次离线验收。
`noop` 不修改缺陷代码，预期失败；`oracle` 复制参考解，预期成功。
这两组的通过率只验证评分流程，不代表模型的编码能力。

可指定任务、重复次数和全新输出目录：

```sh
node evals/run.mjs smoke --task dev-001-latest-request --repeat 3 --out evals/results/my-smoke
node evals/run.mjs report --input evals/results/my-smoke
```

输出目录不可复用，避免旧结果污染新实验。`evals/results/` 和 `evals/exports/` 已被 Git 忽略。

每次实验保留：

```text
manifest.json          # 题目、评测器、当前 agent 源文件内容指纹；commit 和工作区是否有改动
results.jsonl          # 每次尝试的结构化结果，缺失费用为 null
report.json            # 汇总和逐题结果
report.md / report.html # 可阅读报告；HTML 可按配置和结果筛选
runs/<run-id>/
  result.json
  candidate/           # 实际交付文件
  changes.json
  verifier.stdout.txt
  verifier.stderr.txt
```

仅拷贝允许交付的源文件进入全新验收目录；验收测试来自原始题库，不能被候选代码替换。
除了进程退出码，评分还要求 TAP 中全部指定测试名称、数量和通过状态一致，且没有跳过、取消、TODO。
这会拒绝提前 `process.exit(0)` 一类虚假通过。它不宣称能防御任意恶意运行时代码；
真实 agent 提交必须在独立容器中验收，不要把未知代码交给本地 fixture 校验器。

## 参数规划与真实运行

复制 `config.example.json` 到已被忽略的 `*.local` 文件，填写明确的模型、源码和专用 profile 路径。
占位模型会被拒绝，配置中不要放密钥。

```sh
node evals/run.mjs plan --config evals/experiment.local --agents qi,codex,claude --task dev-001-latest-request
```

这只输出 `plan.json` 中的 argv，不执行命令。qi profile 必须同时固定主/子 agent 的模型、推理参数、
插件、步骤上限和上下文管理。当前仓库默认选择 `chatgpt`，因此实验不能依赖 README 或用户默认值。
实际调用还需要新账号配置目录/会话、明确工具权限、独立工作区以及时间和费用约束。
不要直接把计划命令在当前开发仓库执行。

真实隔离评测的任务导出：

```sh
node evals/run.mjs export-harbor --out evals/exports/dev-v1
```

详见 [Harbor 桥接说明](harbor/README.md)。导出器不安装 Docker/Harbor、不下载镜像、不调用真实模型。
导出清单明确保留 `container_integration_validated: false`；先跑 Harbor `nop`/`oracle`，
确认测试镜像、隔离和交付传输确实可用，再开始模型调用。

本地与 Harbor 的共同判定是白名单交付文件通过固定验收。另有一个明确差异：
本地 fixture 流程还会拒绝工作目录的非白名单修改；Harbor 只传输白名单文件，
不会检测原 agent 容器里其他文件是否被改动。两者不能直接混成一个严格约束通过率。

`harbor/qi_agent.py` 提供 qi 的 OpenAI Responses 单 agent 基线：只上传 `src/` 和 `plugins/`
中的源码，生成专用 profile 和 `/app` 范围的 trust 记录，不复制个人认证、状态、开发题和参考解。
模型、推理级别、源码和 profile 指纹会写入日志。它没有启用子 agent、REPL、LSP 或压缩，
因此只能标记为此基线配置，不能当成默认完整 qi 产品的成绩。任务镜像仍须预装固定版本的 Babashka。

## 指标口径

- 一次成功：一次完整运行在预算内交付并通过独立验收，不等于一次模型请求。
- 稳定成功：同一题第 1、2、3 次独立运行全部成功。少于三次标为未统计。
- 成功成本：全部尝试成本除以成功次数，包含失败成本。费用不完整时不计算。
- 缓存、推理 token 是供应商计量的明细/子集，不应重复加到总 token 上。
- qi 的最终 `usage` 不包含完整子 agent 和语义压缩用量，失败用量也可能缺失。
- Claude 的 `total_cost_usd` 保留为报告估算，不能当成已核对的实付费用；订阅费用不按零处理。
- `normalizeTranscript` 的执行状态不能代替任务验收结论；原始 transcript 应独立保留。
- 当前工具不提供小样本显著性、产品优劣或成本排名。

## 下一阶段实验协议

先跑通这 5 个开发题的容器对照；然后从实际工作中准备 30 个任务：缺陷 10、功能 8、重构 6、终端 6。
冻结任务、参考解、验收器和环境后才开始正式比较，每个系统每题三次，共 270 次。
正式任务应覆盖多个代表性仓库，从修复前快照启动，不暴露后续提交、参考解和其他试验结果。
开发题与留出题分开，不一边调整 agent 一边用留出题选参数。

整体产品对比与同模型框架对比分开，固定实际可用的模型版本；不要假定三个产品支持同一模型。
按题目配对分析，重复试验按题聚类；基础设施失败预先定义处理规则，不能事后任意删除。
建立全请求账本后再开展费用比较，涵盖主/子 agent、压缩、重试、缓存和失败调用。

## 依据

- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code 程序化运行](https://code.claude.com/docs/en/headless)
- [Harbor 自定义 agent](https://docs.harborframework.com/core-concepts/agents/custom-agents)
- [Harbor 独立 verifier](https://docs.harborframework.com/core-concepts/tasks/separate-verifier)
- [Anthropic agent 评测方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
