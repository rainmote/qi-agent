# 基于清单的 Minimal / Code 实验

`bb --classpath src:plugins evals/experiments/profile_inventory.clj` 对 Standard、Creator 与两个实验 profile 输出实际 Kernel 插件、工具、策略与工具 schema 指纹。指定名称可单独运行，例如末尾加 `minimal`。所有项目、用户资源、信任文件和会话在临时目录中隔离；provider 使用明确的 deterministic-v1 fixture，不访问真实模型或个人认证。

实验 Minimal 保留会话、模型注册、只读工具、上下文预算、运行终态及策略/审批/沙箱。Code 额外注册 write/edit/bash。`qi.plugins.tools` 的可选 `:allow-tools` 只收窄本插件注册的工具；不设置保持既有集合，空数组表示不注册工具。它不会移除其他插件的工具、修改 ExecutionWorld 能力或替代策略与沙箱；不能将它当作整个系统的权限白名单。

每个 profile 执行相同的 read/edit/verify 三项离线脚本任务。fixture 仅信任自己的临时项目，并通过审批回调允许请求；生产配置保留 `:sandbox :auto` 与实验 profile 的 `:mode :ask`。缺少工具记录 MISSING_CAPABILITY，工具存在而执行失败记录 FAIL。运行终态与 fixture 的独立文件/输出检查分别显示；模型完成不会变成 verified。Linux 没有可用 OS 沙箱时，bash 能力缺失必须如实记录，不能改成无沙箱来获得成功。

输出的 composition-ms 只测当前进程内的插件装配，受命名空间冷/热加载和运行顺序影响，不代表应用冷启动或统计性能结论。每次实际请求记录完整 system/tools/messages/options 的哈希，并复用 context manager 估算包括系统提示、工具 schema、历史和 options 在内的输入 token，另列输出预留；它不是供应商 tokenizer 测量或账单。

两个 profile 位于 evals/experiments，未成为系统 preset 或生产默认配置。试验结果用于识别能力和开销，后续选择需结合真实任务；不能仅凭工具更少就宣称能力等价或更快。
