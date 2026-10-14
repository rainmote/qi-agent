# 有界无人值守维护

目标是自动领取**预先批准的任务**，在隔离环境修改并验收，停在 `review_ready` 供人工审查。候选不能改变控制器、预算、验收或调度规则；没有自动合并、推送或发布。默认配置 `enabled=false`，缺少真实试跑证据不能启用。

## 费用与权限边界

付费入口为 `run --budgeted-live --budget /absolute/budget.json`。候选容器完全断网，不持有 API key；容器内 HTTP relay 只向专用 `/gateway` 目录写请求。宿主 broker 检查路由、模型和请求类型，持久化费用预留后才向固定的 OpenAI Responses 地址发出一次请求。禁止重定向、远程图片/文件、托管工具、会话引用与后台生成。普通函数工具的执行仍在候选容器内。

`budget.json` 必须明确模型、effort、单任务/滚动 24 小时费用、请求数、模型完整上下文窗口、输出上限，以及有来源和失效时间的价格上界。价格需覆盖该模型所有输入档位和缓存写入收费；缓存命中按普通输入价格计，不预先使用折扣。每次预留 `完整输入窗口 × 输入价格上界 + 输出上限 × 输出价格上界`，并向上取整到微美元。额度不足时不会调用模型；余额尚够实际短请求却不足最坏预留时，同样停止。

只有返回匹配模型、默认服务档位和有效 token 用量，才释放未使用的预留。失败、超时、响应丢失或费用字段不明时保留整笔占额，阻断所有新请求，重启和跨日不能清零。无论调用来自主循环、压缩还是工具直接访问代理，都经过同一个宿主预算。

这保证的是**审核价格配置下的请求费用上界**，不是供应商最终账单证明。`invoice_cost_usd` / `total_cost_usd` 继续保留为 null。模型窗口或价格填错会破坏上界假设，应使用专用项目凭据并在供应商侧另设可用的消费限制。未知费用只能凭实际提供方回执使用 `reconcile-budget --review receipt.json` 对账；`resume` 不会抹掉费用。

请求账本保留原生 run/root-run、compaction-id 与分片序号；代理记录自己的不可复用请求 ID，并关联原生逻辑请求 ID。`run/end.request-usage` 汇总主调用、压缩和失败请求的已知 token 与未知请求数；原 `usage` 字段保留主循环统计语义。维护 worker 另有 64 个逻辑请求、32 步、35 分钟实现上限，外层继续强制 45 分钟总时间。

