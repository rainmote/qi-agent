# 离线盲测准备

## 默认 dry-run 的有界执行器

`memory-executor.mjs dry-run PACKAGE NEW_OUTPUT` 只核对既有盲测包并输出 120 条 NOT_RUN，
不读取 provider 凭据。`freeze-runtime NEW_RUNTIME` 固定最小执行材料：kernel、generation、
无工具 worker 与 mailbox relay 四个文件，拒绝额外材料。它不装入完整仓库、题库或参考答案。

实际执行是独立的 `execute PACKAGE NEW_OUTPUT CONFIG AUTHORIZATION`。专用 JSON profile
必须固定 model/effort、输入／输出字节上限、请求数 120、总墙钟和 max_retries=0；它是本实验
transport 的实际配置，不冒充完整标准 Agent profile。CONFIG 还绑定 profile 文件哈希、固定镜像、
只读 runtime 和共享的宿主预算 state-root，以及现有 broker 所要求的模型、上下文／输出 token 上限、
任务／每日费用和有效计价上界。共享预算目录必须预先建立；授权逐项绑定其 canonical state-root、
模型、profile、预算、输入、runtime 与镜像，不能换目录复用授权重置累计限额。JSON 是
可信宿主的审查回执，不是身份认证。任何一项缺失都不得 dispatch。

worker 运行在断网、非 root、只读根目录容器，数据只复制 model-inputs；另外只读挂载上述四文件
runtime、读写挂载无凭据 mailbox。答案和完整仓库留在 verifier 侧，模型没有工具或文件访问能力。
每次真正通过 `qi.generation/generate!`，原生 UUID 经 relay 到宿主 broker，先持久预留整模型输入
窗口与受限输出，再访问固定 provider。字节上限不是 tokenizer 测量；不把 chars/4 当硬 token 上限。
broker 固定输出 cap、禁服务端会话／远程工具与自动截断，并对未知费用按全额预留保守结算、停止后续请求。

暂停文件 `NEW_OUTPUT/pause.json` 或宿主取消会停止自有执行；超时、缺失终态、响应丢失、未知费用
保留 UNKNOWN 和原调用意图，不自动重试。多个实验应复用同一宿主预算 state-root；新输出目录不是
重置预算的方式。当前 run 的预留请求数与整个任务的累计数分别保留。
输出保留逐请求结果、原生事件、预算账本和原始执行回执。完成执行仍需在独立侧
用既有 `assembleRecall/grade` 规则评分；真实语义召回与完整账单未核对时保持 null。

测试使用 fake provider 和真实本机生成／broker 接线，不读取个人认证、不构成真实模型成绩。
真实 120 请求实验仍要求另行明确模型、profile、预算和调用授权；本候选不会自行启用或运行它。

## 运行交互时延矩阵

`bb --classpath src:plugins evals/experiments/interaction_latency.clj` 使用真实 runtime、队列、取消 token、
工具批次与 context manager，分别测慢模型、慢工具、分片压缩各 30 次引导与 30 次协作取消。
每条保留 native run、queue item、profile 与 runner 指纹，使用同一进程的单调时钟分别记录接收、消费与终态；
不得跨机器相减时钟。30 只是冻结 fixture 样本数，不是生产分位数。取消时压缩不得提交半成品 checkpoint。

浏览器生产 bundle + 隔离 API fixture 的渲染/回执时延应独立记录；不能把上述原生服务时间直接称为浏览器反馈。
目标接收 p95≤250ms、协作取消 p95≤1s；不协作 provider 的外部硬期限另以 daemon/process 矩阵验收。
本实验不加载认证、不调用真实模型、不生成生产样本、不修改运行策略，完整费用为 null。

`memory_recall.clj` 保留原来的理想标注表示对照，不是语义召回实验。
`memory-blind.mjs` 将相同的 20 条冻结开发历史投影为无答案的输入，并经实际
context manager 捕获 checkpoint 与临时分层摘要两组请求。最后一条历史约束也进入
压缩源；统一的当前查询保留在摘要之后。只有分层组替换摘要提示词，不新增生产记忆。

```sh
node evals/experiments/memory-blind.mjs prepare /absolute/new-experiment
```

输出 `model-inputs/plan.json`、独立 `verifier/answers.json` 和材料指纹/请求账本。
真实运行只能给模型挂载 model-inputs；原 fixture、verifier 和仓库源码必须在其文件系统
之外。这是目录分离约定，当前离线准备命令本身不创建 OS 沙箱。案号使用不带题意的 c01–c20；
改变隐藏标注、答案及原题名不会改变模型输入。

`assembleRecall(plan, summaryOutputs)` 在全部分片完整返回后生成统一召回请求；
`grade(plan, references, recallOutputs)` 独立逐项比较 exact JSON 值，缺失、false/零混淆和
过期决定均不匹配，禁止操作约束遗漏另计。失败、重复、截断和缺失输出直接拒绝，不能省略后
计算成功率。导入数据的分数标为 offline-imported-outputs，model_semantic_recall 仍为 null；
开发集结果不能视为留出集成绩或分层记忆收益。

可传入第二个 JSON 配置文件，显式声明 model、profile_sha256、max_input_tokens、
max_output_tokens、input_usd_per_million、output_usd_per_million。120 次计划请求的
价格上界是 `120 × (输入上限 × 输入单价 + 输出上限 × 输出单价) / 1e6`；配置缺失时为 null。
单价是操作者声明的审核价格上限，当前没有选定任何真实模型或查询价格。原生字符估算不是
provider tokenizer；后续 transport 必须在发送前实际执行输入、输出、请求数和墙钟限制。
这里的声明上界不是已执行的费用硬限制，也不是供应商账单。失败、重试、压缩和最终召回均须
纳入真实账本；当前计划无重试，每条为 NOT_RUN，完整费用保持 null。

该包不提供网络 transport、不读取认证、不调用模型。真实实验仍需独立冻结模型/profile/预算、
取得调用授权并保存请求输出、失败用量和实际 provider 信息；不能用 dummy 摘要填造召回成绩。
