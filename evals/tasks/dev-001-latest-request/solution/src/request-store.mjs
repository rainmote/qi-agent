export function createRequestStore() {
  let state = { status: 'idle', value: null, error: null };
  let generation = 0;
  return {
    getState() { return { ...state }; },
    async request(loader) {
      const current = ++generation;
      const previousValue = state.value;
      state = { status: 'loading', value: previousValue, error: null };
      try {
        const value = await loader();
        if (current === generation) state = { status: 'success', value, error: null };
        return value;
      } catch (error) {
        if (current === generation) state = { status: 'error', value: previousValue, error };
        throw error;
      }
    },
    reset(value = null) {
      generation += 1;
      state = { status: 'idle', value, error: null };
    },
  };
}
