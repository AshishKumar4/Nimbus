/**
 * utf8.ts — the UTF-8 length of a string, and the order of two strings by
 * their UTF-8 bytes, without encoding them.
 *
 * Bounds on names and payloads are in bytes, and the hot ones (every path a
 * W7 wave or a listing page carries) were measured by encoding the string
 * into a new buffer only to read its length. This counts the same bytes
 * TextEncoder would write: one to four per code point, and three for a
 * lone surrogate, which it writes as U+FFFD.
 */
export declare function utf8Length(text: string): number;
/**
 * `a` against `b` (negative, 0, positive) as their UTF-8 bytes order them,
 * as SQLite's `ORDER BY` of a text column and git's index do: code point
 * order. A string UTF-8 cannot write (a lone surrogate) is ordered as WTF-8
 * writes it, its surrogate a code point of its own: the order is total, as a
 * listing's cursor needs, and decided at the first code point that differs,
 * so a directory's entries follow it together. Units equal in both are
 * passed as they are; two that differ, neither a surrogate, are their own
 * code points; the rest, rare in a path, is surrogatesAt's.
 */
export declare function compareUtf8(a: string, b: string): number;
//# sourceMappingURL=utf8.d.ts.map