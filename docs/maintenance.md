# 可恢复的开发维护闭环

入口为 `npm run maintenance -- --help`。支持人工发起的单任务候选、容器验收、人工接受、持久复盘和精确提交发布闸门；另有默认关闭的预授权无人值守队列、宿主费用代理和定时服务，配置与启用门槛见 [有界无人值守维护](unattended-maintenance.md)。候选仍需人工审查，不自动 push / merge / release，不声明 GASP 协议兼容。

## 控制器与候选

控制器从干净、固定提交的 checkout 运行，状态目录必须位于该 checkout 与目标仓库之外。`prepare` 保存合同、策略、源码、profile、验收器的哈希，创建独立 detached worktree；已有开发工作区可以有未提交修改，控制器不会重置它。

候选只能交付合同列出的普通文件。规则、控制器、权限、测试、CI 和发布链属于受保护路径，需另行人工实现和审查。第一版不自动删除文件，不启动子 Agent。专用父 runtime 强制 32 步、关闭逻辑重试；预留的只读子步骤限制为 8，尚未启用子任务。

命令均为 argv 数组。验收容器断网、非 root、只读根目录，能力集清空，不挂载宿主凭据或 Docker socket。源码只读挂载后复制到临时构建目录，新增可信验收只读挂载到 `/acceptance`，候选无法修改它。测试通过依赖退出状态和预声明 TAP 测试名；这不是对任意恶意运行时或内核攻击的安全证明。

每次检查使用新容器，产物不跨检查共享。镜像须包含该任务的工具和离线依赖；`maintenance/image/Dockerfile` 提供 Rust、Babashka、Node 和 Chromium 的固定工具链配方，启动时从只读缓存初始化工作目录。镜像构建成功与完整容器验收分别记录，缺少环境的检查会阻断，不能标成不适用。空间受限时可按 [远程宿主验证](remote-maintenance.md) 将 CI 导出的固定镜像加载到飞牛等 ARM64 宿主。

`node maintenance/build-image.mjs /absolute/image.json [EXACT_BASELINE_SHA]` 从干净提交构建镜像。历史基线与当前源码的 Cargo 锁文件不同时，显式提供基线 SHA，将两套依赖预取到镜像；构建回执同时记录 source_sha 和 baseline_sha。历史基线仍按原锁文件执行，不用当前依赖覆盖旧证据。两者的 npm 锁文件必须相同，否则构建会拒绝，需要分别制作精确依赖镜像。

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

预算为一个活动任务、一个写入者、最多三次实现尝试、45 分钟总墙钟，其中 10 分钟预留给验收和保存。失败后 `retry --revision N` 只能重开已知失败，沿用原期限、累计次数，使用新 run_id。相同交付指纹再次失败会因无进展停止。旧直连模式费用账本不完整时，不允许无人值守付费或第二次付费尝试；新的 budgeted 模式由宿主代理逐请求预留额度，未知调用仍阻断后续任务。

成功得到 `review_ready`，不是 accepted。控制器用独立 Git index 从已验收快照生成候选 commit（`refs/maintenance/TASK_ID/RUN_ID`），不继承候选工作区的暂存内容或 clean filter；完整 diff 包含新增文件和可执行权限。检查期间文件集合、内容或权限变化均使证据失效。控制器保存文件内容、diff、测试日志。审查者另存：

```json
{"role":"human","reviewer":"actual reviewer","decision":"approve","summary":"具体审查结论","head_sha":"EXACT_CANDIDATE_SHA"}
```

然后用 `accept --id TASK_ID --revision N --review /absolute/review.json` 记录人工接受。候选 head、工作区内容、index 或当前 `main` base 改变时，接受会被拒绝。该命令不合入或推送；CLI 本身的操作权限是信任边界，JSON 字段不是身份认证。

## 交付到 Web 的只读验收回执

