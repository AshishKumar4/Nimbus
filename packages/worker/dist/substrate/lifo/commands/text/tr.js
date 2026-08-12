import { parseArgs } from '../../utils/args.js';
const spec = {
    delete: { type: 'boolean', short: 'd' },
    squeeze: { type: 'boolean', short: 's' },
    complement: { type: 'boolean', short: 'c' },
    truncate: { type: 'boolean', short: 't' },
};
function expandRange(set) {
    let result = '';
    let i = 0;
    while (i < set.length) {
        if (i + 2 < set.length && set[i + 1] === '-') {
            const start = set.charCodeAt(i);
            const end = set.charCodeAt(i + 2);
            for (let c = start; c <= end; c++) {
                result += String.fromCharCode(c);
            }
            i += 3;
        }
        else {
            result += set[i];
            i++;
        }
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
