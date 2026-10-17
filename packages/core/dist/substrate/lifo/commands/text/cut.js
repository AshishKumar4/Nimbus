import { concatBytes, inputChunks } from '../../utils/bytes-io.js';
import { enc, nameDec } from '../../../../_shared/bytes.js';
import { getopt } from '../../utils/args.js';
class CutUsage extends Error {
}
/** A list: items split on commas or blanks; N, N-M, N-, -M. Sorted, overlaps merged. */
function parseList(text, mode) {
    const what = mode === 'fields' ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
    const ranges = [];
    for (const item of text.split(/[,\s]/)) {
        if (item === '')
            throw new CutUsage(what);
        if (item === '-')
            throw new CutUsage('invalid range with no endpoint: -');
        const match = /^(\d*)(-?)(\d*)$/.exec(item);
        if (match === null) {
            if (/^[\d-]+$/.test(item))
                throw new CutUsage(mode === 'fields' ? 'invalid field range' : 'invalid byte or character range');
            throw new CutUsage(mode === 'fields' ? `invalid field value \u2018${item}\u2019` : `invalid byte/character position \u2018${item}\u2019`);
        }
        const number = (digits) => {
            const value = Number(digits);
            if (!Number.isSafeInteger(value)) {
                throw new CutUsage(mode === 'fields' ? `field number \u2018${digits}\u2019 is too large` : `byte/character offset \u2018${digits}\u2019 is too large`);
            }
            if (value === 0)
                throw new CutUsage(what);
            return value;
        };
        const lo = match[1] === '' ? 1 : number(match[1]);
        const hi = match[2] === '' ? lo : match[3] === '' ? Infinity : number(match[3]);
        if (hi < lo)
            throw new CutUsage('invalid decreasing range');
        ranges.push({ lo, hi });
    }
    ranges.sort((a, b) => a.lo - b.lo);
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last !== undefined && range.lo <= last.hi)
            last.hi = Math.max(last.hi, range.hi);
        else
            merged.push({ ...range });
    }
    return merged;
}
/** The positions not in `ranges`. */
function complement(ranges) {
    const out = [];
    let next = 1;
    for (const range of ranges) {
        if (range.lo > next)
            out.push({ lo: next, hi: range.lo - 1 });
        next = range.hi + 1;
    }
    if (next !== Infinity)
        out.push({ lo: next, hi: Infinity });
    return out;
}
/** One record (without its terminator) as cut prints it, or null to print nothing. */
function cutRecord(record, o) {
    const parts = [];
    if (o.mode === 'bytes') {
        for (const range of o.ranges) {
            if (range.lo > record.length)
                break;
            if (parts.length > 0 && o.outputDelimiter !== null)
                parts.push(o.outputDelimiter);
            parts.push(record.subarray(range.lo - 1, Math.min(range.hi, record.length)));
        }
        return parts;
    }
    if (!record.includes(o.delimiter))
        return o.onlyDelimited ? null : [record];
    const separator = o.outputDelimiter ?? Uint8Array.of(o.delimiter);
    let field = 1;
    let start = 0;
    let wrote = false;
    let range = 0;
    for (let i = 0; i <= record.length; i++) {
        if (i < record.length && record[i] !== o.delimiter)
            continue;
        while (range < o.ranges.length && o.ranges[range].hi < field)
            range++;
        if (range === o.ranges.length)
            break;
        if (o.ranges[range].lo <= field) {
            if (wrote)
                parts.push(separator);
            parts.push(record.subarray(start, i));
            wrote = true;
        }
        field++;
        start = i + 1;
    }
    return parts;
}
/** GNU cut's options, its long ones in its table's order. */
const CUT_OPTIONS = {
    short: 'b:c:d:f:nsz',
    long: {
        bytes: ['b', 'required'], characters: ['c', 'required'], delimiter: ['d', 'required'], fields: ['f', 'required'],
        'only-delimited': ['s', 'none'], 'output-delimiter': ['output-delimiter', 'required'], complement: ['complement', 'none'],
        'zero-terminated': ['z', 'none'],
    },
};
const command = async (ctx) => {
    let mode = null;
    let list = '';
    let delimiterText = null;
    let outputDelimiter = null;
    let onlyDelimited = false;
    let complemented = false;
    let terminator = 0x0a;
    const files = [];
    const usage = async (message) => {
        await ctx.stderr.write(`cut: ${message}\nTry 'cut --help' for more information.\n`);
        return 1;
    };
    const setList = (next, value) => {
        if (mode !== null)
            return 'only one list may be specified';
        mode = next;
        list = value;
        return undefined;
    };
    for (const event of getopt(ctx.args, CUT_OPTIONS)) {
        if (event.kind === 'error')
            return usage(event.message);
        if (event.kind === 'operand') {
            files.push(event.value);
            continue;
        }
        const value = event.value ?? '';
        let error;
        switch (event.key) {
            case 'b':
            case 'c':
                error = setList('bytes', value);
                break;
            case 'f':
                error = setList('fields', value);
                break;
            case 'd':
                delimiterText = value;
                break;
            case 'output-delimiter':
                outputDelimiter = enc.encode(value);
                break;
            case 's':
                onlyDelimited = true;
                break;
            case 'complement':
                complemented = true;
                break;
            case 'z':
                terminator = 0;
                break;
            // -n: no split multibyte characters, which bytes are here.
        }
        if (error !== undefined)
            return usage(error);
    }
    if (mode === null)
        return usage('you must specify a list of bytes, characters, or fields');
    if (delimiterText !== null && mode !== 'fields')
        return usage('an input delimiter may be specified only when operating on fields');
    if (onlyDelimited && mode !== 'fields')
        return usage('suppressing non-delimited lines makes sense\n\tonly when operating on fields');
    let delimiter = 0x09;
    if (delimiterText !== null) {
        const bytes = enc.encode(delimiterText);
        if (bytes.length > 1)
            return usage('the delimiter must be a single character');
        delimiter = bytes.length === 0 ? 0 : bytes[0];
    }
    let ranges;
    try {
        ranges = parseList(list, mode);
    }
    catch (error) {
        if (error instanceof CutUsage)
            return usage(error.message);
        throw error;
    }
    const options = {
        mode, ranges: complemented ? complement(ranges) : ranges, delimiter, outputDelimiter, onlyDelimited, terminator,
    };
    const end = Uint8Array.of(terminator);
    const write = async (parts) => {
        const out = concatBytes(parts);
        if (ctx.stdout.writeBytes)
            await ctx.stdout.writeBytes(out);
        else
            await ctx.stdout.write(nameDec.decode(out));
    };
    let status = 0;
    for (const file of files.length > 0 ? files : [undefined]) {
        let carry = new Uint8Array(0);
        try {
            // Streamed, a character device too: a pipe's reader can stop it (`cut -z -b1 /dev/zero | head`).
            for await (const chunk of inputChunks(ctx, file, { slice: true })) {
                const data = carry.length === 0 ? chunk : new Uint8Array(carry.length + chunk.length);
                if (carry.length > 0) {
                    data.set(carry);
                    data.set(chunk, carry.length);
                }
                const out = [];
                let start = 0;
                for (let i = data.indexOf(terminator); i !== -1; i = data.indexOf(terminator, start)) {
                    const parts = cutRecord(data.subarray(start, i), options);
                    if (parts !== null)
                        out.push(...parts, end);
                    start = i + 1;
                }
                carry = data.slice(start);
                if (out.length > 0)
                    await write(out);
            }
            // A last record without its terminator gets one, as GNU prints it.
            if (carry.length > 0) {
                const parts = cutRecord(carry, options);
                if (parts !== null)
                    await write([...parts, end]);
            }
        }
        catch (error) {
            const code = error.code;
            if (code === undefined || code === 'EPIPE')
                throw error;
            const reason = code === 'ENOENT' ? 'No such file or directory' : code === 'EACCES' ? 'Permission denied' : code === 'EISDIR' ? 'Is a directory' : error.message;
            await ctx.stderr.write(`cut: ${file}: ${reason}\n`);
            status = 1;
        }
    }
    return status;
};
export default command;
