# 插件包与 Web 扩展

`qi.plugins.plugin-manager` 分发可审阅、固定版本的数据包，复用已有的受限 EDN Blueprint 工具解释器。它不会加载任意 Clojure namespace、JavaScript、React 组件或安装脚本。此限制是宿主能力边界，不是包格式的遗漏。

## 启用与入口

主配置在项目 trust、approval 和 remote registry 就绪后加载：

```clojure
{:ns qi.plugins.plugin-manager
 :config {;; 可省略，默认 $QI_AGENT_HOME/plugin-packages
          :user-dir "/absolute/user-state/plugin-packages"
          ;; 仅宿主配置可提供；里面的 .edn 包为系统只读包
          :system-dirs []}}
```

模型工具 `plugin_manage` 提供 `list`、`inspect`、`install`、`enable`、`disable`、`remove`、`rollback`。读操作不要求信任。变更入口自身检查 workspace trust 和 `:approval/request`，因此直接调用服务也不能跳过审批；计划模式未批准执行时拒绝变更，审批期间计划状态改变也会再检查。审批策略的 allow/ask/deny 决定变更是否获准。

服务 `:plugins/manager` 提供 `:list!`、`:inspect!`、`:execute!`、`:slots!`。远端 `plugins.list`、`plugins.inspect`、`plugins.ui-slots` 只读；`plugins.manage` 是 controller mutation，必须走宿主操作日志，并声明 `:blocking true`，让 `interaction.resolve` 能继续被读取。

Web `PluginPanel` 通过传入的 `rpc` 函数调用这些方法，观察者模式通过 `readOnly` 禁用变更入口。面板支持安装、审阅摘要/工具/历史版本、启停、回滚和移除。远端控制权仍由服务端校验，按钮禁用不构成授权。

## 包格式

一个 UTF-8 EDN 文件就是完整的包，不解压归档、不遍历目录；最多 512 KiB：

```clojure
{:format 1
 :id "sample-metrics"
 :version "1.0.0"
 :name "示例指标"
 :description "展示一个静态指标面板"
 :requires []
 :ui [{:id "summary"
       :slot "panel"
       :type "metric"
       :title "本周进度"
       :data {:label "完成事项" :value 12 :unit "项"}}]}
```

可选 `:blueprint` 是一个完整 Blueprint EDN 字符串，遵守 `runtime_blueprint.clj` 现有 AST、值大小、状态和工具 schema 限制。`:requires` 只接受 `{:id "other-package" :version "1.2.3"}` 精确依赖；不会自动安装依赖。启用前要求当前会话的依赖已启用且版本相同。被其他已启用包依赖的版本无法停用、删除或升级，须先停用依赖方。

包 ID 只接受 2–64 位小写字母、数字、连字符；版本为完整 semver。相同 ID+version 的内容不可变。UI 仅允许 `panel` 和 `tool-result`，renderer 仅允许 `text`、`markdown`、`metric`、`table`，每个类型有固定数据 schema。`tool-result` 必须指向本包的 Blueprint 工具；宿主将对应工具的结果数据传入 renderer，格式不符时显示诊断。Markdown 不执行原始 HTML、不自动加载外部图片，链接只接受 HTTP(S)，新页面使用 `noopener noreferrer`。

## 固定来源与安装

本地：

```json
{"action":"install","source":"/absolute/path/plugin.edn"}
```

本地文件会先读为不可变快照并计算 SHA-256，审批显示实际 ID、摘要和路径。审批后使用这份内容，文件随后变化不会替换已审阅内容。也可提供 `sha256` 以校验预期摘要。

HTTPS：

```json
{"action":"install","source":"https://example.org/plugin.edn","sha256":"<64位小写摘要>"}
```

Git：

```json
{"action":"install","source":"git+https://example.org/project.git","commit":"<完整提交哈希>","path":"packages/plugin.edn","sha256":"<64位小写摘要>"}
```

远端来源必须提供 SHA-256。Git 还要求完整 commit 和安全的相对 `.edn` 路径；临时仓库仅 fetch/show 指定对象，不 checkout、不执行项目代码。禁用 Git hooks、凭据助手、全局/系统配置和交互认证；命令使用固定 `/usr/bin/git` 及超时。下载只接受无凭据的标准 HTTPS 公网地址，不跟随重定向。复用 Web 工具的规范主机名及全部 DNS 地址校验，HTTP 下载使用固定 `/usr/bin/curl`，Git 使用 `http.curloptResolve` 固定已校验地址，禁用环境代理，避免二次解析指向内网。私有仓库、SSH、自定义端口和重定向下载不在该入口支持范围内。

包内和包路径上的符号链接拒绝访问。系统包 ID 不可被用户包覆盖，工具参数不能改变 user-dir/system-dirs。来源不受信任；SHA-256 证明收到的是指定内容，不等同于作者背书。

## 生命周期与恢复

- 新包默认停用。已启用包升级时当前会话立即切换，并保存配置供未来会话加载；其他正在运行的会话需重启。摘要同时报告 `active`、`enabled`、`restart-required` 和影响范围。
- 用户状态独立于应用 checkout。对象按 SHA-256 保存，registry 原子替换；写入受文件锁保护。审批等待时若其他会话更新了该包，原操作拒绝继续，要求重新检查。
- 升级注册工具失败或 registry 写入失败时，恢复当前会话上一版本与指针。显式 `rollback` 交换 current/previous，可撤销成功升级。
- 重启时只在工作区已信任时加载已启用包，并按依赖顺序加载。缺失、未启用或循环依赖会给出诊断，不会自动下载和执行补救步骤。
- 系统包由宿主配置声明，管理入口只读。移除用户包会清除安装记录和当前运行效果；内容寻址对象保留以便恢复，不声称擦除文件。历史对象不会自动重新启用。
- 最多安装 64 个用户包、每包保留 16 个版本；单包最多 16 个精确依赖和 12 个 UI slots。原始执行源码、工具安装脚本和任意宿主访问不受支持。

## 验证

`test/qi/plugin_manager_test.clj` 使用隔离临时目录覆盖审批与 trust、安装/启停/重启/回滚、冲突升级后的运行恢复、精确依赖、系统只读、schema/路径/EDN 攻击、完整性校验、符号链接、审批期间文件替换及并发更新、计划状态二次校验、取消/销毁后的迟到审批。假远端测试使用真实本地子进程替代传输，检查 UTF-8 原始内容摘要、固定 DNS 参数、禁用 ambient 配置和重定向拒绝；本地、保留、八进制地址在传输前拒绝。`PluginSlots.test.tsx` 覆盖 HTML/图片/链接隔离、工具作用域、运行数据校验和观察者禁控。

这些离线测试未连接真实外部包仓库、未安装第三方生产插件，不能据此声称公共仓库兼容性或多进程压力验证已经完成。
