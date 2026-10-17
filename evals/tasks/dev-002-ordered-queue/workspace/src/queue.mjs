export function createQueue(handler) {
  const pending = [];
  return {
    enqueue(id, payload) {
      const result = Promise.resolve().then(() => handler(payload, id));
      pending.push(result);
      return result;
    },
    async drain() { await Promise.all(pending); },
  };
}
