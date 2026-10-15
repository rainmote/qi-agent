# 计划、工作流与团队任务板

这三个插件把原有工具循环和研究型子代理连接成可恢复的协作流程。它们使用当前会话的 `:agent/durable-state` 保存数据，不创建另一个可任意读写文件的模型接口。每个插件的持久记录限制为 512 KiB；写入超过上限会失败，已保存记录保留。

Web 的「计划与协作」面板提供计划步骤、工作流、团队任务和收件箱。模型分别使用 `planning`、`workflow`、`team` 工具。工具成功只证明状态转换或任务提交成功，不能代替对实际交付物的检查。

## 装配和公共服务

在父 Agent 的 durable-state、subagent runtime 和 remote registry 之后装配：

```clojure
{:ns qi.plugins.planning}
{:ns qi.plugins.workflow}
{:ns qi.plugins.team}
```

三个插件均可使用空配置。不要把完整父插件表复制进默认子代理 profile；默认子代理继续使用既有的一层、只读研究工具和独立 REPL。父会话存在 team 插件时，子代理启动过程会增加一个绑定其真实身份的 `team` 工具，不增加文件写入或 shell 权限。

| 插件 | 服务 | 必需依赖 |
|---|---|---|
| planning | `:planning/runtime` | `:agent/durable-state` |
| workflow | `:workflow/runtime` | `:agent/durable-state`、`:subagents/runtime` |
| team | `:team/runtime` | `:agent/durable-state`、`:subagents/runtime`、`:session/store` |

公共服务提供 `:snapshot`（零参数）与 `:execute!`（`arguments execution`）。planning 额外提供 `:permitted?`（`tool-name action`），供直接服务/RPC入口在执行变更前检查。team 额外提供 `:child-tool`，只能由宿主使用；它生成一个绑定已注册子代理身份的工具，不接受模型提交的 actor 字段。

存在 `:remote/registry` 时，插件自动注册下表 RPC。`planning.submit` 带 `:blocking true`，协议宿主需要异步分派该调用，让 `interaction.resolve`、取消和状态读取仍能处理。其他调用立即返回；workflow 的后台节点由独立监督任务驱动。

## Plan：批准确切版本后执行

计划包括稳定 id、revision、标题和最多 64 个步骤。创建计划立即进入只读模式。正常路径为：

```text
draft → awaiting_approval → approved → executing → completed
                  └──────→ rejected
executing → paused → draft → awaiting_approval ...
任意活动状态 → cancelled
```

`submit` 向当前用户界面显示完整计划和确切 revision。没有活动用户界面时拒绝批准；通用 Full Access 配置不能代替计划批准。修改计划使旧批准失效；`start` 必须针对当前批准版本。步骤支持 `pending`、`in_progress`、`completed`、`skipped`，同一时间最多一个 `in_progress` 步骤。

这是一个**执行限制**，不只是提示词：插件同时在工具预检查和实际执行入口检查权限。预检查可能先于同批次的计划创建/暂停，所以执行前的第二次检查不可省略。只有处于 `executing` 的计划才开放一般变更工具；其他计划状态拒绝 bash、REPL、子代理启动、未知工具和其他变更能力。具体只读工具采用明确白名单。workflow 和 team 的服务入口也检查父会话的计划限制，包括直接 RPC 和子代理 team 桥。

暂停、取消及退出会协作式取消等待中的审批。`:ui/prompt` 自定义适配器必须观察请求里的 `:cancel-token` 并完成清理；计划插件不会中断审批线程，因为线程可能正在写入共享会话日志。内置 remote interaction 会删除待确认项并记录取消结果，重复取消后日志仍可继续写入。

**边界：**这个限制约束通过 Agent 工具/受保护服务发起的新操作，不是操作系统沙箱，也不会回滚已经产生的文件变更。暂停不声称能撤销一个此前已开始的外部动作。扩展插件的直接 RPC 必须主动调用 `:permitted?`，不能依赖模型工具钩子保护另一个入口。

worker 重启后，`executing`、`approved`、`awaiting_approval` 计划全部恢复为 `paused`，保留步骤进度并清除批准。恢复需要重新批准，旧的批准响应不能推进新版本。取消后的计划仍保持只读；只有用户 RPC `planning.exit` 可以退出计划模式。模型工具不暴露 `exit`。

| RPC | 参数 | 结果 |
|---|---|---|
| `planning.show` | 无 | `{revision, plan}` |
| `planning.create` | `title, steps: [{id,title}]` | 当前快照 |
| `planning.update` | `expected_revision, title?, steps?` | 当前快照 |
| `planning.submit` | `expected_revision` | 批准/拒绝后的快照；等待用户交互 |
| `planning.start/pause/resume/cancel` | `expected_revision` | 当前快照 |
| `planning.step` | `expected_revision, step_id, status, note?` | 当前快照 |
| `planning.exit` | `expected_revision`（存在计划时） | `{revision, plan: null}`；仅用户 RPC |

