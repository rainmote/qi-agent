# 修复重试分类和预算

这是合成开发题，只用于评测流程开发，不是真实项目或留出 benchmark。环境为 Node.js，不依赖第三方包。只能修改 `src/retry.mjs`，保留 `isRetryable(error)` 和 `runWithRetry(operation, options = {})` 两个导出。

错误分类规则，按以下优先级处理：

1. null、原始值、函数都不能重试；仅非 null 的对象参与以下判断。
2. `name === 'AbortError'`，或 `retryable === false`，绝不重试。
3. `retryable === true` 时可以重试。
4. `status` 是整数且为 429 或在 500 到 599 之间，或者 `code` 为 `ETIMEDOUT` / `ECONNRESET` 时可以重试。
5. 其他情况均不重试。字符串状态码不转换为数字。

runWithRetry 的约定：

- 调用 operation(attempt)，attempt 从 1 开始，最多尝试 maxAttempts 次；支持同步返回、Promise、同步抛错和 Promise reject。
- options 默认是 `{ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000, sleep }`。默认 sleep 用毫秒等待；调用方可注入异步 sleep，无需真实等待。
- maxAttempts 必须是正的安全整数；两个 delay 必须是有限、非负数字；operation 和 sleep 必须是函数。无效选项必须在调用 operation 之前以 TypeError 拒绝。显式 undefined 使用默认值。
- 成功立即返回原始结果。不可重试错误立即抛出原始错误。可重试错误耗尽次数后也抛出最后一次的原始错误，不包装、不追加尝试。
- 仅在需要进行下一次尝试时调用并等待 sleep。第 n 次失败后的 delay 为 `min(maxDelayMs, baseDelayMs * 2 ** (n - 1))`；baseDelayMs 为 0 时始终为 0。
- 最后一次失败、不可重试失败和成功后都不能 sleep。sleep 自身抛错或拒绝时，立即抛出该原始错误且不再调用 operation。

验收使用注入 sleep 记录退避值，不依赖真实网络或长时间等待。
