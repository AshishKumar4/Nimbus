/**
 * What the full-screen commands (less, nano, sl) draw and read with: the
 * ANSI sequences they write and the keys a terminal sends them.
 */
export declare const CSI = "\u001B[";
export declare const CLEAR = "\u001B[2J";
export declare const HOME = "\u001B[H";
export declare const HIDE_CURSOR = "\u001B[?25l";
export declare const SHOW_CURSOR = "\u001B[?25h";
export declare const ERASE_LINE = "\u001B[2K";
export declare const INVERT = "\u001B[7m";
export declare const BOLD = "\u001B[1m";
export declare const RST = "\u001B[0m";
export declare const ALT_SCREEN_ON = "\u001B[?1049h";
export declare const ALT_SCREEN_OFF = "\u001B[?1049l";
/** The cursor to a 0-based row and column. */
export declare function moveTo(row: number, col: number): string;
export type KeyType = 'char' | 'enter' | 'backspace' | 'delete' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'ctrl-o' | 'ctrl-x' | 'ctrl-k' | 'ctrl-u' | 'ctrl-w' | 'ctrl-c' | 'escape' | 'unknown';
export interface KeyEvent {
    type: KeyType;
    char?: string;
}
/** The key one chunk of terminal input is: a control key, a CSI key, or printable text. */
export declare function parseKey(data: string): KeyEvent;
//# sourceMappingURL=term-screen.d.ts.map