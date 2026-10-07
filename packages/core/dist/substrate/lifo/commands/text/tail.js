import { getopt } from '../../utils/args.js';
import { asciiBytes, readAllInput, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { parseSuffixedCount } from '../../utils/size-units.js';
class TailUsage extends Error {
}
/** A count as GNU tail reads one: `+N` counts from the start, `-N` (or N) back from the end, with head's suffixes. */
function parseCount(value, unit) {
    const count = parseSuffixedCount(value.startsWith('-') ? value.slice(1) : value, 'bkKmMGTPEZYRQ0');
    if (count === null)
        throw new TailUsage(`invalid number of ${unit}: \u2018${value}\u2019`);
    return { unit, count: Math.min(count, Number.MAX_SAFE_INTEGER), fromStart: value.startsWith('+') };
}
const TAIL_OPTIONS = {
    short: 'n:c:qvzfF',
    long: {
        lines: ['n', 'required'], bytes: ['c', 'required'], quiet: ['q', 'none'], silent: ['q', 'none'],
        verbose: ['v', 'none'], 'zero-terminated': ['z', 'none'], follow: ['f', 'optional'],
    },
};
const command = async (ctx) => {
    let mode = { unit: 'lines', count: 10, fromStart: false };
    let headers = null;
    let delim = 0x0a;
    const files = [];
    const usage = async (message) => {
        await ctx.stderr.write(`tail: ${message}\nTry 'tail --help' for more information.\n`);
        return 1;
    };
    try {
        // The obsolete -N, as the first word: the last N lines.
        const args = /^-\d+$/.test(ctx.args[0] ?? '') ? ctx.args.slice(1) : ctx.args;
        if (args !== ctx.args)
            mode = parseCount(ctx.args[0].slice(1), 'lines');
        for (const event of getopt(args, TAIL_OPTIONS)) {
            // A digit is an option only as the obsolete -N, first; elsewhere GNU names its first digit.
            if (event.kind === 'error')
                return usage(event.message.replace(/^invalid option -- '(\d)'$/, 'option used in invalid context -- $1'));
            if (event.kind === 'operand')
                files.push(event.value);
            else if (event.key === 'n' || event.key === 'c')
                mode = parseCount(event.value, event.key === 'n' ? 'lines' : 'bytes');
            else if (event.key === 'q')
                headers = false;
            else if (event.key === 'v')
                headers = true;
            else if (event.key === 'z')
                delim = 0;
            // -f/-F: a finished input has nothing to follow.
        }
    }
    catch (error) {
        if (error instanceof TailUsage)
            return usage(error.message);
        throw error;
    }
    if (files.length === 0)
        files.push('-');
    const label = headers ?? files.length > 1;
    let status = 0;
    let first = true;
    for (const file of files) {
        let bytes;
        try {
            bytes = await readAllInput(ctx, file);
        }
        catch (error) {
            await ctx.stderr.write(`tail: cannot open '${file}' for reading: ${strerror(error)}\n`);
            status = 1;
            continue;
        }
        if (label)
            await writeBytes(ctx.stdout, asciiBytes(`${first ? '' : '\n'}==> ${file === '-' ? 'standard input' : file} <==\n`));
        first = false;
        await writeBytes(ctx.stdout, select(bytes, mode, delim));
    }
    return status;
};
/** The part of `bytes` tail prints. */
function select(bytes, mode, delim) {
    if (mode.unit === 'bytes') {
        if (mode.fromStart)
            return bytes.subarray(Math.min(bytes.length, Math.max(0, mode.count - 1)));
        return bytes.subarray(Math.max(0, bytes.length - mode.count));
    }
    if (mode.fromStart) {
        // From line N on: skip N-1 delimiters.
        let at = 0;
        for (let skipped = 0; skipped < mode.count - 1; skipped++) {
            const i = bytes.indexOf(delim, at);
            if (i === -1)
                return bytes.subarray(bytes.length);
            at = i + 1;
        }
        return bytes.subarray(at);
    }
    if (mode.count === 0)
        return bytes.subarray(bytes.length);
    // The last N lines: a final line without its delimiter is a line too.
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === delim)
        end--;
    let start = end;
    for (let found = 0;;) {
        if (start === 0)
            return bytes.subarray(0);
        const i = bytes.lastIndexOf(delim, start - 1);
        if (i === -1)
            return bytes.subarray(0);
        found++;
        if (found === mode.count)
            return bytes.subarray(i + 1);
        start = i;
    }
}
export default command;
