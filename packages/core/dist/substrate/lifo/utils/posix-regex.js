/**
 * POSIX regular expressions (basic and extended, with GNU's extensions) as
 * JavaScript regex source for the `u` flag, over text held losslessly
 * (bytes-io.ts): a byte that is not valid UTF-8 is U+DC80 + byte, and
 * neither `.` nor a negated bracket matches it, as GNU's matchers do not
 * match an encoding error. Used by grep and sed.
 */
export class PosixRegexSyntax extends Error {
}
/** An invalid byte, as the lossless decoding holds it. */
const INVALID_BYTES = '\\udc80-\\udcff';
export const WORD = '[\\p{L}\\p{N}_]';
export const NOT_WORD = '[^\\p{L}\\p{N}_]';
const CLASSES = {
    alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{Nd}', upper: '\\p{Lu}', lower: '\\p{Ll}',
    space: '\\s', blank: ' \\t', punct: '\\p{P}\\p{S}', print: '\\P{C}', graph: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}',
    cntrl: '\\p{Cc}', xdigit: '0-9A-Fa-f',
};
/** A character as a literal in a JavaScript `u` pattern; `-` is escaped only in a class. */
/** A character as a literal in a `u` pattern. */
export function literalChar(ch) { return literal(ch); }
function literal(ch, inClass = false) {
    if (ch === '-')
        return inClass ? '\\-' : '-';
    return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}
const collator = new Intl.Collator('en-US', { caseFirst: 'lower' });
const rangeMembers = new Map();
/**
 * glibc's regex (sed's) takes a range between two letters by collation, in
 * en_US.UTF-8: `[a-z]` holds the lowercase letters that collate from a to z
 * (é, ß, ø, but not ž, which follows z, nor É). GNU grep's own
 * matcher keeps ranges to their code points.
 */
