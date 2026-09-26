import { resolve } from '../../utils/path.js';
import { asciiBytes, concatBytes, fsErrorText, inputChunks, writeBytes } from '../../utils/bytes-io.js';
const isBlank = (b) => b === 0x20 || b === 0x09;
const upper = (b) => (b >= 0x61 && b <= 0x7a ? b - 32 : b);
const command = async (ctx) => {
    let count = false, repeated = false, unique = false, fold = false, zero = false;
    let allRepeated = null;
    let group = null;
    let skipFields = 0, skipChars = 0, checkChars = Infinity;
    const operands = [];
    const usage = async (message) => {
        await ctx.stderr.write(`uniq: ${message}\nTry 'uniq --help' for more information.\n`);
        return 1;
    };
    const number = (flag, value) => {
        if (value === undefined || !/^\d+$/.test(value)) {
            const what = flag === 'f' ? 'fields to skip' : flag === 's' ? 'bytes to skip' : 'bytes to compare';
            return `${value ?? ''}: invalid number of ${what}`;
        }
        return Number(value);
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            operands.push(...args.slice(i + 1));
            break;
        }
        if (arg.startsWith('--')) {
            const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
            const needs = ['skip-fields', 'skip-chars', 'check-chars'].includes(name);
            const value = needs ? inline ?? args[++i] : inline;
            if (name === 'count')
                count = true;
            else if (name === 'repeated')
                repeated = true;
            else if (name === 'unique')
                unique = true;
            else if (name === 'ignore-case')
                fold = true;
            else if (name === 'zero-terminated')
                zero = true;
            else if (name === 'all-repeated') {
                const method = (value ?? 'none');
                if (!['none', 'prepend', 'separate'].includes(method))
                    return usage(`invalid argument \u2018${value}\u2019 for \u2018--all-repeated\u2019`);
                allRepeated = method;
            }
            else if (name === 'group') {
                const method = (value ?? 'separate');
                if (!['separate', 'prepend', 'append', 'both'].includes(method))
                    return usage(`invalid argument \u2018${value}\u2019 for \u2018--group\u2019`);
                group = method;
            }
            else if (needs) {
                const n = number(name === 'skip-fields' ? 'f' : name === 'skip-chars' ? 's' : 'w', value);
                if (typeof n === 'string')
                    return usage(n);
                if (name === 'skip-fields')
                    skipFields = n;
                else if (name === 'skip-chars')
                    skipChars = n;
                else
                    checkChars = n;
            }
            else
                return usage(`unrecognized option '--${name}'`);
            continue;
        }
        if (!arg.startsWith('-') || arg === '-') {
            operands.push(arg);
            continue;
        }
        for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            if (flag === 'f' || flag === 's' || flag === 'w') {
                let value = arg.slice(j + 1);
                if (value === '')
                    value = args[++i];
                const n = number(flag, value);
                if (typeof n === 'string')
                    return usage(n);
                if (flag === 'f')
                    skipFields = n;
                else if (flag === 's')
                    skipChars = n;
                else
                    checkChars = n;
                break;
            }
            if (flag === 'c')
                count = true;
            else if (flag === 'd')
                repeated = true;
            else if (flag === 'D')
                allRepeated = 'none';
            else if (flag === 'u')
                unique = true;
            else if (flag === 'i')
                fold = true;
            else if (flag === 'z')
                zero = true;
            else
                return usage(`invalid option -- '${flag}'`);
        }
    }
    if (operands.length > 2)
        return usage(`extra operand \u2018${operands[2]}\u2019`);
    if (count && allRepeated !== null)
        return usage('printing all duplicated lines and repeat counts is meaningless');
    if (group !== null && (count || repeated || unique || allRepeated !== null)) {
        return usage('--group is mutually exclusive with -c/-d/-D/-u');
    }
    const delim = zero ? 0 : 0x0a;
    let input;
    try {
        const parts = [];
        for await (const chunk of inputChunks(ctx, operands[0]))
            parts.push(chunk);
        input = concatBytes(parts);
    }
    catch (error) {
        await ctx.stderr.write(`uniq: ${operands[0]}: ${fsErrorText(error)}\n`);
        return 1;
    }
    const lines = [];
    let start = 0;
    for (let i = input.indexOf(delim); i !== -1; i = input.indexOf(delim, start)) {
        lines.push(input.subarray(start, i));
        start = i + 1;
    }
    if (start < input.length)
        lines.push(input.subarray(start));
    const keyOf = (line) => {
        let at = 0;
        for (let f = 0; f < skipFields && at < line.length; f++) {
            while (at < line.length && isBlank(line[at]))
                at++;
            while (at < line.length && !isBlank(line[at]))
                at++;
        }
        at = Math.min(line.length, at + skipChars);
        return line.subarray(at, checkChars === Infinity ? line.length : Math.min(line.length, at + checkChars));
    };
    const same = (a, b) => {
        const ka = keyOf(a), kb = keyOf(b);
        if (ka.length !== kb.length)
            return false;
        for (let i = 0; i < ka.length; i++) {
            if (ka[i] !== kb[i] && !(fold && upper(ka[i]) === upper(kb[i])))
                return false;
        }
        return true;
    };
    const out = [];
    const end = Uint8Array.of(delim);
    const emit = (line, n) => {
        if (n !== undefined)
            out.push(asciiBytes(`${String(n).padStart(7)} `));
        out.push(line, end);
    };
    // Groups of adjacent equal lines.
    const groups = [];
    for (const line of lines) {
        const last = groups[groups.length - 1];
        if (last && same(last[0], line))
            last.push(line);
        else
            groups.push([line]);
    }
    if (group !== null) {
        groups.forEach((g, index) => {
            if ((group === 'prepend' || group === 'both') || (index > 0 && group !== 'append'))
                out.push(end);
            for (const line of g)
                out.push(line, end);
            if (group === 'append' || (group === 'both' && index === groups.length - 1))
                out.push(end);
        });
    }
    else if (allRepeated !== null) {
        let printed = 0;
        for (const g of groups) {
            if (g.length < 2)
                continue;
            if (allRepeated === 'prepend' || (allRepeated === 'separate' && printed > 0))
                out.push(end);
            for (const line of g)
                out.push(line, end);
            printed++;
        }
    }
    else {
        for (const g of groups) {
            if (repeated && g.length < 2)
                continue;
            if (unique && g.length > 1)
                continue;
            emit(g[0], count ? g.length : undefined);
        }
    }
    const bytes = concatBytes(out);
    if (operands[1] !== undefined && operands[1] !== '-') {
        try {
            await ctx.vfs.writeFile(resolve(ctx.cwd, operands[1]), bytes);
        }
        catch (error) {
            await ctx.stderr.write(`uniq: ${operands[1]}: ${fsErrorText(error)}\n`);
            return 1;
        }
        return 0;
    }
    await writeBytes(ctx.stdout, bytes);
    return 0;
};
export default command;
