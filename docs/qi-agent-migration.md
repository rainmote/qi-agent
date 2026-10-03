# qì agent 命名与迁移约定

产品显示名统一为 **qì agent**，中文品牌名为 **器**；文件系统、包名、仓库名和命令使用
ASCII `qi-agent`，Clojure 命名空间使用 `qi.*`。

| 范围 | 新标识 | 兼容行为 |
|---|---|---|
| 页面 / 中文品牌 | `qì agent` / `器` | 工程标识中不使用 Unicode |
| GitHub 仓库 | `rainmote/qi-agent` | GitHub 为原 `rainmote/dao` 地址提供跳转 |
| CLI | `qi-agent` | `dao` 保留为同实现别名 |
| Babashka task | `bb qi-agent` | `bb agent` 继续可用 |
| 用户数据 | `$QI_AGENT_HOME`，默认 `~/.qi-agent` | 旧 trust、resource 与 preset 目录在新目录不存在时回退读取 |
| 安装代码 | `$QI_AGENT_INSTALL_DIR`，默认 `~/.qi-agent/app` | 新安装为 Git checkout；旧复制式安装由下一次 `bb install` 迁移 |
| 用户 Profile | `$QI_AGENT_HOME/agent.edn` | 首次迁移旧 `app/agent.edn`，以后 Git 更新不覆盖 |
| 项目状态 | `.qi-agent/` | session catalog 同时读取 `.bb-agent/sessions/` |
| 环境变量 | `QI_AGENT_*` | 对应的 `DAO_*`/`BB_AGENT_*` 作为次级回退 |
| Clojure namespace | `qi.*` | profile 中旧 `agent.plugins.*` 自动映射到内置 `qi.plugins.*` |
| npm package | `@rainmote/qi-agent-web` | 无发布期兼容包；当前包仍为 private |
| Rust package/binary | `qi-agent-tui` / `qi-agent` | 同时构建 `dao` binary |

`agent.edn` 仍是 profile 文件名：这里的 “agent” 表达文件职责，不是旧品牌。preset 内的
`agent.edn` 同理保持不变，避免把格式迁移与品牌迁移耦合。

程序升级使用 `qi-agent upgrade`；已有的 `qi-agent update` 继续表示 supervisor 对 worker 与
lease 的修复。升级前可用 `qi-agent upgrade --check` 只检查远端分支。受管理 checkout 有本地
改动时升级会 fail closed，用户需要先自行提交、转移或还原这些源码改动。

GitHub 仓库与本地 `origin` 现已使用 `rainmote/qi-agent`。已有 clone 若仍指向旧地址，可执行：

```bash
git remote set-url origin git@github.com:rainmote/qi-agent.git
```

GitHub 通常会为旧地址保留跳转，但 CI、徽章、部署密钥和外部克隆地址仍应逐项更新。