function collatedRange(lo, hi) {
    const key = lo + hi;
    let members = rangeMembers.get(key);
    if (members === undefined) {
        const upper = lo >= 'A' && lo <= 'Z';
        members = '';
        for (const [from, to] of [[0xc0, 0x24f], [0x1e00, 0x1eff]]) {
            for (let cp = from; cp <= to; cp++) {
                const c = String.fromCodePoint(cp);
                if (!(upper ? /\p{Lu}/u : /\p{Ll}/u).test(c))
                    continue;
                if (collator.compare(lo, c) <= 0 && collator.compare(c, hi) <= 0)
                    members += c;
            }
        }
        rangeMembers.set(key, members);
    }
    return members;
}
/** A POSIX bracket expression starting at `i` (after '['): its JS class and where it ends. */
function bracket(p, i, collating = false) {
    let out = '[';
    let negated = false;
    if (p[i] === '^') {
        out += '^';
        i++;
        negated = true;
    }
    let first = true;
    for (;;) {
        if (i >= p.length)
            throw new PosixRegexSyntax('Unmatched [, [^, [:, [., or [=');
        const ch = p[i];
        if (ch === ']' && !first)
            return { source: out + (negated ? INVALID_BYTES : '') + ']', end: i + 1 };
        first = false;
        if (ch === '[' && (p[i + 1] === ':' || p[i + 1] === '=' || p[i + 1] === '.')) {
            const kind = p[i + 1];
            const close = p.indexOf(`${kind}]`, i + 2);
            if (close === -1)
                throw new PosixRegexSyntax('Unmatched [, [^, [:, [., or [=');
            const name = p.slice(i + 2, close);
            if (kind === ':') {
                const cls = CLASSES[name];
                if (cls === undefined)
                    throw new PosixRegexSyntax('Invalid character class name');
                out += cls;
            }
            else {
                out += [...name].map((c) => literal(c, true)).join('');
            }
            i = close + 2;
            continue;
        }
        // A range keeps its dash; any other character is taken literally.
        if (ch === '-' && !first && p[i + 1] !== ']' && out.length > 1 && out !== '[^') {
            const lo = p[i - 1], hi = p[i + 1];
            out += '-';
            if (collating && /[a-z]/.test(lo) === /[a-z]/.test(hi) && /[A-Za-z]/.test(lo) && /[A-Za-z]/.test(hi)) {
                out += literal(hi, true) + collatedRange(lo, hi);
                i += 2;
                continue;
            }
        }
        else
            out += literal(ch, true);
        i++;
    }
}
/** A BRE or ERE as JavaScript regex source (`u` flag). */
export function translate(p, options) {
    const extended = options.extended;
    let out = '';
    // Where an operator would have nothing to apply to (so it is literal), and open groups.
    let atStart = true;
    let depth = 0;
    let groups = 0;
    for (let i = 0; i < p.length;) {
        const ch = p[i];
        const start = atStart;
        atStart = false;
        if (ch === '\\') {
            const next = p[i + 1];
            if (next === undefined)
                throw new PosixRegexSyntax('Trailing backslash');
            i += 2;
            if (!extended && next === '(') {
                out += '(';
                depth++;
                groups++;
                atStart = true;
                continue;
            }
            if (!extended && next === ')') {
                if (depth === 0)
                    throw new PosixRegexSyntax('Unmatched ) or \\)');
                out += ')';
                depth--;
                continue;
            }
            if (!extended && next === '|') {
                out += '|';
                atStart = true;
                continue;
            }
            if (!extended && (next === '+' || next === '?')) {
                out += start ? literal(next) : next;
                continue;
            }
            if (!extended && next === '{') {
                const close = p.indexOf('\\}', i);
                if (close === -1)
                    throw new PosixRegexSyntax('Unmatched \\{');
                out += interval(p.slice(i, close), start);
                i = close + 2;
                continue;
            }
            if (options.sed && next === 'n') {
                out += '\\n';
                continue;
            }
            if (options.sed && next === 't') {
                out += '\\t';
                continue;
            }
            if (options.sed && next === 'x' && /^[0-9a-fA-F]{1,2}/.test(p.slice(i))) {
                const hex = /^[0-9a-fA-F]{1,2}/.exec(p.slice(i))[0];
                i += hex.length;
                const byte = parseInt(hex, 16);
                // A byte past ASCII is one no valid character spells: the invalid byte's own marker.
                out += byte < 0x80 ? literal(String.fromCharCode(byte)) : `\\u${(0xdc00 + byte).toString(16)}`;
                continue;
            }
            if (/[1-9]/.test(next)) {
                if (Number(next) > groups)
                    throw new PosixRegexSyntax('Invalid back reference');
                out += `\\${next}`;
                continue;
            }
            if (next === '<') {
                out += `(?<!${WORD})(?=${WORD})`;
                continue;
            }
            if (next === '>') {
                out += `(?<=${WORD})(?!${WORD})`;
                continue;
            }
            if (next === 'b') {
                out += `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
                continue;
            }
            if (next === 'B') {
                out += `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`;
                continue;
            }
            if (next === 'w') {
                out += WORD;
                continue;
            }
            if (next === 'W') {
                out += NOT_WORD;
                continue;
            }
            if (next === 's') {
                out += '\\s';
                continue;
            }
            if (next === 'S') {
                out += '\\S';
                continue;
            }
            if (next === '`') {
                out += '^';
                continue;
            }
            if (next === "'") {
                out += '$';
                continue;
            }
            out += literal(next);
            continue;
        }
        i++;
        if (ch === '[') {
            if (p.startsWith(':', i) && /^:[a-z]+:\]/.test(p.slice(i))) {
                throw new PosixRegexSyntax('character class syntax is [[:space:]], not [:space:]');
            }
            const b = bracket(p, i, options.sed === true);
            out += b.source;
            i = b.end;
            continue;
        }
        if (ch === '.') {
            out += `[^${INVALID_BYTES}]`;
            continue;
        }
        if (ch === '*') {
            out += start ? '\\*' : '*';
            continue;
        }
        if (ch === '^') {
            // BRE: an anchor only first in the pattern or a group; ERE: always.
            if (extended || start) {
                out += '^';
                atStart = true;
            }
            else
                out += '\\^';
            continue;
        }
        if (ch === '$') {
            const last = i === p.length || (!extended && (p.startsWith('\\)', i) || p.startsWith('\\|', i)));
            out += extended || last ? '$' : '\\$';
            continue;
        }
        if (extended) {
            if (ch === '(') {
                out += '(';
                depth++;
                groups++;
                atStart = true;
                continue;
            }
            if (ch === ')') {
                // An unmatched ) is an ordinary character in GNU's ERE.
                if (depth === 0) {
                    out += '\\)';
                    continue;
                }
                out += ')';
                depth--;
                continue;
            }
            if (ch === '|') {
                out += '|';
                atStart = true;
                continue;
            }
            if (ch === '+' || ch === '?') {
                out += start ? literal(ch) : ch;
                continue;
            }
            if (ch === '{') {
                const close = p.indexOf('}', i);
                const body = close === -1 ? null : p.slice(i, close);
                if (start || body === null || !/^\d*(,\d*)?$/.test(body) || body === '' || body === ',') {
                    out += '\\{';
                    continue;
                }
                out += interval(body, false);
                i = close + 1;
                continue;
            }
        }
        out += literal(ch);
    }
    if (depth > 0)
        throw new PosixRegexSyntax('Unmatched ( or \\(');
    return out;
}
function interval(body, start) {
    if (start)
        throw new PosixRegexSyntax('Invalid preceding regular expression');
    const m = /^(\d*)(,?)(\d*)$/.exec(body);
    if (m === null || (m[1] === '' && m[2] === ''))
        throw new PosixRegexSyntax('Invalid content of \\{\\}');
    const lo = m[1] === '' ? 0 : Number(m[1]);
    const hi = m[2] === '' ? lo : m[3] === '' ? Infinity : Number(m[3]);
    if (hi < lo || lo > 32767 || (hi !== Infinity && hi > 32767))
        throw new PosixRegexSyntax('Invalid content of \\{\\}');
    return m[2] === '' ? `{${lo}}` : hi === Infinity ? `{${lo},}` : `{${lo},${hi}}`;
}
