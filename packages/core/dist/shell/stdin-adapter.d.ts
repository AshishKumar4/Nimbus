import type { CommandInputStream } from '../substrate/lifo/commands/types.js';
/**
 * One consuming source behind the full reader contract, byte-accurate:
 * the text is encoded once and every offset is a byte offset, so
 * readBytes(1) over `é` yields exactly one UTF-8 byte per call and mixed
 * text/byte consumption never diverges. Worker pure-builtin adapters hold
 * stdin as a plain string; without this they can only offer readAll, and
 * streaming commands see an empty pipe.
 */
export declare function staticStdinReader(text: string): CommandInputStream;
//# sourceMappingURL=stdin-adapter.d.ts.map