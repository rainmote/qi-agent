// Statically bundled only after the complete pinned workspace closure is
// verified. No CDN, dynamic JS evaluation or runtime module fetching.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@qi-terminal-renderer-css';

export const terminalRendererAvailable = true;
export function createTerminalEmulator(element, theme) {
  const terminal = new Terminal({ disableStdin: true, convertEol: false, scrollback: 2000,
    allowProposedApi: false, screenReaderMode: true, fontSize: 12, theme });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  fit.fit();
  // Input is an explicit staged/approved RPC, not an output-driven response.
  // No link, clipboard, web-attach or automatic onData handlers are installed.
  return { write: text => terminal.write(text), fit: () => fit.fit(),
    dimensions: () => ({ cols: terminal.cols, rows: terminal.rows }), dispose: () => terminal.dispose() };
}
