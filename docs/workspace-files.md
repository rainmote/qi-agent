# 文件、附件与引用

Web 输入框现在提供「添加附件」「文件与变更」和「引用文件 / 会话」。文件面板延续现有界面，可在窄屏查看、搜索路径、预览与下载。它是只读文件查看器，不是代码编辑器或 Office 编辑器。

## 附件

每条消息最多 8 个附件，每个 1 字节至 8 MiB。上传使用单独的 12 MiB 请求限额，其余 HTTP JSON 请求仍限 1,000,000 字节。附件保存到受保护的独立目录，使用随机 ID 创建，不能覆盖工作区用户文件。新启动的 worker 收到同一 `QI_AGENT_ATTACHMENT_DIR`；有显式 Web stateDirectory 时使用其 attachments 子目录，默认使用环境指定位置或 qi 用户目录下的 attachments。

会话日志只持久化文件 ID、名称、MIME、大小和工作区标识。服务端在消息入队前与每次实际模型请求前检查工作区绑定和文件摘要；原始图片仅在最终请求边界转换，不写入会话日志。支持 PNG/JPEG/GIF/WebP 原图输入和不超过 256 KiB 的文本/JSON。PDF、Office 及其他二进制保留原件，模型会收到「未提取正文」说明，不能据此声称已读正文。实际图片理解仍取决于所选模型能力。

确定失败恢复文字与附件；未知提交保留原操作编号和附件 ID，通过「核对结果」查询，不会自动重复发送。刷新后确认失败也恢复可编辑内容。

## 预览和引用

文件操作只在已授权工作区内进行。绝对路径、上级路径、符号链接、被替换为链接的根目录，以及隐藏、敏感和构建目录被拒绝。读取使用有界文件描述符、NOFOLLOW 和读取后的身份复核。该机制不宣称防御同一用户恶意持续重命名目录的全部竞争条件。

- 文本与代码最多预览 256 KiB；Markdown 支持排版与源文，远程图片不会自动加载。
- 栅格图片和 PDF 最多 8 MiB；PDF 依赖浏览器预览能力，可下载后打开。
- HTML 在空权限 sandbox 内静态显示，附加 CSP 禁脚本、网络和表单，不获得宿主页面权限。
- Office 显示明确的不支持转换说明并提供原件下载。
- 文件搜索是有界路径搜索，单目录最多 500 项，遍历最多 10,000 项，返回最多 100 项；不是全文语义索引。

输入 `@file:` 或 `@session:` 可查询当前工作区引用。每条消息最多 4 个引用。选中的文件经同样路径校验后取得实际文本；选中的会话从已验证的目录项读取最多 1 MiB 历史尾部，并引用最近最多 20,000 字符的用户/助手文字。该读取不会启动或恢复代理，也不会取得会话控制权。附件和工具二进制不会被放入历史摘录。最终引用文本限 240 KiB JSON，为附件元信息保留空间；整个 typed 消息限 256 KiB JSON。

引用会在创建操作记录前解析并固定，因此使用原编号重试时不会悄悄换成后来修改的文件内容。输出包含来源标记；引用内容属于用户选取的数据，不是额外系统指令。

## 每轮变更

目前范围是 **Web Host 接受的 `turn.submit`**：开始前保存 before，使用后台接纳响应返回的 request ID 关联真实 `remote/run-result`，完成后保存 after 与新增/修改/删除清单。请求编号和会话共同生成快照身份，避免两个会话复用操作编号时串记录。`steer`、排队 follow-up、ACP、TUI 或独立外部写入不各自建立一份 Web 快照；同一时间窗口的外部修改可能被计入，界面会说明。

最多对比 200 个文本文件、总计 4 MiB，单文件 256 KiB；忽略 `.git`、隐藏/敏感文件、构建目录与 Git 忽略文件。中断、读取限额、无法完整遍历和启动恢复标记为部分记录。启动时最多恢复 32 份未完成快照，截止到恢复时，明确提示代理可能仍运行。diff 为有界文本 before/after 比较，不提供 Git worktree 管理或任意文件回滚。

