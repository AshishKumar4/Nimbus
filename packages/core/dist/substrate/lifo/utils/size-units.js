/**
 * Sizes as GNU's tools read and print them: one parser (gnulib's
 * xstrtoumax) and one printer (gnulib's human_readable), each tool passing
 * the suffix letters it accepts, as coreutils' callers pass theirs.
 */
/** A suffix's power of the base: k/K, m/M, g/G, t/T, P, E, Z, Y, R, Q. */
const POWERS = {
    k: 1, K: 1, m: 2, M: 2, g: 3, G: 3, t: 4, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10,
};
/** The suffixes that are a fixed size: 512-byte blocks, 1 KiB (obsolete), bytes, 2-byte words. */
const FIXED = { b: 512, B: 1024, c: 1, w: 2 };
/**
 * `text` as a count, as xstrtoumax reads it: optional blanks and `+`, digits
 * (in base 0, `0x` hex and leading-zero octal too), then at most one of the
 * letters in `suffixes`. A suffix with no digits before it counts one (`M`
 * is 1 MiB). Where `suffixes` holds `0`, the letter may be followed by `B`
 * (powers of 1000) or `iB` (of 1024, as the letter alone is). Null when
 * `text` is not such a count; a count too large for a double is Infinity.
 *
 * coreutils' tables: head and tail `bkKmMGTPEZYRQ0`, od `bEGKkMmPQRTYZ0`,
 * dd `bcEGkKMPQRTwYZ0`, du -B `EgGkKmMPtTYZ0`, du -t `kKmMGTPEZYRQ0` (as coreutils 9.7
 * answers each).
 */
export function parseSuffixedCount(text, suffixes, base = 10) {
    const digits = (base === 0 ? /^[ \t\n]*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/ : /^[ \t\n]*\+?([0-9]+)/).exec(text);
    let value = 1;
    if (digits) {
        const n = digits[1];
        value = base === 0 && /^0[xX]/.test(n) ? Number.parseInt(n.slice(2), 16)
            : base === 0 && n.startsWith('0') ? Number.parseInt(n, 8)
                : Number(n);
    }
    const rest = digits ? text.slice(digits[0].length) : text;
    if (rest === '')
        return digits ? value : null;
    const letter = rest[0];
    if (!suffixes.includes(letter) || letter === '0')
        return null;
    let radix = 1024;
    let length = 1;
    if (suffixes.includes('0')) {
        if (rest.startsWith('iB', 1))
            length = 3;
        else if (rest[1] === 'B' || rest[1] === 'D') {
            radix = 1000;
            length = 2;
        }
    }
    if (rest.length !== length)
        return null;
    const factor = FIXED[letter] ?? (POWERS[letter] === undefined ? undefined : radix ** POWERS[letter]);
    return factor === undefined ? null : value * factor;
}
const LETTERS = 'KMGTPEZYRQ';
/**
 * `bytes` as gnulib's human_readable prints it for du -h and df -h (ceiling,
 * autoscale): in `base` 1024 (K, M, ...) or 1000 (k, M, ...), rounded up,
 * with one decimal below 10. Integer arithmetic throughout, as gnulib's, so
 * the rounding is its rounding.
 */
export function humanReadable(bytes, base) {
    let amount = bytes;
    let tenths = 0;
    let rounding = 0;
    let exponent = 0;
    const letter = (power) => (power === 1 && base === 1000 ? 'k' : LETTERS[power - 1]);
    if (amount >= base) {
        do {
            const r10 = (amount % base) * 10 + tenths;
            const r2 = (r10 % base) * 2 + (rounding >> 1);
            amount = Math.floor(amount / base);
            tenths = Math.floor(r10 / base);
            rounding = r2 < base ? (r2 + rounding !== 0 ? 1 : 0) : 2 + (base < r2 + rounding ? 1 : 0);
            exponent++;
        } while (base <= amount && exponent < LETTERS.length);
        if (amount < 10) {
            if (rounding > 0) {
                tenths++;
                rounding = 0;
                if (tenths === 10) {
                    amount++;
                    tenths = 0;
                }
            }
            if (amount < 10)
                return `${amount}.${tenths}${letter(exponent)}`;
        }
    }
    if (tenths + rounding > 0) {
        amount++;
        if (amount === base && exponent < LETTERS.length)
            return `1.0${letter(exponent + 1)}`;
    }
    return exponent === 0 ? String(amount) : `${amount}${letter(exponent)}`;
}
