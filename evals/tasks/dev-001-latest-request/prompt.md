# 修复异步请求状态竞争

这是用于调通评测流程的合成开发题，不是真实项目缺陷或留出 benchmark。运行环境为 Node.js，不需要安装依赖。只能修改 `src/request-store.mjs`，保持 `createRequestStore()` 导出及其方法签名。

该工厂返回 `getState()`、`request(loader)` 和 `reset(value = null)`。状态包含 `status`、`value`、`error` 三个字段。初始状态是 `{ status: 'idle', value: null, error: null }`。

需要满足以下完整约定：

- `request(loader)` 调用后立即进入 `loading`，保留之前的 value，清除 error；loader 不接收参数，可以返回普通值、Promise 或同步抛出异常。
- 后一次 request 从调用开始就使之前所有 request 失去修改状态的资格。只有最新 request 能将状态改为 `success` 或 `error`；旧请求的成功或失败都不能覆盖新状态，即使新请求仍在等待。
- 成功状态使用该请求的返回值，error 为 null。失败状态保留开始请求时的已有 value，error 是原始异常对象。
- 每次 request 返回的 Promise 仍应分别 resolve 为自己的值或 reject 为自己的原始异常，旧请求失去修改资格并不改变它自己的结果。
- `reset(value = null)` 立即设置 idle 状态和指定 value，清除 error，同时使所有先前请求失去修改状态的资格。之后仍能正常发起请求。
- getState 返回独立的浅层状态快照：调用者修改返回对象的字段不能修改内部状态；已取得的快照不能被后续操作原地修改。无需深拷贝 value 或 error。

验收覆盖乱序成功、过时失败、新请求等待期间的旧完成、reset、同步异常及状态快照。不要引入真实网络或定时等待。
