# 可恢复的开发维护闭环

入口为 `npm run maintenance -- --help`。当前实现支持人工发起的单任务候选、容器验收、人工接受、持久复盘和精确提交发布闸门。它不创建定时任务，不自动 push / merge / release，不声明 GASP 协议兼容。

## 控制器与候选

控制器从干净、固定提交的 checkout 运行，状态目录必须位于该 checkout 与目标仓库之外。`prepare` 保存合同、策略、源码、profile、验收器的哈希，创建独立 detached worktree；已有开发工作区可以有未提交修改，控制器不会重置它。

候选只能交付合同列出的普通文件。规则、控制器、权限、测试、CI 和发布链属于受保护路径，需另行人工实现和审查。第一版不自动删除文件，不启动子 Agent。专用父 runtime 强制 32 步、关闭逻辑重试；预留的只读子步骤限制为 8，尚未启用子任务。

命令均为 argv 数组。验收容器断网、非 root、只读根目录，能力集清空，不挂载宿主凭据或 Docker socket。源码只读挂载后复制到临时构建目录，新增可信验收只读挂载到 `/acceptance`，候选无法修改它。测试通过依赖退出状态和预声明 TAP 测试名；这不是对任意恶意运行时或内核攻击的安全证明。

每次检查使用新容器，产物不跨检查共享。镜像须包含该任务的工具和离线依赖；qi-agent 全项目检查还需要 Rust、Babashka、Node 依赖和浏览器缓存。为其准备工具链镜像时，应在镜像的启动工具中从只读缓存初始化工作目录。缺少环境的检查会阻断，不能标成不适用。

## 手动使用

先保留一个经过审查的控制器提交，再从它建干净 worktree。后续维护代码的改动不会自动更新已经保存的控制器材料。

```sh
git worktree add --detach /absolute/trusted-controller EXACT_REVIEWED_SHA
cd /absolute/trusted-controller
node maintenance/profile.mjs EXPLICIT_MODEL SUPPORTED_EFFORT /absolute/private/agent.edn
```

模型和 effort 必须填写账号实际支持的值。生成的 profile 只用于隔离维护容器，不应作为宿主机默认 profile；它不加载订阅认证、个人资源、调度、插件管理或桌面工具。容器需事先安装固定 Babashka。

复制 `maintenance/task.example.json`，填写真实复现、精确 base SHA、镜像 digest、允许文件和独立验收目录。行为修复的验收用 Node TAP 包装目标行为，导入 `/work` 中的候选源码。旧实现必须在完整测试名下因断言失败；零测试、语法错误、skip、超时无效。`maintenance/checks.json` 是 qi-agent 代码任务强制执行的最低集合，Web / daemon / 协议变更还必须包含浏览器检查；macOS 专项仍须独立记录。

```sh
node maintenance/run.mjs prepare --state /absolute/private/maintenance-state \
  --repo /absolute/qi-agent --task /absolute/task.json
node maintenance/run.mjs status --state /absolute/private/maintenance-state --id TASK_ID
```

可以手动编辑返回的候选工作区后调用 `verify`；也可以提供离线实现器 JSON：`{"mode":"offline","paid":false,"unattended":false,"argv":["node","trusted-command.mjs"]}`，命令在候选容器中执行。

```sh
node maintenance/run.mjs run --state /absolute/private/maintenance-state \
  --id TASK_ID --driver /absolute/offline-driver.json
node maintenance/run.mjs verify --state /absolute/private/maintenance-state --id TASK_ID
```

要实际调用 qi，操作人显式执行 `run --supervised-live`，只传入环境中的 `OPENAI_API_KEY`。这个命令会产生模型请求，不是离线验收。已验证的基线和有效 red 必须先通过，才允许写入者开始。请求失败不会绕过验收。

预算为一个活动任务、一个写入者、最多三次实现尝试、45 分钟总墙钟，其中 10 分钟预留给验收和保存。失败后 `retry --revision N` 只能重开已知失败，沿用原期限、累计次数，使用新 run_id。相同交付指纹再次失败会因无进展停止。费用账本不完整时，不允许无人值守付费或第二次付费尝试。

成功得到 `review_ready`，不是 accepted。控制器用独立 Git index 从已验收快照生成候选 commit（`refs/maintenance/TASK_ID/RUN_ID`），不继承候选工作区的暂存内容或 clean filter；完整 diff 包含新增文件和可执行权限。检查期间文件集合、内容或权限变化均使证据失效。控制器保存文件内容、diff、测试日志。审查者另存：

```json
{"role":"human","reviewer":"actual reviewer","decision":"approve","summary":"具体审查结论","head_sha":"EXACT_CANDIDATE_SHA"}
```

