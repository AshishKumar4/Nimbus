/**
 * What the full-screen commands (less, nano, sl) draw and read with: the
 * ANSI sequences they write and the keys a terminal sends them.
 */

export const CSI = '\x1b[';
export const CLEAR = `${CSI}2J`;
export const HOME = `${CSI}H`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const ERASE_LINE = `${CSI}2K`;
export const INVERT = `${CSI}7m`;
export const BOLD = `${CSI}1m`;
export const RST = `${CSI}0m`;
export const ALT_SCREEN_ON = `${CSI}?1049h`;
export const ALT_SCREEN_OFF = `${CSI}?1049l`;

/** The cursor to a 0-based row and column. */
export function moveTo(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

export type KeyType =
  | 'char' | 'enter' | 'backspace' | 'delete' | 'tab'
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'ctrl-o' | 'ctrl-x' | 'ctrl-k' | 'ctrl-u' | 'ctrl-w'
  | 'ctrl-c' | 'escape' | 'unknown';

export interface KeyEvent {
  type: KeyType;
  char?: string;
}

const CONTROL_KEYS: Readonly<Record<string, KeyType>> = {
  '\r': 'enter', '\x7f': 'backspace', '\b': 'backspace', '\t': 'tab',
  '\x0f': 'ctrl-o', '\x18': 'ctrl-x', '\x0b': 'ctrl-k', '\x15': 'ctrl-u', '\x17': 'ctrl-w', '\x03': 'ctrl-c',
  '\x1b': 'escape',
};

/** The CSI sequences (after `ESC [`) the keys send, xterm's and the VT ones. */
const CSI_KEYS: Readonly<Record<string, KeyType>> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  '1~': 'home', '7~': 'home', '4~': 'end', '8~': 'end', '3~': 'delete', '5~': 'pageup', '6~': 'pagedown',
};

/** The key one chunk of terminal input is: a control key, a CSI key, or printable text. */
export function parseKey(data: string): KeyEvent {
  const control = CONTROL_KEYS[data];
  if (control) return { type: control };
  if (data.startsWith(CSI)) return { type: CSI_KEYS[data.slice(2)] ?? 'unknown' };
  if (data.length >= 1 && data.charCodeAt(0) >= 32) return { type: 'char', char: data };
  return { type: 'unknown' };
}
