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
 * The code point at `index` of `text` as TextEncoder encodes it, with the
 * units it spans: a pair is one code point past U+FFFF, and a lone
 * surrogate is U+FFFD.
 */
function codePointAt(text, index) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff)
        return unit;
    if (unit <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff)
            return 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
    }
    return 0xfffd;
}
/**
 * `a` against `b` (negative, 0, positive) as their UTF-8 bytes order them,
 * as SQLite's `ORDER BY` of a text column and git's index do: code point
 * order, a lone surrogate being the U+FFFD TextEncoder writes for it.
 */
export function compareUtf8(a, b) {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const x = a.charCodeAt(i);
        const y = b.charCodeAt(j);
        // Neither a surrogate: one unit, its own code point.
        if (x === y && (x < 0xd800 || x > 0xdfff)) {
            i++;
            j++;
            continue;
        }
        const p = codePointAt(a, i);
        const q = codePointAt(b, j);
        if (p !== q)
            return p - q;
        i += p > 0xffff ? 2 : 1;
        j += q > 0xffff ? 2 : 1;
    }
    return (a.length - i) - (b.length - j);
}
