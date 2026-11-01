// Retrying a read must preserve the last visible progress, including on failure.
export async function loadDemoState(invoke, demo) {
  try {
    const response = await invoke('demoState');
    if (response.demo) return { demo: response.demo, message: null, loadFailed: false };
    return { demo, loadFailed: true, message: { tone: 'warning', text: response.message || (response.errors ?? []).join('; ') || 'Could not load the demo.' } };
  } catch (error) {
    return { demo, loadFailed: true, message: { tone: 'error', text: `Could not load the demo: ${String(error)}` } };
  }
}
