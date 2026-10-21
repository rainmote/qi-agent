# 桌面依赖的项目级国内镜像

`apps/desktop/dependency-mirrors.json` 记录分类型候选，下载入口为
`scripts/desktop/runtime-fetch.py`。它只处理锁定的 37 项工作区归档；不会安装包、
执行脚本、启动应用或替换系统 Python，也不会配置全局 npm/pip、DNS、代理、VPN、
TLS、Cargo 或系统安全权限。`desktop:prepare` 和构建仍只读离线缓存。

## 来源与范围

| 类型 | 数量、版本 | 官方来源 | 国内候选 |
| --- | --- | --- | --- |
| 便携 CPython | 1，3.12.14+20260901，macOS arm64 | Astral python-build-standalone GitHub release | 未验证到同一归档，保留官方 |
| Python wheel | 13，numpy 2.3.5、pandas 3.0.1、Pillow 12.3.0、lxml 6.1.3、python-dateutil 2.9.0.post0、six 1.17.0、tzdata 2025.2、python-docx 1.2.0、python-pptx 1.0.2、openpyxl 3.1.5、XlsxWriter 3.2.9、typing_extensions 4.16.0、et_xmlfile 2.0.0 | files.pythonhosted.org | TUNA PyPI simple |
| npm 归档 | 23，pnpm 11.28.5、Office kit 0.1.5 的 20 包闭包、xterm 6.0.0 / fit 0.11.0 | registry.npmjs.org | npmmirror registry |

所有精确文件名、版本、官方 URL、大小上限及 **14 个 SHA256 / 23 个 SHA512/SRI**
均以 [原锁](../apps/desktop/workspace-runtime-sources.json) 为准；镜像配置不改锁。
完整 Office 闭包亦在该文件，不用上游 latest、动态解析器或镜像新哈希覆盖版本。
Python.org 的 macOS 安装器不是当前便携归档的等价替代。

来源依据：[npmmirror 项目说明](https://npmmirror.com/) 声明只读 npmjs 镜像及
`https://registry.npmmirror.com`；[清华 TUNA PyPI 帮助](https://mirrors.tuna.tsinghua.edu.cn/help/pypi/)
给出 HTTPS simple 索引。未使用未知 GitHub 代理、第三方镜像列表或 HTTP 回退。

2026-10-21 最初受限的 Mac 执行器对这两个镜像的公开元数据请求均 `URLError / gaierror errno8`，
0 字节、未到 HTTP。官方目标请求此前也出现名称解析错误；历史下载失败的实际 DNS
主机未记录，可能是源或既有代理。底层原因未知，不能据此声称镜像能修复网络或是
权限拒绝。用户随后授权通过正式本机执行入口开发，实际 DNS、HTTPS 和下载已恢复，
不能只根据继承的 sandbox 环境标志判断有效网络策略。此次实证记录在任务收据中，
不修改系统 DNS、代理、TLS 或产品隔离。

当前仍 **默认 official，自动启用镜像数 0**。`cn` 是显式候选校验配置；已从 TUNA
取得 pandas、Pillow、lxml 和九个纯 Python wheel，并匹配原 SHA256。npmmirror 首项重定向超出
固定主机策略而停止，未扩大白名单或改用未知 CDN；23 项 npm 归档从显式官方来源
取得并匹配原 SRI。便携 Python 和 numpy 也已从官方来源校验。37/37 项缓存均已逐项
重算原 pin，合计 139,774,357 字节；下载完成不代表已形成可运行安装包。

## 使用

先离线查看完整计划。`plan` 不联网、不创建缓存或收据，也不改变来源配置：

```sh
npm run desktop:fetch-workspace -- plan --profile cn
```

网络恢复且允许下载时，显式校验候选。可先仅选一个精确锁名；不读 npm/pip/netrc
凭据文件，不带原站 Authorization 或 Cookie。代理与 TLS 使用原 urllib 默认设置，
不会通过关闭代理或证书校验来恢复连接。

```sh
npm run desktop:fetch-workspace -- fetch --profile cn \
  --only pnpm-11.28.5 \
  --cache "$PWD/.cache/desktop/workspace" \
  --receipt "$PWD/.cache/desktop/pnpm-cn-01.json"
```

省略 `--only` 会选择全部 37 项；`cn` 下便携 Python 仍用官方来源。省略 `--profile`
全部用官方来源，不接受环境变量或任意自定义 registry。选择部分归档成功不代表完整
闭包可构建。现有 `QI_DESKTOP_CACHE` 是**构建**根目录；下载的 `--cache` 要指向其
`workspace` 子目录。下载器默认 `.cache/desktop/workspace`，不隐式读取此环境变量。

npm 候选保持原包路径和版本。wheel 必须从 TUNA 索引找到**唯一的锁定文件名**
（包括 Python ABI 和架构），且索引 SHA256 与原 pin 相同；不机械替换 PyPI 文件
主机或改用另一个 ABI。元数据、归档和每跳重定向均要求 HTTPS、固定主机白名单，
未知 CDN/外站拒绝，不跟随到官方作为隐藏回退。每次重定向向目标只携带公开请求头。
元数据上限为 2 MB；实际 TUNA Pillow、lxml 索引响应头分别约 1.17 MB、1.64 MB，
原 1 MB 上限不能容纳它们。离线回归覆盖 1.7 MB 精确锁项可读及超过 2 MB 拒绝；
此调整不改变归档上限、原 pin 或来源规则。

每个目标本轮至多一次，网络失败后跳过同一计划主机；HTTP 拒绝、策略/校验、文件
系统错误或未知结果停止后续下载，不自动换源/重试。单项使用原大小上限，总传输
1 GB；socket timeout 20 秒，600 秒为两次阻塞调用之间检查的软预算，不能保证 DNS
在此时限内退出。收据保留阶段、错误类别、HTTP 状态或 errno，不记录带签名 URL、
代理秘密或任意服务器错误正文。

只在完整字节匹配**原可信 pin**后排他发布到 `<cache>/<name>`，不覆盖已有文件。
已有缓存也须重新校验；链接、损坏文件、`.partial` 或旧收据均需先核对，不能删除后
盲目重试。下载没有解压、安装或代码执行。结果 `VERIFIED` 只代表本次所选归档验证
通过；非零退出、`INCOMPLETE_STOPPED`、`RECEIPT_OR_OUTCOME_UNKNOWN` 都不能当完成。
中断或收据写入失败时保留 RUNNING 意图与 partial/已发布文件，先按原 pin 核对实际
文件和最后回执，再决定后续动作。不要复用收据路径或自动清除未知结果。

## 验证边界

`npm run test:desktop-fetch` 使用纯函数、临时目录与内存 HTTP mock，覆盖精确 wheel、
重定向/凭据边界、原 pin、排他发布和失败收据；不打开端口或连接网络。镜像真实
下载、完整运行时/许可证与 Mach-O 闭包、安装包及原生 E2E 仍须另行验证。当前已有
AppKit 启动失败、LCU 隔离失败、PTY 后代清理提供者缺口及服务配置选择不因换源消失。
