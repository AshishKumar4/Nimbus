/**
 * _shared/colors.ts — Minimal ANSI color helpers for terminal output.
 *
 * Wraps a string in SGR escape codes for use in WebSocket terminal
 * output (interactive prompts, error highlights, dimmed system
 * messages). Keep this list small — adding new colors should be
 * a deliberate UX choice, not boilerplate-driven creep.
 *
 * No dependency on a tty / NO_COLOR env check: the WS terminal is
 * always a real terminal (xterm.js on the client), and stripping
 * happens client-side via stripAnsi in process-logs.ts when a log
 * stream is consumed without a renderer.
 */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const wrap =
  (open: string) =>
  (s: string): string =>
    `${ESC}${open}m${s}${RESET}`;

export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
export const dim = wrap('2');
export const bold = wrap('1');
