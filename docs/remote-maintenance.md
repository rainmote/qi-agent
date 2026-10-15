# 在飞牛等 ARM64 宿主验证维护闭环

采用 CI 构建与验收、远程宿主加载与复验。宿主只需 Docker、Git 和 POSIX shell；Node、Babashka、Rust 和 Chromium 均来自固定镜像。当前流程只运行离线演练，不启动定时服务或真实模型请求。

## 镜像交付

`Maintenance container` CI 在完整容器、费用代理与原生 worker 验证通过后，导出 `qi-toolchain-SOURCE-ATTEMPT` artifact，保留一天。它包含 `qi-toolchain.tar.gz`、`manifest.json` 和四份原始回执。导出器拒绝源码、镜像、架构不一致，或失败、缺失的验收。离线通过不构成真实模型资格。

1. 从指定成功 CI 下载 artifact，核对 GitHub 返回的整个 ZIP SHA-256。
2. 解压至新的独立目录；只接受上述固定文件，不覆盖旧证据。
3. 核对 manifest 的 `source_sha`、`image`、`platform`，以及压缩镜像的 `archive.sha256` 和 `archive.bytes`。
4. `docker image load --input /absolute/bundle/qi-toolchain.tar.gz`，随后 `docker image inspect IMAGE_ID` 确认相同不可变 ID 和 `linux/arm64`。
5. 从同一提交准备完整 Git 仓库，包含验收所需历史基线。源 checkout 必须干净。

导出使用 [Docker save](https://docs.docker.com/reference/cli/docker/image/save/)，不会发布到镜像仓库。artifact 过期后可重跑 CI；新构建生成自己的镜像和回执，不能借用旧镜像的通过结论。

## 飞牛目录与可信控制器

建议在数据盘创建专用目录，例如 `/vol2/@appshare/qi-agent/RUN_ID/`，下面放置 `repo/`、`bundle/`、`evidence/`。确认该路径尚不存在后再创建，只将这个新目录交给专用非 root UID/GID。不要改动飞牛卷根目录权限、其他项目目录、已有容器和数据卷。

`maintenance/host-controller.sh` 在镜像内运行可信 Node 控制器，并将专用目录以完全相同的绝对路径挂载。控制器通过宿主 Docker 创建同级验收容器，因此路径不能映射成另一个名字。宿主不必全局安装 Node。

此可信控制器持有 Docker socket，具有启动宿主容器的能力，必须运行已审查的精确源码。候选和验收容器不挂载 Docker socket；它们断网、非 root、根目录只读，只能写自己的工作区。脚本不接受任意程序，仅接受四种离线 smoke 入口。

每次使用新的 `evidence/` 目录，依次执行，任一失败停止并保留输出：

```sh
# ROOT 是已经准备好的专用目录；SOURCE、IMAGE 来自已核对的 manifest。
sh "$ROOT/repo/maintenance/host-controller.sh" "$ROOT" "$SOURCE" "$IMAGE" broker-smoke "$ROOT/evidence/broker"
sh "$ROOT/repo/maintenance/host-controller.sh" "$ROOT" "$SOURCE" "$IMAGE" worker-smoke "$ROOT/evidence/worker"
sh "$ROOT/repo/maintenance/host-controller.sh" "$ROOT" "$SOURCE" "$IMAGE" container-smoke
sh "$ROOT/repo/maintenance/host-controller.sh" "$ROOT" "$SOURCE" "$IMAGE" qi-smoke c40b3eb181f2156e5fbf796835847b692b47da3f "$ROOT/evidence/qi"
```

可信控制器上限为 0.5 核、384 MiB；同一时刻只有一个测试容器，默认上限为 2 核、2 GiB。`--memory-swap` 等于 `--memory`，禁止测试额外占用宿主 swap，依据 [Docker 资源约束](https://docs.docker.com/engine/containers/resource_constraints/)。完整 smoke 显式保存资源配置；其他 smoke 使用同样的默认 2 核、2 GiB 上限。

完整检查的 `/work` 使用容量上限 6 GiB 的 tmpfs；实际占用计入 2 GiB 内存限额，容量不是内存预留。低内存宿主可能因缓存复制或构建峰值被 OOM 终止，此时必须记录失败；不能扩大到挤占现有服务的资源，也不能以删减检查取得 PASS。部署前后保存可用内存、swap、磁盘和已有容器状态，区分原有故障与本轮影响。

## 无人值守启用

迁移镜像和离线复验通过后，仍需在实际宿主准备独立 provider key、匹配当前材料的真实 dev 与 heldout 试跑，以及明确批准的任务。参见 [无人值守配置与资格](unattended-maintenance.md)。每天 02:00 的配置与 `enabled=false` 可以先保存；不要将离线 oracle 或 fixture 计为真实试跑，不在复验脚本中附带自动启用服务。
