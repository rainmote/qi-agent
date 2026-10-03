const zero = () => ({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });

export function aggregateUsage(events) {
  const total = zero();
  const runs = new Map();
  for (const event of events) {
    const run = runs.get(event.run_id) ?? {
      run_id: event.run_id, parent_run_id: event.parent_run_id, own: zero(),
    };
    for (const key of Object.keys(total)) {
      const amount = event.usage[key] ?? 0;
      run.own[key] += amount;
      total[key] += amount;
    }
    runs.set(event.run_id, run);
  }
  return { total, runs: [...runs.values()].map((run) => ({ ...run, subtree: run.own })) };
}
