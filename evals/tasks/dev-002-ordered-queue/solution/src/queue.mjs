export function createQueue(handler) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  const results = new Map();
  let tail = Promise.resolve();
  return {
    enqueue(id, payload) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('id must be nonempty');
      if (results.has(id)) return results.get(id);
      const result = tail.then(() => handler(payload, id));
      results.set(id, result);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    drain() { return tail; },
  };
}
