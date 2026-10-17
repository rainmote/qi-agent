# 修复基于快照的原子编辑

这是合成开发题，只用于评测流程开发，不是真实项目或留出 benchmark。它在内存文件映射上模拟编辑，不读写磁盘。只能修改 `src/hash-edit.mjs`；保留 `hashText(text)`、`EditConflictError`、`applyEdits(files, edits)` 导出。运行环境为无第三方依赖的 Node.js。

files 是一个非 null、非数组对象，其每个自身可枚举属性都是文件路径到字符串内容的映射。edits 是数组；每项为：

```js
{ path: 'a.txt', expectedHash: hashText(originalContent), oldText: 'old', newText: 'new' }
```

完整约定如下：

- hashText 返回 UTF-8 字符串内容的 SHA-256 小写十六进制值。
- 每项 edit 必须是非 null、非数组对象；path 是非空字符串，expectedHash 是字符串，oldText 是非空字符串，newText 是字符串。files 的值不是字符串，或输入结构无效时抛 TypeError；空 edits 合法。
- path 必须是 files 的自身属性；继承属性不算文件，否则抛 EditConflictError，code 为 `UNKNOWN_FILE`。
- 每项 expectedHash 必须等于该文件**整个批次开始前的原始内容**哈希，否则抛 EditConflictError，code 为 `STALE_HASH`。
- 每项 oldText 必须在原始文件内容中恰好出现一次（逐字符、字面匹配；重叠出现也要计数）。找不到或找到多次均抛 EditConflictError，code 为 `TEXT_NOT_UNIQUE`。
- 同一文件不同 edit 的原始匹配区间不能重叠，否则抛 EditConflictError，code 为 `OVERLAP`；紧邻区间合法。同一文件可以多次编辑，所有匹配位置都以原始内容为准，不能受到前一项替换内容或长度变化的影响。
- 任意一项出错就拒绝整个批次。无论成功失败，都不得修改 files、edits 或其子对象。成功返回新的浅层文件映射，保留全部未修改文件；即使 edits 为空也返回新对象。
- EditConflictError 必须是 Error 子类，name 为 `EditConflictError`，code 取上述值。除 TypeError 之外，验收单独构造每种冲突，不要求多种冲突并存时的优先级。

验收覆盖旧快照、跨文件原子性、同文件多处替换、替换文本再次出现目标词、相邻/重叠区间、Unicode、继承属性和空批次。
