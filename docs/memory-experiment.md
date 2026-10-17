# 约束记忆的离线表示对照

F2 的开发集冻结为 `evals/experiments/memory-cases.json` 的 20 条历史，每条都超过 48K 字符，覆盖晚期否定、原样工具参数、零/false、旧决定替换及 Project/User/Ephemeral 范围。参考约束是显式标注，带 source-event、时间、范围及 supersedes；不从自然语言自动推断规则。

运行 `bb --classpath src:plugins evals/experiments/memory_recall.clj` 输出 JSON。checkpoint-only 通过现有 `context-summary/source`、`replacement` 保存完整参考约束；分层组使用同一参考标注生成临时 Markdown，经真实 resources catalog 读回 Project/User，并用临时 durable-state 保存同一 session 的 Ephemeral。测试核对非信任项目不可读取 Project、另一个 session 不继承 Ephemeral。所有临时目录在退出时清理。

这是确定性的表示层控制实验。两组共享完全相同的理想摘要 oracle，不能把参考标注的准确性算作模型能力；`model_calls=0`、`model_semantic_recall=null`。每条输出精确约束匹配、内容长度和源哈希，保留分层项来源和旧决定链。20/20 的预期结果只证明两种表示均能承载这些事实，没有证据表明新增分层记忆提高了真实摘要的语义召回。暂时保留现有 checkpoint/resources，不增加生产持久记忆。

临时 Markdown 明确标记 fixture-only，不会写入用户或项目的真实 AGENTS.md。普通会话不会从单次失败、猜测或测试事件自动升级规则。后续模型实验须在冻结历史、摘要预算、查询和评分器后，采用专用 profile 与明确预算；记录每次摘要及召回请求和失败，比较同一组输入，不能用本开发对照替代真实语义保真结果。
