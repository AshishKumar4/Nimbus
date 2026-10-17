import { decodeLossless, encodeLossless, joinLossless } from './lossless-text.js';
const SIMPLE = {
    '\\': '\\',
    a: '\x07',
    b: '\b',
    e: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
};
const OCTAL = {
    echo: /0([0-7]{0,3})/y,
    printf: /([0-7]{1,3})/y,
    'printf-b': /(?:0([0-7]{0,3})|([1-7][0-7]{0,2}))/y,
    'ansi-c': /([0-7]{1,3})/y,
};
const HEX = /x([0-9a-fA-F]{1,2})/y;
// `$'...'` alone: `\x{H...}`, any run of hex digits, its closing brace optional.
const BRACED_HEX = /x\{([0-9a-fA-F]*)\}?/y;
const UNICODE = /(?:u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/y;
const NUMERIC = {
    echo: [OCTAL.echo, HEX, UNICODE],
    printf: [OCTAL.printf, HEX, UNICODE],
    'printf-b': [OCTAL['printf-b'], HEX, UNICODE],
    'ansi-c': [OCTAL['ansi-c'], BRACED_HEX, HEX, UNICODE],
};
/**
 * The bytes bash's UTF-8 conversion writes for code point `cp`: its own
 * three for a surrogate, never paired, and the wider forms past U+10FFFF
 * (to six bytes, below 0x80000000), each as U+DC00 + byte.
 */
function wideUtf8(cp) {
    const length = cp < 0x10000 ? 3 : cp < 0x200000 ? 4 : cp < 0x4000000 ? 5 : 6;
    const lead = [0, 0, 0, 0xe0, 0xf0, 0xf8, 0xfc][length];
    let out = String.fromCharCode(0xdc00 | lead | Math.floor(cp / 2 ** (6 * (length - 1))));
    for (let shift = 6 * (length - 2); shift >= 0; shift -= 6)
        out += String.fromCharCode(0xdc00 | 0x80 | (Math.floor(cp / 2 ** shift) & 0x3f));
    return out;
}
/** The numeric escape (octal, hex or Unicode) starting at `at`, if one does. */
function numericEscape(text, at, dialect) {
    for (const pattern of NUMERIC[dialect]) {
        pattern.lastIndex = at;
        const match = pattern.exec(text);
        if (match)
            return match;
    }
    return null;
}
/** `text` with its escapes expanded; `stopped` when a `\c` cut it short there. */
export function expandBackslashEscapes(text, dialect) {
    let out = '';
    // Whether an escape wrote a byte past ASCII, held as U+DC00 + byte until the end.
    let bytes = false;
    let stopped = false;
    let i = 0;
    while (i < text.length) {
        const slash = text.indexOf('\\', i);
        if (slash === -1 || slash === text.length - 1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, slash);
        const next = text[slash + 1];
        if (next === 'c' && dialect !== 'ansi-c') {
            stopped = true;
            break;
        }
        if (next === 'c' && slash + 2 < text.length) {
            // X's control character, from its first UTF-8 byte (the rest follow
            // it); `\c\\` takes both backslashes, as bash reads it.
            const target = String.fromCodePoint(text.codePointAt(slash + 2) ?? 0);
            const [lead, ...rest] = encodeLossless(target);
            const control = lead === 0x3f ? 0x7f : lead & 0x1f;
            out += String.fromCharCode(control) + rest.map((byte) => String.fromCharCode(0xdc00 + byte)).join('');
            bytes ||= rest.length > 0;
            i = slash + 2 + target.length + (target === '\\' && text[slash + 3] === '\\' ? 1 : 0);
            continue;
        }
        const numeric = numericEscape(text, slash + 1, dialect);
        const digits = numeric?.[1] ?? numeric?.[2] ?? '';
        const unicode = next === 'u' || next === 'U';
        const cp = unicode ? Number.parseInt(digits, 16) : 0;
        if (numeric) {
            if (unicode && cp >= 0x80000000) {
                // Past bash's widest form: nothing.
            }
            else if (unicode && ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff)) {
                out = joinLossless(out, wideUtf8(cp));
                bytes = true;
            }
            else if (unicode)
                out += String.fromCodePoint(cp);
            else {
                // `\777` is 0xff, as putchar has it; a hex run keeps its last two digits' byte.
                const byte = next === 'x' ? [...digits].reduce((value, digit) => ((value << 4) | Number.parseInt(digit, 16)) & 0xff, 0)
                    : Number.parseInt(digits || '0', 8) & 0xff;
                out = joinLossless(out, String.fromCharCode(byte < 0x80 ? byte : 0xdc00 + byte));
                bytes ||= byte >= 0x80;
            }
            i = slash + 1 + numeric[0].length;
            continue;
        }
        if (SIMPLE[next] !== undefined)
            out += SIMPLE[next];
        else if (next === 'E' && (dialect === 'echo' || dialect === 'ansi-c'))
            out += '\x1b';
        else if (next === '"' && dialect !== 'echo')
            out += '"';
        else if ((next === "'" || next === '?') && dialect === 'ansi-c')
            out += next;
        else
            out += `\\${next}`;
        i = slash + 2;
    }
    if (dialect === 'ansi-c') {
        const nul = out.indexOf('\0');
        if (nul !== -1)
            out = out.slice(0, nul);
    }
    // Escaped bytes that spell a character together (`\303\251`) read as it.
    return { text: bytes ? decodeLossless(encodeLossless(out)) : out, stopped };
}
/**
 * What bash's `echo` prints for `args`, as lossless text: leading words of
 * -n/-e/-E letters are its options (`--` ends them), the rest joined by
 * spaces; -e expands escapes, and a `\c` among them ends the output with no
 * newline.
 */
export function echoOutput(args) {
    let interpretEscapes = false;
    let suppressNewline = false;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (!/^-[neE]+$/.test(arg))
            break;
        for (const ch of arg.slice(1)) {
            if (ch === 'n')
                suppressNewline = true;
            else
                interpretEscapes = ch === 'e';
        }
    }
    const body = args.slice(i).join(' ');
    if (!interpretEscapes)
        return suppressNewline ? body : `${body}\n`;
    const { text, stopped } = expandBackslashEscapes(body, 'echo');
    return suppressNewline || stopped ? text : `${text}\n`;
}
