export type TerminalEmulator = { write: (text: string) => void; fit: () => void;
  dimensions: () => { cols: number; rows: number }; dispose: () => void };

// Ordinary Web builds truthfully omit the desktop-only renderer. The desktop
// build replaces this module with a statically bundled pinned xterm entry.
export const terminalRendererAvailable = false;
export function createTerminalEmulator(_element: HTMLElement, _theme: { foreground: string; background: string }): TerminalEmulator | null { return null; }
