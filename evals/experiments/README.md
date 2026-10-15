# 离线盲测准备

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