Web 可在已有合同候选工作区内进行普通交互编码；同一 daemon 的写入者仍受 workspace lease 约束。
停止写入者后，继续使用独立可信控制器的 `verify`，成功后才用 `maintenance/export-web-receipt.mjs`
导出本轮回执。导出器不会实现、验收、接受、推送或合入任何候选，也不能改变保存的控制器和验收材料。
Web 宿主固定私有回执目录与可信控制器 SHA，在读取时对账完整源码；未核实结果保持 UNKNOWN / NOT_RUN。
参数、文件范围和信任边界见 [独立验收回执](workspace-files.md#独立验收回执)。

## 故障与恢复

状态按 `queued → scoped → implementing → verifying → review_ready → accepted` 演进；失败、阻断、取消和未知结果分别保存。每条事件包含序号、前项哈希和 fencing token，证据写入并 fsync 后才推进状态。文件锁不按超时强抢，只能显式恢复已确认死亡的本机 PID。

`recover` 将中断的创建、已准备任务、实现、验收标为 uncertain，绝不自动重放。新执行器在运行前记录 Docker container 名和随机所有权标签；恢复时先核对标签，再按不可变 ID 停止遗留容器。旧记录没有所有权回执的容器仍需人工核对。正常命令超时会停止容器。尾部半条日志、哈希变化、证据丢失均阻断，原日志保留。

`restore --id TASK_ID` 只恢复已验证、材料仍完整且目录已丢失的候选。它核对内容哈希和 Git tree，不恢复凭据、进程或外部动作，不覆盖现存目录。材料本身丢失时必须从备份或固定提交重建并重新验证。

外部操作可先用 `action-intent --action STABLE_ID --evidence description.json` 记录意图，取得回执后用 `action-result --result confirmed|not-applied --evidence proof.json` 对账。重复 identity 不会再次授权；未对账意图阻断新任务。这两条命令只记账，不执行 push / PR / 发布。

## 用量与真实评测边界

`usage/request` 在主循环及压缩调用前、结束后保存同一 request_id，失败和重试也保留；子 runtime 使用同一入口，JSON 事件带所属 session / agent。记录 provider、model、purpose、attempt、已返回 usage 和耗时，不复制 prompt 或密钥。

这是**逻辑请求**账本。provider 内部传输重试和最终账单仍可能不可见，`accounting_complete=false`、`cost_usd=null`。控制器保存已知小计，缺失总额不填零。budgeted 模式另存宿主请求预留和按审核价格上界结算的记录，两种 scope 分开；它不将配置价格下的限制宣称为供应商账单对账完成。

```sh
npm run test:maintenance
QI_MAINTENANCE_IMAGE='trusted-node-image@sha256:...' \
QI_MAINTENANCE_OUTPUT=/absolute/new-evidence-directory npm run test:maintenance:docker
```

容器 smoke 运行合成缺陷的 nop / oracle、只读挂载和超时清理，oracle 应到 review_ready，nop 不得通过。另有 qi-smoke 全项目演练和 broker-smoke 断网代理演练。它们均不是模型成绩；无人值守资格另要求匹配执行材料的真实 dev/heldout 试跑，完整 Harbor 横向比较仍按 `evals/harbor/README.md` 独立执行。

`qi-smoke.mjs EXACT_BASE_SHA ABS_NEW_OUTPUT [EXACT_ORACLE_SHA]` 的已知参考实现
默认固定在 `a0b74ad310aa0e0978f747369c41315560aa6dd3`，只取两份压缩请求归属相关
源码，并在回执中保存 `oracle_sha` 和逐文件 SHA-256。可显式指定另一个完整提交；
缺失对象或文件立即失败，不回退到 HEAD。需要完整 Git 历史或明确保留参考提交的对象。
参考实现与控制器、当前应用源码分别记录，避免后续生命周期事件等无关变化被整文件带入
历史基线，破坏原有测试。当前源码仍独立运行完整测试；离线 oracle 通过不能代替其验收。

## 有游标的复盘

`report-telemetry.mjs` 只读取显式提供的 session-root，不扫描整个用户目录。新输出的
`sources` 包含路径、时间覆盖、事件数量/类别和来源指纹，不包含消息正文、工具参数或密钥。
`source_status` 分别报告 missing_source、no_events、unclassified、classified 或 incomplete；
生产组同时携带 session/run 样本数，N=0 的错误率和费用仍为 null。session/source 只影响
其后的事件，跨午夜和恢复不能将旧数据重新归类。

`qi-agent doctor` 的 `telemetry_sources` 提供 supervisor 已登记的会话文件与状态目录路径；
它不读取会话正文、不推测其他磁盘/机器覆盖，也不会创建任务或调度。

```sh
node maintenance/run.mjs review-window --state /absolute/private/maintenance-state \
  --repo /absolute/qi-agent --start EXACT_START_SHA --end EXACT_END_SHA --limit 50 --output /absolute/window.json
node maintenance/run.mjs review-record --state /absolute/private/maintenance-state \
  --repo /absolute/qi-agent --window /absolute/window.json --review /absolute/report.json
```

首次必须提供明确 start，后续从已持久报告的 end 接续。使用 first-parent 连续提交范围；每个合并提交的审查覆盖其相对 first-parent 的完整 diff。报告必须含非空 `summary` 和与窗口逐项相同的 `reviewed_commits`。只审前 50 条就只推进至第 50 条；无新提交不输出状态消息。这里验证的是覆盖声明和持久性，审查深度仍由审查者负责。

`lesson --incident incident.json` 接收 pattern_key、incident_id、occurred_at 和 evidence。按 Asia/Singapore 的独立事故日期去重；达到三日只产生 proposal_ready，不自动修改规则。定时服务默认关闭，在取得试运行证据、选定时间后由用户启用。

## 发布闸门

main 每次 CI 使用独立 concurrency group，避免运行中或 pending 的较早提交被新提交替换；PR 继续取消过时运行。发布解析 tag 后锁定 source SHA，只接受该 SHA 在本仓库 CI workflow 下的最新 main run 和精确 run_attempt，五项必需 job 均需成功。API 错误、缺页、截断和并发重跑按 UNKNOWN 阻断。

package checkout 固定 SHA；publish 再核对标签、CI、四个平台完整产物、原始 SHA256 和 source manifest，并验证来源 SHA 对应的 GitHub attestation。GitHub tag 在最终检查与发布 API 之间仍存在时间窗口，应配置远端 tag 不可变规则；本地脚本不代替仓库权限配置。

依据：[GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)、[精确 attempt 的 jobs](https://docs.github.com/en/rest/actions/workflow-jobs)、[并发与 pending 规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[attestation verify](https://cli.github.com/manual/gh_attestation_verify)。