所有 `expected_revision` 都是 `plan.revision`，不是最外层持久快照 revision。冲突后读取当前状态，不应盲目重发变更。

## Workflow：受控 DAG、串行和并行研究

工作流定义是数据，不执行任意源码。每个节点包含 `id`、`prompt`、`depends_on`，可选 `provider`（`spawn` 或 `fork`）、`max_steps`（1–32）和 `output_schema`。定义支持：

- `pipeline`：自动依赖前一个节点。
- `parallel`：所有节点无依赖。
- `dag`：使用显式依赖；拒绝重复 id、不存在依赖和依赖环。

每个定义最多 64 节点，每个运行最多并发 4 个节点，同一会话最多 4 个活动工作流。每个会话保留最多 32 个定义和 32 个运行；终态运行可显式删除。运行保存定义的确切版本，不受后续定义更新影响。

`run` 立即返回持久运行 id。节点结果只来自注册子代理提供方；默认提供方仍为只读研究型子代理。工作流不创建工作树、不扩大工具授权，也不把任务板自动变成并行编码系统。

依赖成功后才启动下游，并把依赖结果标为不可信任务数据放入下游上下文。依赖失败/取消/跳过会导致下游 `skipped`，独立节点继续运行。声明了输出 schema 时，正常结果和人工恢复结果都进行验证，结构不符不得标记成功。

节点先持久记录 `running`，再进入 provider。provider 启动报错可能代表已开始但响应丢失，因此整次运行转为 `uncertain`，不会把它当成可自动重试的失败。取消和新节点启动共用准入锁；取消返回后不会再启动该运行的新节点。被取消的正在运行节点带 `outcome_uncertain: true`，不声称已经撤销其作用。

worker 停止/重启后，运行中的工作流与节点标记 `uncertain`，不会自动重放。恢复步骤是：

1. 查看 retained 子代理和实际结果，确认已完成、需要跳过，或可以重试。
2. 用户通过 `workflow.reconcile` 逐个处理 `uncertain` 节点，并填写核对依据。
3. 用户通过 `workflow.resume` 恢复。已经完成的节点保留结果，只运行剩余 `pending` 节点。

模型工具不暴露 `reconcile/resume`。这两个入口只存在于用户 RPC/Web 面板，防止模型把自己的不确定状态当成自动重试许可。

| RPC | 参数 | 结果 |
|---|---|---|
| `workflow.show` | 无 | `{revision, definitions, runs}` |
| `workflow.define` | `id, title?, kind?, max_concurrency?, nodes, expected_revision?` | 定义；更新已有定义必须提供确切 revision |
| `workflow.run` | `id, expected_revision` | 异步运行对象，包含 `id` |
| `workflow.status` | `run_id` | 运行对象与各节点结果 |
| `workflow.cancel/delete` | `run_id, expected_revision` | 运行/删除回执 |
| `workflow.reconcile` | `run_id, node_id, expected_revision, status, evidence, result?` | 运行；status 可为 pending/completed/failed/skipped，completed 必须有 result |
| `workflow.resume` | `run_id, expected_revision` | 恢复后的运行 |

定义 CAS 使用 definition.revision；运行操作使用 run.revision。读状态不会改变 revision；运行期间节点推进会改变 revision，冲突说明应先刷新。

## Team：共享任务和隔离邮箱

任务板最多保存 64 个任务。任务包含 `id/title/depends_on/status/revision`，可有描述、负责人和完成结果。依赖必须来自同一个任务板，拒绝环。任务状态为 `todo/claimed/completed/cancelled/needs_review`。

领取、分配、完成、重新开放和取消使用任务自己的 revision CAS。两个成员同时领取同一版本时只有一个成功。依赖未全部完成，或者任务分配给别人时不能领取。只有负责人或父会话可以完成任务；只有父会话可以改依赖、分配、重新开放或取消。不能重新开放/取消仍有活动或已完成下游任务的依赖，必须先处理下游。

成员范围仅包括当前会话 owner 和本会话子代理注册表中的存活成员。模型/RPC schema 不接受 actor 身份。子代理的 team 桥由宿主绑定真实 id，不能发送冒名消息、读取其他成员邮箱或确认其消息。子代理启动提示会说明检查自己的任务和邮箱；发信只写入持久邮箱，不会暗中启动一个额外模型回合。

