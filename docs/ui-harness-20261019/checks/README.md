# 验证记录

最终交付记录为 `delivery-*` 六组；每组保存命令、起止时间、退出码及原始 stdout/stderr。其他记录包括基线对照、官方构建、失败诊断及 red 阶段。

原始输出逐字节保留，可能含测试工具生成的行尾空格/末尾空行；代码与文档的 whitespace 检查不把原始 `.txt` 日志当作源码。元数据缺失的早期检查明确记为 `null`，不补造退出码。官方构建的原始输出显示 7 个门禁通过。

`candidate-host-tests` 和 `frozen-baseline-host-tests` 均为 82 通过、3 失败，未视为全绿；`host-prepare-diagnostic` 记录隔离环境的 `spawnSync /bin/ps EPERM`。没有签发完整维护控制器验收回执，也没有容器镜像验证。

`run-check.py.txt`、`isolation.sb.txt`、`capture-ui.mjs.txt` 和 `reference-capture.e2e.ts.txt` 保存当时的隔离及采集脚本；复现时需调整本机绝对任务路径，并自行准备相同固定源码与依赖。正常回归命令位于 package.json。