API 字段依据：[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[token 用量说明](https://developers.openai.com/api/docs/guides/token-counting)。`max_output_tokens` 包含推理与可见输出，不以输出文本长度代替账本。

## 工具链与验收

`maintenance/image/Dockerfile` 固定 Node/Rust 基础镜像 digest、Babashka 版本及校验和、npm/Cargo 锁文件和 Playwright 浏览器版本。当前镜像基线为 Linux ARM64；其他架构需要重新固定对应镜像并验证。构建阶段可下载依赖，运行阶段断网；依赖缓存保存在只读镜像，node_modules 和编译输出复制到每次独立的可写目录，供 Vite 写入配置缓存。每个浏览器检查在自己的容器里先构建，不借用其他检查的产物。Rust 调试信息与增量缓存关闭以控制磁盘开销。

```sh
node maintenance/build-image.mjs /absolute/evidence/image.json
QI_MAINTENANCE_IMAGE=sha256:EXACT_IMAGE_ID node maintenance/qi-smoke.mjs \
  c40b3eb181f2156e5fbf796835847b692b47da3f /absolute/new-qi-smoke
QI_MAINTENANCE_IMAGE=sha256:EXACT_IMAGE_ID node maintenance/broker-smoke.mjs /absolute/new-broker-smoke
```

qi-smoke 对 qi 自身的已知压缩记账缺陷运行完整 baseline、有效 red、离线 oracle、完整 candidate 检查，并运行当前控制器提交的全部测试。包含生产浏览器和 daemon E2E。broker-smoke 验证断网、无凭据和宿主预扣款。两者**模型调用均为 0**，不能作为真实模型资格证明。独立 GitHub `Maintenance container` 工作流保留镜像、日志和报告，不接收模型密钥。

合同可声明 `resources`：cpus、memory_mb、work_mb、tmp_mb、pids；上限分别为 4、6144、6144、1024、1024，纳入任务哈希。完整 qi 演练使用这些上限，正式任务应按实测耗时设置；不能以资源不足为由删掉必需检查。

## 首次配置与资格试跑

1. 使用干净的、单独审查过的控制器 checkout；复制 `budget.example.json` 并填写真实模型、审核价格和额度。占位符不会通过校验。API key 仅通过宿主的 `OPENAI_API_KEY` 环境变量提供，不写入 JSON、命令参数、镜像或 vault。
2. 生成匹配的专用 profile：`node maintenance/profile.mjs MODEL EFFORT /absolute/agent.edn /absolute/budget.json`。
3. 填写两个独立任务合同，`split` 分别为 `dev` 和 `heldout`；留出题的答案不能出现在控制器、镜像、提示词或候选可读材料里。每个任务固定镜像、base SHA、允许文件、可信验收目录与检查清单。
4. 分别执行 `prepare`、`run --budgeted-live`，通过后执行 `record-trial`。`trial_passed` 是评测证据，不是人工接受或合入。每次先完成上一任务，再准备下一任务。
5. 在 `runner.json.trial_ids` 填写两次真实试跑。准入会核对真实费用事件、试跑结果及相同的控制器、镜像、profile、预算；版本变化后旧资格不能复用。

```sh
node maintenance/run.mjs prepare --state /absolute/state --repo /absolute/qi-agent --task /absolute/dev-task.json
node maintenance/run.mjs run --state /absolute/state --id DEV_TASK --budgeted-live --budget /absolute/budget.json
node maintenance/run.mjs record-trial --state /absolute/state --id DEV_TASK
```

## 批准任务与运行

`authorization.example.json` 要填写实际授权人、任务 ID、到期时间，权限固定为 candidate-only。授权绑定精确合同、源码 base、控制器、profile、验收器和预算；改动这些材料需要新的任务身份与批准。入队不启动计时，实际领取任务后才开始 45 分钟预算。

```sh
node maintenance/run.mjs enqueue --state /absolute/state --repo /absolute/qi-agent \
  --task /absolute/task.json --budget /absolute/budget.json --approval /absolute/authorization.json
node maintenance/doctor.mjs --state /absolute/state --image sha256:EXACT_IMAGE_ID \
  --budget /absolute/budget.json --config /absolute/runner.json
node maintenance/run.mjs tick --state /absolute/state --config /absolute/runner.json
node maintenance/service.mjs --state /absolute/state --config /absolute/runner.json
```

服务每 30 秒检查一次配置的每日窗口，不调用模型做调度；窗口错过不追赶。每天最多领取一次，一次一个活动任务；已有待审候选时等待人工处理。示例窗口为 Asia/Singapore 02:00–03:00，启用前应确认时间并将 `enabled` 改为 true。`tick` 和服务都在启动时恢复已确认死亡的旧控制器，不抢活进程的锁。空队列、窗口外、重复 tick 不输出通知；失败、待审候选、暂停等有变化时输出 JSON 事件，可由调用方接入通知。

## 停止、故障与恢复

`pause` 不需要取得执行锁，写入原子停止标记；基线、实现和验收执行器均检查该标记，停止运行中的容器并拒绝启动后续检查，任务保留为 cancelled。服务收到 SIGTERM/SIGINT 也会先暂停，再等待有界清理。重启后根据持久记录中的容器名与随机所有权标签检查容器，使用检查到的不可变容器 ID 清理；不会删除同名但所有权不同的容器。

```sh
node maintenance/run.mjs pause --state /absolute/state --reason "operator stop"
node maintenance/run.mjs recover --state /absolute/state
node maintenance/run.mjs reconcile-budget --state /absolute/state --review /absolute/provider-receipt.json
node maintenance/run.mjs resume --state /absolute/state --review /absolute/recovery-review.json
```

中断任务仍标记 uncertain，不自动重放。恢复审查需提供 `role: human`、`reviewer`、`summary` 和所有 uncertain 任务的 `task_ids`。提供方回执还需 `request_id`、`provider_receipt`、实际 `charged_microusd`；费用未知未解决时拒绝恢复。自动任务失败后会暂停整个队列；它不会为了继续运行扩大预算、修改验收、提升权限或自动合并。