邮箱最多保存 256 条待确认消息，每条最多 8000 字符。`ack` 确认并移除收件人自己的消息，为之后的消息释放空间。任务分配/取消只改变协作记录，不等同于自动启动/中断某个子代理；需要执行时仍使用原有子代理控制工具。

worker 重启把已领取任务转为 `needs_review`。父会话必须提供核对依据才能完成或重新开放这些任务，避免恢复时重复领取未知工作。成员邮箱跨恢复保留。

| RPC | 参数 | 结果 |
|---|---|---|
| `team.show` | 无 | `{revision, owner_id, tasks, members, member_id, unread}`；不包含他人消息正文 |
| `team.create` | `id, title, description?, depends_on?` | 新任务 |
| `team.update` | `id, expected_revision, title?, description?, depends_on?` | 更新任务，仅 owner |
| `team.assign` | `id, expected_revision, assignee` | 更新任务，仅 owner |
| `team.claim` | `id, expected_revision` | 以实际调用成员领取 |
| `team.complete` | `id, expected_revision, result, evidence?` | 已完成任务；恢复任务要求 evidence |
| `team.reopen/cancel` | `id, expected_revision, evidence?` | 更新任务，仅 owner |
| `team.send` | `recipient, message` | 持久消息回执 |
| `team.mailbox` | 无 | 实际调用成员的消息 |
| `team.ack` | `message_ids` | 已确认 id |

## 任务树用量边界

原生父子 run 保留各自的 `request-usage` 会话小计，父结果另给 `root-request-usage`。子会话在原根会话
日志持久写入最小请求索引；只按真实 root-run 身份聚合，不扫描用户目录、不把两个小计再相加收费。
登记但未结束的子 run、未结算请求、不能关联原生执行身份的外部 provider 都使任务树完整性为 false。
外部 CLI 的自报 usage 不被推断为本地逻辑请求账本。独立人工压缩不猜测归属；完整费用继续为 null。
索引依赖原来的会话写入与取消边界，不增加子代理权限或自动重放。详见 [任务树记账](runtime-integrity.md)。

## 离线验证

### 可选外部 CLI 契约 PoC

`qi.plugins.subagent-external-cli` 可向现有 registry 注册 `:external-cli`，默认 profile 不装配它。配置必须显式提供 `:enabled true`、专用 `:workspace-root` 和以绝对可执行文件开头的 `:command` argv；可选 `:node` 指定 Node 路径。每次运行建立独立 work/home 目录，只向 CLI 传入 PATH、HOME、TMPDIR，不继承个人认证、环境密钥或用户启动文件。请求正文通过 stdin 发送，不拼入 shell。

这是 POSIX 离线契约实验。CLI 从 stdin 接收 `{type:"start",prompt,run_id}`，stdout 输出 JSONL `progress` 或唯一 `result`（status、output、可选 usage）。只有有效终态和零退出码共同成立才可 completed；缺失终态、超时分别记 uncertain。interrupt/stop 先固定取消结果，再终止整个进程组，迟到的 completed 不能覆盖它；输出和 stderr 尾部有上限。verification 固定 not-run，accounting_complete=false、total_cost_usd=null，外部声明不构成独立验收。

该实验没有把工作目录隔离当作操作系统沙箱。仅在专用外层隔离环境启用；它不宣称支持真实 Codex/Claude 协议、审批或费用。真实接入还须固定 CLI 版本、独立 profile 与显式实验授权；现有默认只读子代理保持原有装配。

`node --test evals/tests/external-cli.test.mjs` 使用 fake executable 检查 JSONL、独立 cwd、环境隔离、有界日志、非零退出、缺失/重复终态、取消竞态和不响应 TERM 的子孙进程回收，并经 Babashka registry 验证调用契约。无模型调用。

`qi.orchestration-test` 覆盖计划批准/拒绝/取消/版本失效、执行前复检、工作流并发/依赖失败/结构化结果、任务 CAS 与身份隔离、邮箱以及 RPC schema。`qi.orchestration-recovery-test` 覆盖未知 provider 准入、worker dispose、恢复不重放、人工核对后局部续跑、直接 RPC 的计划限制与依赖取消一致性。

`qi.planning-protocol-test` 启动独立 RPC worker 和临时真实会话文件，验证提交审批挂起时仍可读取状态/处理批准，以及连续六轮取消后会话日志可继续写入。`apps/web/tests/orchestration-browser.mjs` 在生产页面上使用固定 RPC 数据点击计划、DAG、依赖认领和邮箱流程，并检查 320/375/414/768/1440 宽度的内部及页面水平溢出；它已纳入 `test:web-browser:ci`。

测试使用临时文件和 mock 服务，不调用真实模型，不读取用户会话或凭据。它们验证编排控制语义，不构成真实模型交付质量或宿主进程隔离能力的证明。
