import { encodeLossless, inputChunks, writeBytes } from '../../utils/bytes-io.js';
// GNU tr (coreutils 9.7): bytes in, bytes out, as GNU's tr is (a set's
// multibyte character is its bytes). Sets: ranges, octal and backslash
// escapes, [:class:], [=c=], and in SET2 [c*n] / [c*]. -c/-C, -d, -s, -t.
class TrUsage extends Error {
}
class TrError extends Error {
}
const ESCAPES = { '\\': 0x5c, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
const CLASSES = {
    alnum: (b) => isDigit(b) || isUpper(b) || isLower(b),
    alpha: (b) => isUpper(b) || isLower(b),
    blank: (b) => b === 32 || b === 9,
    cntrl: (b) => b < 32 || b === 127,
    digit: (b) => isDigit(b),
    graph: (b) => b > 32 && b < 127,
    lower: (b) => isLower(b),
    print: (b) => b >= 32 && b < 127,
    punct: (b) => b > 32 && b < 127 && !isDigit(b) && !isUpper(b) && !isLower(b),
    space: (b) => b === 32 || (b >= 9 && b <= 13),
    upper: (b) => isUpper(b),
    xdigit: (b) => isDigit(b) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102),
};
function isDigit(b) { return b >= 48 && b <= 57; }
function isUpper(b) { return b >= 65 && b <= 90; }
function isLower(b) { return b >= 97 && b <= 122; }
/** A SET's items, escapes resolved, ranges expanded. */
function parseSet(text, second) {
    const s = encodeLossless(text);
    const quoted = (display) => `\u2018${display}\u2019`;
    // Escapes first, remembering which bytes were escaped (a `\-` is not a range).
    const atoms = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === 0x5c && i + 1 < s.length) {
            const n = s[i + 1];
            if (n >= 0x30 && n <= 0x37) {
                let v = 0;
                let k = 0;
                while (k < 3 && i + 1 < s.length && s[i + 1] >= 0x30 && s[i + 1] <= 0x37) {
                    const next = v * 8 + (s[i + 1] - 0x30);
                    if (next > 255)
                        break;
                    v = next;
                    i++;
                    k++;
                }
                atoms.push({ b: v, escaped: true });
                continue;
            }
            const e = ESCAPES[String.fromCharCode(n)];
            atoms.push({ b: e ?? n, escaped: true });
            i++;
            continue;
        }
        atoms.push({ b: s[i], escaped: false });
    }
    const items = [];
    for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        // [:class:], [=c=], [c*n]
        if (!a.escaped && a.b === 0x5b && i + 1 < atoms.length) {
            const rest = atoms.slice(i + 1);
            const str = String.fromCharCode(...rest.map((x) => x.b));
            const cls = /^:([a-z]+):\]/.exec(str);
            if (cls) {
                if (!(cls[1] in CLASSES))
                    throw new TrError(`invalid character class ${quoted(cls[1])}`);
                items.push({ kind: 'class', name: cls[1] });
                i += cls[0].length;
                continue;
            }
            if (rest.length >= 3 && rest[0].b === 0x3d && rest[2].b === 0x3d && rest[3]?.b === 0x5d) {
                items.push({ kind: 'byte', b: rest[1].b });
                i += 4;
                continue;
            }
            if (rest.length >= 3 && rest[1].b === 0x2a && !rest[1].escaped) {
                const close = rest.findIndex((x, k) => k >= 2 && x.b === 0x5d && !x.escaped);
                if (close !== -1) {
                    const digits = String.fromCharCode(...rest.slice(2, close).map((x) => x.b));
                    if (/^\d*$/.test(digits)) {
                        const n = digits === '' ? null : digits.startsWith('0') ? parseInt(digits, 8) : parseInt(digits, 10);
                        if (n !== null && Number.isNaN(n))
                            throw new TrError(`invalid repeat count ${quoted(digits)} in [c*n] construct`);
                        // In SET1 a repeat needs its count; only SET2 may fill with [c*].
                        if (!second && (n === null || n === 0))
                            throw new TrError('the [c*] repeat construct may not appear in string1');
                        items.push({ kind: 'repeat', b: rest[0].b, n: n === 0 ? null : n });
                        i += close + 1;
                        continue;
                    }
                }
            }
        }
        const dash = atoms[i + 1];
        const end = atoms[i + 2];
        if (dash && end && dash.b === 0x2d && !dash.escaped) {
            if (end.b < a.b) {
                const show = (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`);
                throw new TrError(`range-endpoints of ${quoted(`${show(a.b)}-${show(end.b)}`)} are in reverse collating sequence order`);
            }
            for (let b = a.b; b <= end.b; b++)
                items.push({ kind: 'byte', b });
            i += 2;
            continue;
        }
        items.push({ kind: 'byte', b: a.b });
    }
    return items;
}
function expand(items, fill) {
    const out = [];
    for (const item of items) {
        if (item.kind === 'byte')
            out.push(item.b);
        else if (item.kind === 'class')
            for (let b = 0; b < 256; b++) {
                if (CLASSES[item.name](b))
                    out.push(b);
            }
        else if (item.n !== null)
            for (let k = 0; k < item.n; k++)
                out.push(item.b);
        else
            for (let k = 0; k < fill; k++)
                out.push(item.b);
    }
    return out;
}
const command = async (ctx) => {
    let complement = false, del = false, squeeze = false, truncate = false;
    const sets = [];
    const usage = async (message) => {
        await ctx.stderr.write(`tr: ${message}\nTry 'tr --help' for more information.\n`);
        return 1;
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            sets.push(...args.slice(i + 1));
            break;
        }
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            if (name === 'complement')
                complement = true;
            else if (name === 'delete')
                del = true;
            else if (name === 'squeeze-repeats')
                squeeze = true;
            else if (name === 'truncate-set1')
                truncate = true;
            else
                return usage(`unrecognized option '--${name}'`);
            continue;
        }
        if (!arg.startsWith('-') || arg.length === 1) {
            sets.push(arg);
            continue;
        }
        for (const flag of arg.slice(1)) {
            if (flag === 'c' || flag === 'C')
                complement = true;
            else if (flag === 'd')
                del = true;
            else if (flag === 's')
                squeeze = true;
            else if (flag === 't')
                truncate = true;
            else
                return usage(`invalid option -- '${flag}'`);
        }
    }
    const translating = !del && sets.length >= 2;
    if (sets.length === 0)
        return usage('missing operand');
    if (del && squeeze && sets.length < 2)
        return usage(`missing operand after \u2018${sets[0]}\u2019\nTwo strings must be given when both deleting and squeezing repeats.`);
    if (!del && !squeeze && sets.length < 2)
        return usage(`missing operand after \u2018${sets[0]}\u2019\nTwo strings must be given when translating.`);
    const max = del && !squeeze ? 1 : 2;
    if (sets.length > max) {
        const why = del && !squeeze ? '\nOnly one string may be given when deleting without squeezing repeats.' : '';
        return usage(`extra operand \u2018${sets[max]}\u2019${why}`);
    }
    let set1;
    let set2 = [];
    let set2Items = [];
    try {
        set1 = expand(parseSet(sets[0], false), 0);
        if (complement) {
            const inSet = new Set(set1);
            set1 = [];
            for (let b = 0; b < 256; b++)
                if (!inSet.has(b))
                    set1.push(b);
        }
        if (sets.length > 1) {
            set2Items = parseSet(sets[1], true);
            const fixed = expand(set2Items.filter((it) => it.kind !== 'repeat' || it.n !== null), 0).length;
            set2 = expand(set2Items, Math.max(0, set1.length - fixed));
        }
        if (translating) {
            if (set2.length === 0 && set1.length > 0 && !truncate)
                throw new TrError('when not truncating set1, string2 must be non-empty');
            if (set2Items.some((it) => it.kind === 'class' && it.name !== 'upper' && it.name !== 'lower')) {
                throw new TrError('when translating, the only character classes that may appear in\nstring2 are \u2018upper\u2019 and \u2018lower\u2019');
            }
        }
    }
    catch (error) {
        if (error instanceof TrError) {
            await ctx.stderr.write(`tr: ${error.message}\n`);
            return 1;
        }
        throw error;
    }
    const map = new Int16Array(256).map((_, b) => b);
    const deleted = new Uint8Array(256);
    const squeezed = new Uint8Array(256);
    if (del)
        for (const b of set1)
            deleted[b] = 1;
    if (translating) {
        const pairs1 = truncate ? set1.slice(0, set2.length) : set1;
        const last = set2[set2.length - 1];
        pairs1.forEach((b, i) => { map[b] = set2[i] ?? last; });
    }
    const squeezeSet = del ? set2 : translating ? set2 : set1;
    if (squeeze)
        for (const b of squeezeSet)
            squeezed[b] = 1;
    let previous = -1;
    for await (const chunk of inputChunks(ctx, '-')) {
        const out = new Uint8Array(chunk.length);
        let w = 0;
        for (const raw of chunk) {
            if (deleted[raw])
                continue;
            const b = map[raw];
            if (squeeze && squeezed[b] && b === previous)
                continue;
            out[w++] = b;
            previous = b;
        }
        await writeBytes(ctx.stdout, out.subarray(0, w));
    }
    return 0;
};
export default command;
