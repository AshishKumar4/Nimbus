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
};
const HEX = /x([0-9a-fA-F]{1,2})/y;
const UNICODE = /(?:u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/y;
/** The numeric escape (octal, hex or Unicode) starting at `at`, if one does. */
function numericEscape(text, at, dialect) {
    for (const pattern of [OCTAL[dialect], HEX, UNICODE]) {
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
    let i = 0;
    while (i < text.length) {
        const slash = text.indexOf('\\', i);
        if (slash === -1 || slash === text.length - 1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, slash);
        const next = text[slash + 1];
        if (next === 'c')
            return { text: out, stopped: true };
        const numeric = numericEscape(text, slash + 1, dialect);
        const digits = numeric?.[1] ?? numeric?.[2] ?? '';
        const unicode = next === 'u' || next === 'U';
        if (numeric && !(unicode && Number.parseInt(digits, 16) > 0x10ffff)) {
            // An octal escape names a byte: `\777` is 0xff, as printf's putchar has it.
            out += next === 'x' ? String.fromCharCode(Number.parseInt(digits, 16))
                : unicode ? String.fromCodePoint(Number.parseInt(digits, 16))
                    : String.fromCharCode(Number.parseInt(digits || '0', 8) & 0xff);
            i = slash + 1 + numeric[0].length;
            continue;
        }
        if (SIMPLE[next] !== undefined)
            out += SIMPLE[next];
        else if (next === 'E' && dialect === 'echo')
            out += '\x1b';
        else if (next === '"' && dialect !== 'echo')
            out += '"';
        else
            out += `\\${next}`;
        i = slash + 2;
    }
    return { text: out, stopped: false };
}
/**
 * What bash's `echo` prints for `args`: leading words of -n/-e/-E letters are
 * its options (`--` ends them), the rest joined by spaces; -e expands escapes,
 * and a `\c` among them ends the output with no newline.
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
