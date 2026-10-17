/**
 * The look Nimbus's browser terminals share: the shell's and its process
 * tabs' (public/s/index.html, through the worker's terminal-policy asset)
 * and the docs' sandbox (apps/docs NimbusSandbox.astro). Font size and
 * background are each terminal's own.
 */

export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, monospace";

export const TERMINAL_CURSOR = { cursorBlink: true, cursorStyle: 'bar' } as const;

/** xterm's theme, but its background. */
export const TERMINAL_THEME = {
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#c9d1d9',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d364', brightWhite: '#f0f6fc',
} as const;
