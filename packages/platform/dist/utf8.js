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
/** From this many UTF-16 units, a string is counted natively (longUtf8Length). */
const LONG_UNITS = 256;
const encoder = new TextEncoder();
/** Where longUtf8Length's encodes land: written, never read. */
let scratch;
export function utf8Length(text) {
    if (text.length >= LONG_UNITS)
        return longUtf8Length(text);
    let bytes = text.length;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80)
            continue;
        if (unit < 0x800) {
            bytes += 1;
        }
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                // A pair: two units, four bytes.
                bytes += 2;
                index++;
            }
            else {
                bytes += 2;
            }
        }
        else {
            bytes += 2;
        }
    }
    return bytes;
}
/**
 * A long string's UTF-8 length at the engine's speed: encoded a slice at a
 * time into one reused buffer, only the count kept. encodeInto never splits
 * a surrogate pair, so each slice starts on a code point.
 */
function longUtf8Length(text) {
    scratch ??= new Uint8Array(256 * 1024);
    let bytes = 0;
    for (let read = 0; read < text.length;) {
        const done = encoder.encodeInto(read === 0 ? text : text.slice(read), scratch);
        read += done.read;
        bytes += done.written;
    }
    return bytes;
}
/**
 * The code point at `index` of `text`: a pair is one past U+FFFF, and a lone
 * surrogate is its own (as WTF-8 writes it, between U+D7FF and U+E000).
 */
function codePointAt(text, index) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdbff || index + 1 >= text.length)
        return unit;
    const next = text.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00) : unit;
}
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
export function compareUtf8(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a.charCodeAt(i);
        const y = b.charCodeAt(i);
        if (x === y)
            continue;
        if ((x < 0xd800 || x > 0xdfff) && (y < 0xd800 || y > 0xdfff))
            return x - y;
        return surrogatesAt(a, b, i);
    }
    return a.length - b.length;
}
/** compareUtf8 of `a` and `b`, equal before `i`, where they differ at `i` and one unit there is a surrogate. */
function surrogatesAt(a, b, i) {
    // A low half after a high one the two share: the code points begin at the high one.
    const before = i > 0 ? a.charCodeAt(i - 1) : 0;
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    const at = before >= 0xd800 && before <= 0xdbff && ((x >= 0xdc00 && x <= 0xdfff) || (y >= 0xdc00 && y <= 0xdfff)) ? i - 1 : i;
    return codePointAt(a, at) - codePointAt(b, at);
}
