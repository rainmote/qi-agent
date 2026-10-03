export function createRequestStore() {
  let state = { status: 'idle', value: null, error: null };
  return {
    getState() { return state; },
    async request(loader) {
      state = { status: 'loading', value: state.value, error: null };
      try {
        const value = await loader();
        state = { status: 'success', value, error: null };
        return value;
      } catch (error) {
        state = { status: 'error', value: state.value, error };
        throw error;
      }
    },
    reset(value = null) { state = { status: 'idle', value, error: null }; },
  };
}
