/**
 * utf8.ts — the UTF-8 length of a string, without encoding it.
 *
 * Bounds on names and payloads are in bytes, and the hot ones (every path a
 * W7 wave or a listing page carries) were measured by encoding the string
 * into a new buffer only to read its length. This counts the same bytes
 * TextEncoder would write: one to four per code point, and three for a
 * lone surrogate, which it writes as U+FFFD.
 */
export function utf8Length(text) {
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