然后用 `accept --id TASK_ID --revision N --review /absolute/review.json` 记录人工接受。候选 head、工作区内容、index 或当前 `main` base 改变时，接受会被拒绝。该命令不合入或推送；CLI 本身的操作权限是信任边界，JSON 字段不是身份认证。

## 故障与恢复

状态按 `queued → scoped → implementing → verifying → review_ready → accepted` 演进；失败、阻断、取消和未知结果分别保存。每条事件包含序号、前项哈希和 fencing token，证据写入并 fsync 后才推进状态。文件锁不按超时强抢，只能显式恢复已确认死亡的本机 PID。

`recover` 将中断的创建、实现、验收标为 uncertain，绝不自动重放。运行前已记录 Docker container 名；若整个控制器进程被杀，先按该名称检查并停止遗留容器，核对副作用，再创建新合同。正常命令超时会停止容器。尾部半条日志、哈希变化、证据丢失均阻断，原日志保留。

`restore --id TASK_ID` 只恢复已验证、材料仍完整且目录已丢失的候选。它核对内容哈希和 Git tree，不恢复凭据、进程或外部动作，不覆盖现存目录。材料本身丢失时必须从备份或固定提交重建并重新验证。

外部操作可先用 `action-intent --action STABLE_ID --evidence description.json` 记录意图，取得回执后用 `action-result --result confirmed|not-applied --evidence proof.json` 对账。重复 identity 不会再次授权；未对账意图阻断新任务。这两条命令只记账，不执行 push / PR / 发布。

## 用量与真实评测边界

`usage/request` 在主循环及压缩调用前、结束后保存同一 request_id，失败和重试也保留；子 runtime 使用同一入口，JSON 事件带所属 session / agent。记录 provider、model、purpose、attempt、已返回 usage 和耗时，不复制 prompt 或密钥。

这是**逻辑请求**账本。provider 内部传输重试和最终账单仍可能不可见，`accounting_complete=false`、`cost_usd=null`。控制器保存已知小计，缺失总额不填零，也不会据此宣称实现了完整费用硬上限。

```sh
npm run test:maintenance
QI_MAINTENANCE_IMAGE='trusted-node-image@sha256:...' \
QI_MAINTENANCE_OUTPUT=/absolute/new-evidence-directory npm run test:maintenance:docker
```

容器 smoke 运行合成缺陷的 nop / oracle、只读挂载和超时清理，oracle 应到 review_ready，nop 不得通过。它不是模型成绩，也不能代替 `evals/harbor/README.md` 的真实 Harbor 容器集成、冻结留出集或成本试验。未具备这些证据前保持人工发起。

## 有游标的复盘

```sh
node maintenance/run.mjs review-window --state /absolute/private/maintenance-state \
  --repo /absolute/qi-agent --start EXACT_START_SHA --end EXACT_END_SHA --limit 50 --output /absolute/window.json
node maintenance/run.mjs review-record --state /absolute/private/maintenance-state \
  --repo /absolute/qi-agent --window /absolute/window.json --review /absolute/report.json
```

首次必须提供明确 start，后续从已持久报告的 end 接续。使用 first-parent 连续提交范围；每个合并提交的审查覆盖其相对 first-parent 的完整 diff。报告必须含非空 `summary` 和与窗口逐项相同的 `reviewed_commits`。只审前 50 条就只推进至第 50 条；无新提交不输出状态消息。这里验证的是覆盖声明和持久性，审查深度仍由审查者负责。

`lesson --incident incident.json` 接收 pattern_key、incident_id、occurred_at 和 evidence。按 Asia/Singapore 的独立事故日期去重；达到三日只产生 proposal_ready，不自动修改规则。定时 schedule 配置仍需在取得试运行证据、选定时间后由用户启用。

## 发布闸门

main 每次 CI 使用独立 concurrency group，避免运行中或 pending 的较早提交被新提交替换；PR 继续取消过时运行。发布解析 tag 后锁定 source SHA，只接受该 SHA 在本仓库 CI workflow 下的最新 main run 和精确 run_attempt，五项必需 job 均需成功。API 错误、缺页、截断和并发重跑按 UNKNOWN 阻断。

package checkout 固定 SHA；publish 再核对标签、CI、四个平台完整产物、原始 SHA256 和 source manifest，并验证来源 SHA 对应的 GitHub attestation。GitHub tag 在最终检查与发布 API 之间仍存在时间窗口，应配置远端 tag 不可变规则；本地脚本不代替仓库权限配置。

依据：[GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)、[精确 attempt 的 jobs](https://docs.github.com/en/rest/actions/workflow-jobs)、[并发与 pending 规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[attestation verify](https://cli.github.com/manual/gh_attestation_verify)。
