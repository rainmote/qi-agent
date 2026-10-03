# 修复内存工作队列

这是合成开发题，只用于评测流程开发，不代表真实项目或留出 benchmark。环境为无外部依赖的 Node.js。只能修改 `src/queue.mjs`，保留 `createQueue(handler)` 导出。

工厂返回 `enqueue(id, payload)` 和 `drain()`，需要满足：

- handler 必须是函数，否则工厂同步抛出 TypeError。id 必须是非空字符串，否则 enqueue 同步抛出 TypeError，不接收任务；空格字符串是有效 id。
- 不同 id 按 enqueue 的调用顺序执行，任意时刻最多一个 handler 尚未完成。调用 handler 的参数顺序为 `(payload, id)`；支持返回普通值、Promise、同步抛错。
- enqueue 返回 Promise，将该任务的原始结果或原始异常交给调用者。
- 在同一队列实例整个生命周期内，重复 id 只执行第一次 payload 对应的任务。无论该任务等待中、执行中、已成功或已失败，重复 enqueue 都必须返回**完全同一个 Promise 对象**。不同队列实例的 id 互不影响。这仅是在内存队列生命周期内去重，不要求进程崩溃后的分布式 exactly-once。
- 某个任务失败不能阻止后续不同 id 的任务执行。
- drain 返回一个 Promise：等到调用 drain 时已经接收的所有任务完成后 resolve 为 undefined，即使其中有任务失败也不能 reject。之后才接收的新任务不属于这次 drain 的等待范围。空队列也能 drain。

验收包含并发上限、FIFO、重复 id、失败恢复和 drain 的时间边界。无需真实网络、持久化或定时轮询。
