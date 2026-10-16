/**
 * utf8.ts — the UTF-8 length of a string, without encoding it.
 *
 * Bounds on names and payloads are in bytes, and the hot ones (every path a
 * W7 wave or a listing page carries) were measured by encoding the string
 * into a new buffer only to read its length. This counts the same bytes
 * TextEncoder would write: one to four per code point, and three for a
 * lone surrogate, which it writes as U+FFFD.
 */
/** From this many UTF-16 units, a string is counted natively (longUtf8Length). */
const LONG_UNITS = 256;
const NON_ASCII = /[^\x00-\x7f]/;
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
 * A long string's UTF-8 length at the engine's speed: ASCII text, most of
 * any source, is its length, which one scan finds; other text is encoded a
 * slice at a time into one reused buffer, only the count kept. For 31 M
 * units of a module map, V8 took 40-60 ms counting a unit at a time and
 * 11 ms this way. encodeInto never splits a surrogate pair, so each slice
 * starts on a code point.
 */
function longUtf8Length(text) {
    if (!NON_ASCII.test(text))
        return text.length;
    scratch ??= new Uint8Array(256 * 1024);
    let bytes = 0;
    for (let read = 0; read < text.length;) {
        const done = encoder.encodeInto(read === 0 ? text : text.slice(read), scratch);
        read += done.read;
        bytes += done.written;
    }
    return bytes;
}
