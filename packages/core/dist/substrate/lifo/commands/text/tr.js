import { parseArgs } from '../../utils/args.js';
const spec = {
    delete: { type: 'boolean', short: 'd' },
    squeeze: { type: 'boolean', short: 's' },
    complement: { type: 'boolean', short: 'c' },
    truncate: { type: 'boolean', short: 't' },
};
/** POSIX character classes, in the order tr expands them. */
const CHARACTER_CLASSES = {
    alpha: range('A', 'Z') + range('a', 'z'),
    digit: range('0', '9'),
    alnum: range('0', '9') + range('A', 'Z') + range('a', 'z'),
    upper: range('A', 'Z'),
    lower: range('a', 'z'),
    space: ' \t\n\v\f\r',
    blank: ' \t',
    punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    print: range(' ', '~'),
    graph: range('!', '~'),
    cntrl: range('\x00', '\x1f') + '\x7f',
    xdigit: range('0', '9') + range('A', 'F') + range('a', 'f'),
};
function range(from, to) {
    let out = '';
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++)
        out += String.fromCharCode(c);
    return out;
}
const ESCAPES = {
    '\\': '\\', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
};
/**
 * Expand one SET operand into the characters it names.
 *
 * A SET is not a literal string. Ranges were expanded here, but escapes and
 * character classes were not, so the two characters in `'\n'` were taken at
 * face value and `tr '\n' ' '` — the commonest use of the command — replaced
 * every letter `n` with a space. That is a wrong answer rather than a
 * failure: `ls | tr '\n' ' '` returned `ode_modules package.jso ` and nothing
 * anywhere said so.
 *
 * Escapes are resolved BEFORE ranges so `\0-\11` is a range of the bytes
 * those escapes name, and a `-` that arrived as `\-` is a literal.
 */
function expandRange(set) {
    const chars = [];
    for (let i = 0; i < set.length; i++) {
        if (set[i] === '[' && set[i + 1] === ':') {
            const close = set.indexOf(':]', i + 2);
            const name = close === -1 ? '' : set.slice(i + 2, close);
            const expansion = CHARACTER_CLASSES[name];
            if (expansion !== undefined) {
                for (const ch of expansion)
                    chars.push({ ch, literal: true });
                i = close + 1;
                continue;
            }
        }
        if (set[i] === '\\' && i + 1 < set.length) {
            const next = set[i + 1];
            if (next >= '0' && next <= '7') {
                // Up to three octal digits name one byte.
                let digits = '';
                while (digits.length < 3 && set[i + 1] >= '0' && set[i + 1] <= '7') {
                    digits += set[++i];
                }
                chars.push({ ch: String.fromCharCode(parseInt(digits, 8)), literal: true });
                continue;
            }
            // An unknown escape is the character itself, as tr treats it.
            chars.push({ ch: ESCAPES[next] ?? next, literal: true });
            i++;
            continue;
        }
        chars.push({ ch: set[i], literal: false });
    }
    let result = '';
    for (let i = 0; i < chars.length; i++) {
        const dash = chars[i + 1];
        if (dash && !dash.literal && dash.ch === '-' && chars[i + 2]) {
            const start = chars[i].ch.charCodeAt(0);
            const end = chars[i + 2].ch.charCodeAt(0);
            for (let c = start; c <= end; c++)
                result += String.fromCharCode(c);
            i += 2;
            continue;
        }
        result += chars[i].ch;
    }
    return result;
}
const command = async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, spec);
    if (unknown.length > 0) {
        ctx.stderr.write(`tr: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
        return 1;
    }
    const deleteMode = flags.delete === true;
    const squeezeMode = flags.squeeze === true;
    const sets = positional;
    if (sets.length === 0) {
        ctx.stderr.write('tr: missing operand\n');
        return 1;
    }
    let text = '';
    if (ctx.stdin) {
        text = await ctx.stdin.readAll();
    }
    else {
        ctx.stderr.write('tr: missing input\n');
        return 1;
    }
    const set1 = expandRange(sets[0]);
    if (deleteMode) {
        let result = '';
        for (const ch of text) {
            if (!set1.includes(ch))
                result += ch;
        }
        // `tr -ds SET1 SET2` deletes SET1 and then squeezes SET2, which is why
        // the two sets are read separately rather than one being ignored.
        if (squeezeMode && sets.length > 1) {
            const squeezeSet = expandRange(sets[1]);
            let squeezed = '';
            let lastCh = '';
            for (const ch of result) {
                if (squeezeSet.includes(ch) && ch === lastCh)
                    continue;
                squeezed += ch;
                lastCh = ch;
            }
            result = squeezed;
        }
        ctx.stdout.write(result);
        return 0;
    }
    if (squeezeMode && sets.length === 1) {
        // Squeeze repeated characters in set1
        let result = '';
        let lastCh = '';
        for (const ch of text) {
            if (set1.includes(ch) && ch === lastCh)
                continue;
            result += ch;
            lastCh = ch;
        }
        ctx.stdout.write(result);
        return 0;
    }
    if (sets.length < 2) {
        ctx.stderr.write('tr: missing operand after set1\n');
        return 1;
    }
    const set2 = expandRange(sets[1]);
    // Build translation map
    const map = new Map();
    for (let i = 0; i < set1.length; i++) {
        map.set(set1[i], set2[Math.min(i, set2.length - 1)]);
    }
    let result = '';
    for (const ch of text) {
        result += map.get(ch) ?? ch;
    }
    // If squeeze mode is also set, squeeze the translated chars
    if (squeezeMode) {
        const set2Chars = new Set(set2);
        let squeezed = '';
        let lastCh = '';
        for (const ch of result) {
            if (set2Chars.has(ch) && ch === lastCh)
                continue;
            squeezed += ch;
            lastCh = ch;
        }
        result = squeezed;
    }
    ctx.stdout.write(result);
    return 0;
};
export default command;
