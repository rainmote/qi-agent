# qì agent 命名与迁移约定

产品显示名统一为 **qì agent**，中文品牌名为 **器**；文件系统、包名、仓库名和命令使用
ASCII `qi-agent`，Clojure 命名空间使用 `qi.*`。

| 范围 | 新标识 | 兼容行为 |
|---|---|---|
| CLI | `qi-agent` | `dao` 保留为同实现别名 |
| Babashka task | `bb qi-agent` | `bb agent` 继续可用 |
| 用户数据 | `$QI_AGENT_HOME`，默认 `~/.qi-agent` | 旧 trust、resource 与 preset 目录在新目录不存在时回退读取 |
| 项目状态 | `.qi-agent/` | session catalog 同时读取 `.bb-agent/sessions/` |
| 环境变量 | `QI_AGENT_*` | 对应的 `DAO_*`/`BB_AGENT_*` 作为次级回退 |
| Clojure namespace | `qi.*` | profile 中旧 `agent.plugins.*` 自动映射到内置 `qi.plugins.*` |
| npm package | `@rainmote/qi-agent-web` | 无发布期兼容包；当前包仍为 private |
| Rust package/binary | `qi-agent-tui` / `qi-agent` | 同时构建 `dao` binary |

`agent.edn` 仍是 profile 文件名：这里的 “agent” 表达文件职责，不是旧品牌。preset 内的
`agent.edn` 同理保持不变，避免把格式迁移与品牌迁移耦合。

GitHub 仓库改名为 `rainmote/qi-agent` 后，再更新本地远端：

```bash
git remote set-url origin git@github.com:rainmote/qi-agent.git
```

GitHub 通常会为旧地址保留跳转，但 CI、徽章、部署密钥和外部克隆地址仍应逐项更新。
