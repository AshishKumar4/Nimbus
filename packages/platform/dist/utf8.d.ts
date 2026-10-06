/**
 * utf8.ts — the UTF-8 length of a string, without encoding it.
 *
 * Bounds on names and payloads are in bytes, and the hot ones (every path a
 * W7 wave or a listing page carries) were measured by encoding the string
 * into a new buffer only to read its length. This counts the same bytes
 * TextEncoder would write: one to four per code point, and three for a
 * lone surrogate, which it writes as U+FFFD.
 */
export declare function utf8Length(text: string): number;
//# sourceMappingURL=utf8.d.ts.map