## 独立验收回执

### 显式 coding-candidate 准入

宿主可用 `--candidate-config /absolute/host-config.json` 启用候选 API。未配置时不会自动创建候选。
配置必须由操作人预选干净的外部可信控制器提交、私有状态目录，以及每个原始 workspace_id 对应的冻结任务合同：

```json
{"schema_version":1,"controller_path":"/absolute/reviewed-controller","controller_sha":"EXACT_REVIEWED_SHA",
 "directory":"/absolute/private/coding-state","contracts":{"WORKSPACE_ID":"/absolute/frozen-task.json"}}
```

这是已有维护合同的交互入口，不是从浏览器上传策略、profile、验收器或镜像的入口。候选不能修改保存的可信
控制器；新增入口代码及配置需独立审查后使用。配置不是启用授权，当前实现不会自动安装或激活它。

认证后的 `POST /api/candidates/begin` 接收 `base_sha/workspace_id/command_id`，基线必须匹配宿主合同。
返回 `candidate_id/cwd/candidate_workspace_id/lease_owner/status`。独立 detached worktree 只包含该提交；
`original_dirty=true` 明确表示原目录未提交内容未包含，原目录保持原样。候选作为独立工作区注册，可在其中
创建普通 Web 会话。原 daemon 的 workspace-write lease 继续保证原生 root 写入互斥；Web 另绑定首个 writer
session，后续会话不能接管同一候选。直接从其他工具运行的写入仍受原权限/隔离边界约束，worktree 本身不是 OS 沙箱。

相同操作编号与合同返回同一候选；改变参数、合同或控制器时拒绝复用。两个控制器竞争同一原工作区时，只有
一个拥有候选。prepare 前先保存意图，响应丢失或中断不重复创建工作树：通过 `GET /api/candidates/ID/status`
查看，再显式 `POST /api/candidates/ID/reconcile` 核对原控制器材料。reconcile 仅在确认本机原操作 PID 已死亡时
恢复外层文件锁，不按超时抢占；原维护控制器的未知状态仍需按其恢复规则处理。

`POST /api/candidates/ID/close` 只在 daemon 已确认没有 resident writer 时取消任务并释放候选所有权；失联、
未知 residency 或仍存活 writer 均保留所有权。先通过现有 agent.stop 停止写入并对账。关闭不删除候选或原始
文件；旧候选不能因新候选出现而重新获得 Web 写权限。验收另走可信 verifier，准入成功不表示验收通过。

普通 Web 编码可以使用维护合同已准备的独立候选工作区。daemon 的 workspace-write lease 保持一个 root
写入者；停止该 worker 后，由候选外、固定提交的可信维护控制器执行 `verify`。它已有基线、有效 red、
只读源码副本、独立验收器、容器限额和完整源码快照绑定。Web 不执行测试命令，也不以 `remote/run-result`
或会话文字作为验收。任意普通目录仍须先准备合同候选；这里没有自动创建工作区或自动触发验收。

新回执导出器只读取已存在的 `review_ready`。提供原可信控制器路径与精确 SHA；导出器校验其 checkout
干净、任务材料/日志完整、所有必需检查通过，以及当前候选完整文件集合、原始字节和可执行位仍匹配已验收
Git tree。中断、skip、取消、超时或未知执行证据不能导出 PASS。回执按工作区绝对路径与本轮 `turnId`
绑定；重复身份拒绝覆盖，未知写入结果先核对已有文件。

```sh
node maintenance/export-web-receipt.mjs --state /absolute/private/state --id TASK_ID \
  --controller /absolute/reviewed-controller --controller-sha EXACT_REVIEWED_SHA \
  --turn-id TURN_ID_FROM_CHANGES --output-directory /absolute/private/web-verification
npm run web:start -- --verification-directory /absolute/private/web-verification \
  --verification-controller-sha EXACT_REVIEWED_SHA
```

