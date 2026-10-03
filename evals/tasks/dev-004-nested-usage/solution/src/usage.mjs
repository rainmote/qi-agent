const keys = ['input_tokens', 'output_tokens', 'cached_input_tokens'];
const zero = () => ({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function add(target, source) {
  for (const key of keys) {
    const sum = target[key] + source[key];
    if (!Number.isSafeInteger(sum)) throw new RangeError('usage exceeds safe integer range');
    target[key] = sum;
  }
}

export function aggregateUsage(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const runs = new Map();
  for (const event of events) {
    if (!object(event) || !nonempty(event.event_id) || !nonempty(event.run_id) ||
        !(event.parent_run_id === null || nonempty(event.parent_run_id)) || !object(event.usage)) {
      throw new TypeError('invalid event');
    }
    const usage = zero();
    for (const key of keys) {
      usage[key] = event.usage[key] === undefined ? 0 : event.usage[key];
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new TypeError('invalid usage');
    }
    if (usage.cached_input_tokens > usage.input_tokens) throw new TypeError('invalid cached usage');
    let run = runs.get(event.run_id);
    if (!run) {
      run = { run_id: event.run_id, parent_run_id: event.parent_run_id, own: zero(), events: new Map() };
      runs.set(event.run_id, run);
    }
    if (run.parent_run_id !== event.parent_run_id) throw new TypeError('inconsistent parent');
    const previous = run.events.get(event.event_id);
    if (previous) {
      if (keys.some((key) => previous[key] !== usage[key])) throw new TypeError('conflicting duplicate');
      continue;
    }
    run.events.set(event.event_id, usage);
    add(run.own, usage);
  }
  const children = new Map([...runs.keys()].map((id) => [id, []]));
  for (const run of runs.values()) {
    if (run.parent_run_id !== null) {
      if (!runs.has(run.parent_run_id)) throw new TypeError('missing parent');
      children.get(run.parent_run_id).push(run.run_id);
    }
  }
  // Iterative leaf-to-root traversal handles arbitrary depth and detects cycles.
  const remaining = new Map([...children].map(([id, ids]) => [id, ids.length]));
  const sums = new Map([...runs].map(([id, run]) => [id, { ...run.own }]));
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  let processed = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    processed += 1;
    const parent = runs.get(id).parent_run_id;
    if (parent !== null) {
      add(sums.get(parent), sums.get(id));
      remaining.set(parent, remaining.get(parent) - 1);
      if (remaining.get(parent) === 0) ready.push(parent);
    }
  }
  if (processed !== runs.size) throw new TypeError('cyclic parents');
  const total = zero();
  for (const run of runs.values()) add(total, run.own);
  return {
    total,
    runs: [...runs.values()].sort((a, b) => a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0)
      .map((run) => ({ run_id: run.run_id, parent_run_id: run.parent_run_id,
        own: { ...run.own }, subtree: { ...sums.get(run.run_id) } })),
  };
}
