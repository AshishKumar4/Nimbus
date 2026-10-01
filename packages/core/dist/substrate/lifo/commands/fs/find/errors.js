/**
 * A command line GNU find refuses: its message (after `find: `), any lines
 * GNU prints after it as they are, and exit status 1, before any file is visited.
 */
export class FindUsageError extends Error {
    continuation;
    constructor(message, continuation = []) {
        super(message);
        this.continuation = continuation;
    }
}
const CONTROL_ESCAPES = {
    '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v',
};
/**
 * A file name in a diagnostic, as gnulib's locale quoting style writes it in
 * the C locale: in single quotes, with quotes, backslashes and control
 * characters escaped (`'it\'s'`, `'a\tb'`).
 */
export function quote(name) {
    let out = "'";
    for (const ch of name) {
        if (ch === '\\' || ch === "'")
            out += `\\${ch}`;
        else if (CONTROL_ESCAPES[ch] !== undefined)
            out += CONTROL_ESCAPES[ch];
        else if (ch < ' ' || ch === '\x7f')
            out += `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}`;
        else
            out += ch;
    }
    return `${out}'`;
}