输出目录必须位于候选和可信控制器外；Web 只从宿主启动参数选择的私有目录读取回执，RPC 不能提交回执
或更换可信控制器。每次读取本轮变更，Web 重新核对完整 tracked / nonignored 源码（含隐藏与二进制文件）和
本轮 after 内容。文件增删、内容/权限变化、控制器不匹配、损坏/不完整材料显示「验收结果未确认」；缺失
回执保持「尚未关联」。部分变更快照不显示通过。通过后提示审查已验证快照，接受、合入和发布仍是独立动作。

完整文件扫描限 4096 个文件、单文件 4 MiB、合计 64 MiB，超过限制不产生 PASS。它拒绝源码/回执符号链接，
并复核读取身份与整次文件集合；不声称防御同一宿主用户持续恶意改写所有状态或 Git 元数据。回执目录权限和
候选执行沙箱是信任边界，单独的 40 位 SHA 字符串不是签名或身份认证。此候选导出器及接入需独立审查后使用，
不会修改或激活保存的可信控制器规则。

## 验证

### coding-candidate 的独立 verifier API

先停止候选的 resident writer，并读取候选 `status` 中的完整 `source_fingerprint`。
`POST /api/candidates/ID/verify {source_fingerprint, command_id}` 先保存验收意图，再调用原宿主选定的
固定外部控制器；HTTP 202 返回已接纳状态。profile、验收器、镜像和 argv 来自冻结合同，浏览器不能替换。
每个候选最多采用原策略允许的验收次数，原墙钟不重置；已确认失败后的新请求才可沿用原控制器的 retry。
未知执行不会自动重放；运行中或未对账的验收阻止新的候选写入和关闭。

`GET /api/candidates/ID/verification` 重新核对原控制器材料、原始检查回执与完整源码文件集合/字节/可执行位，
返回 NOT_RUN、VERIFYING、PASS、FAIL、STALE、UNKNOWN。只有完整必需项、精确 base/candidate/source、
profile/controller/verifier 哈希及固定 image 全部匹配才为 PASS；缺失、跳过、取消、超时、陈旧或损坏证据
不能产生通过。源码再变化立即为 STALE，运行 completed 也不能提交或替代验收回执。

每项检查包含 argv、退出码、起止时间和原始输出哈希；`GET /api/candidates/ID/checks/CHECK_ID` 提供相同
绑定的具体检查元数据与有界测试计数摘要，不返回原始模型日志、配置正文或凭据。Web 最后回合关联只采用
宿主保存的 writer session/turn ID；不同回合不能自动借用旧状态。精确源码已通过后再修改，需建立新的合同候选。
宿主发现候选 writer 时只查询 daemon 元数据，不 hydrate 或创建模型 worker；独立 Web Host 关闭时回收该
发现连接启动的自有 daemon。这里的工作树隔离、宿主状态权限和实际执行沙箱仍是不同边界。

`workspace-files.test.ts`、`workspace-http.test.ts`、`turn-files.test.ts` 覆盖路径、跨工作区引用、私有存储、上传限额、HTML 响应头、真实 HTTP、回合完成早于接纳、跨会话同编号和恢复语义。`daemon-operations.test.ts` 使用隔离的真实 daemon 与离线模型 fixture 验证真实完成编号及订阅释放；不调用真实模型。`attachments_test.clj` 验证 durable 记录仍为 ID、模型边界才解析正文。

生产浏览器 fixture 覆盖 HTML 隔离、变更展开、附件 ID payload、实际引用内容、确定失败恢复、未知后失败跨刷新恢复，以及 1440/768/414/375/320 像素宽度无页面溢出。模拟浏览器数据不能证明真实模型或外部文档转换可用。
