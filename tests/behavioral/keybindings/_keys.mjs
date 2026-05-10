// keybindings — shared escape-sequence constants + helpers.
//
// We send these bytes over the WS exactly as a real xterm would emit
// them. The shell sees them as `data` strings in `handleInput`.
//
// Reference: xterm Function-key Strings + bash readline binding table.

export const ESC = '\x1b';

// Arrows (no modifier)
export const ARROW_LEFT = ESC + '[D';
export const ARROW_RIGHT = ESC + '[C';
export const ARROW_UP = ESC + '[A';
export const ARROW_DOWN = ESC + '[B';

// Home / End (xterm default + Linux variants)
export const HOME = ESC + '[H';
export const HOME_LINUX = ESC + '[1~';
export const END = ESC + '[F';
export const END_LINUX = ESC + '[4~';
export const DELETE = ESC + '[3~';
export const BACKSPACE = '\x7f';

// Ctrl+letter (one byte)
export const CTRL_A = '\x01';
export const CTRL_B = '\x02';
export const CTRL_C = '\x03';
export const CTRL_D = '\x04';
export const CTRL_E = '\x05';
export const CTRL_F = '\x06';
export const CTRL_H = '\x08';
export const CTRL_K = '\x0b';
export const CTRL_L = '\x0c';
export const CTRL_N = '\x0e';
export const CTRL_P = '\x10';
export const CTRL_R = '\x12';
export const CTRL_T = '\x14';
export const CTRL_U = '\x15';
export const CTRL_W = '\x17';
export const CTRL_Y = '\x19';
export const CTRL_BACKSLASH = '\x1c';

// Ctrl+Arrow (xterm modifier-5 sequences — Linux + standards-conformant)
export const CTRL_LEFT = ESC + '[1;5D';
export const CTRL_RIGHT = ESC + '[1;5C';
export const CTRL_UP = ESC + '[1;5A';
export const CTRL_DOWN = ESC + '[1;5B';

// Alt+Arrow (xterm modifier-3 sequences — Mac Option+Arrow when
// `macOptionIsMeta:true`, also some Linux terminals)
export const ALT_LEFT_MOD3 = ESC + '[1;3D';
export const ALT_RIGHT_MOD3 = ESC + '[1;3C';

// Alt+letter (meta-prefixed — Linux Alt and Mac Option-as-Meta)
export const ALT_B = ESC + 'b';
export const ALT_F = ESC + 'f';
export const ALT_D = ESC + 'd';
export const ALT_DOT = ESC + '.';
export const ALT_BACKSPACE = ESC + '\x7f';
export const ALT_U = ESC + 'u';
export const ALT_L = ESC + 'l';
export const ALT_C = ESC + 'c';

// Enter
export const CR = '\r';
