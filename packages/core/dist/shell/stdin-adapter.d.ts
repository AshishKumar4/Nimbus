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
/**
 * A live source behind the full reader contract: `pull` hands the next
 * bytes its producer delivered, waiting for them, and null at the end. The
 * reader asks for more only when a consumer reads, so a producer's queue
 * holds what is not read yet; what a read does not take (past a readBytes
 * bound, after a readLine's newline) stays here, in order, for the next.
 * Text is decoded progressively, so a multi-byte sequence split across two
 * deliveries survives, and an empty delivery is not the end.
 */
export declare function pulledStdinReader(pull: () => Promise<Uint8Array | null>): CommandInputStream;
//# sourceMappingURL=stdin-adapter.d.ts.map