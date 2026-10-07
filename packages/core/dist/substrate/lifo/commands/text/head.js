import { asciiBytes, concatBytes, inputChunks, isBrokenPipe, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { parseSuffixedCount } from '../../utils/size-units.js';
class HeadUsage extends Error {
}
/**
 * A count as GNU head reads one: a leading `-` (on the value as given) means
 * all but the last N; then blanks and a `+` may lead the digits; a count past
 * what fits is the largest (it reads everything anyway).
 */
function parseCount(value, unit) {
    const allBut = value.startsWith('-');
    const count = parseSuffixedCount(allBut ? value.slice(1) : value, 'bkKmMGTPEZYRQ0');
    if (count === null)
        throw new HeadUsage(`invalid number of ${unit}: \u2018${value}\u2019`);
    return { unit, count: Math.min(count, Number.MAX_SAFE_INTEGER), allBut };
}
const command = async (ctx) => {
    let mode = { unit: 'lines', count: 10, allBut: false };
    let headers = null;
    let delim = 0x0a;
    const files = [];
    const usage = async (message) => {
        await ctx.stderr.write(`head: ${message}\nTry 'head --help' for more information.\n`);
        return 1;
    };
    try {
        const args = ctx.args;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--') {
                files.push(...args.slice(i + 1));
                break;
            }
            if (arg.startsWith('--')) {
                const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
                if (name === 'lines' || name === 'bytes') {
                    const value = inline ?? args[++i];
                    if (value === undefined)
                        return usage(`option '--${name}' requires an argument`);
                    mode = parseCount(value, name);
                }
                else if (name === 'quiet' || name === 'silent')
                    headers = false;
                else if (name === 'verbose')
                    headers = true;
                else if (name === 'zero-terminated')
                    delim = 0;
                else
                    return usage(`unrecognized option '--${name}'`);
                continue;
            }
            if (!arg.startsWith('-') || arg === '-') {
                files.push(arg);
                continue;
            }
            if (i === 0 && /^-\d+[bkm]?[cqvlz]*$/.test(arg)) {
                // The obsolete -N[bkm][c|l][q|v]: N lines, or N bytes with c.
                const m = /^-(\d+)([bkm]?)([cqvlz]*)$/.exec(arg);
                const scale = m[2] === 'b' ? 512 : m[2] === 'k' ? 1024 : m[2] === 'm' ? 1048576 : 1;
                mode = { unit: m[3].includes('c') ? 'bytes' : 'lines', count: Number(m[1]) * scale, allBut: false };
                if (m[3].includes('q'))
                    headers = false;
                if (m[3].includes('v'))
                    headers = true;
                if (m[3].includes('z'))
                    delim = 0;
                continue;
            }
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j];
                if (flag === 'n' || flag === 'c') {
                    let value = arg.slice(j + 1);
                    if (value === '')
                        value = args[++i];
                    if (value === undefined)
                        return usage(`option requires an argument -- '${flag}'`);
                    mode = parseCount(value, flag === 'n' ? 'lines' : 'bytes');
                    break;
                }
                if (flag === 'q')
                    headers = false;
                else if (flag === 'v')
                    headers = true;
                else if (flag === 'z')
                    delim = 0;
                else
                    return usage(`invalid option -- '${flag}'`);
            }
        }
    }
    catch (error) {
        // A bad count is one line, without the Try line an option error gets (GNU).
        if (error instanceof HeadUsage) {
            await ctx.stderr.write(`head: ${error.message}\n`);
            return 1;
        }
        throw error;
    }
    if (files.length === 0)
        files.push('-');
    const label = headers ?? files.length > 1;
    let status = 0;
    let first = true;
    for (const file of files) {
        try {
            // GNU head reads BUFSIZ (8 KiB) at a time: what it leaves unread decides a writer's SIGPIPE.
            // A leading count is a slice head stops on by itself; "all but the last N" needs the end.
            const chunks = inputChunks(ctx, file, { readSize: 8192, slice: !mode.allBut });
            // Open (and fail) before the header, as GNU does. A count of none reads
            // nothing, so standard input is not waited on: a writer that never ends
            // it does not hold `head -n 0`.
            const none = !mode.allBut && mode.count === 0;
            const firstChunk = none && file === '-' ? { done: true } : await chunks.next();
            if (label)
                await writeBytes(ctx.stdout, asciiBytes(`${first ? '' : '\n'}==> ${file === '-' ? 'standard input' : file} <==\n`));
            first = false;
            await copy(firstChunk.done ? null : firstChunk.value, chunks, mode, delim, (bytes) => writeBytes(ctx.stdout, bytes));
        }
        catch (error) {
            if (isBrokenPipe(error))
                throw error;
            await ctx.stderr.write(`head: cannot open '${file}' for reading: ${strerror(error)}\n`);
            status = 1;
        }
    }
    return status;
};
async function copy(first, rest, mode, delim, write) {
    const all = async function* () {
        if (first !== null)
            yield first;
        yield* rest;
    };
    if (!mode.allBut) {
        let left = mode.count;
        if (left === 0)
            return;
        for await (const chunk of all()) {
            if (mode.unit === 'bytes') {
                const take = chunk.subarray(0, left);
                await write(take);
                left -= take.length;
            }
            else {
                let end = chunk.length;
                for (let at = 0; left > 0;) {
                    const i = chunk.indexOf(delim, at);
                    if (i === -1)
                        break;
                    left--;
                    at = i + 1;
                    if (left === 0)
                        end = at;
                }
                await write(chunk.subarray(0, end));
            }
            if (left === 0) {
                await rest.return(undefined);
                return;
            }
        }
        return;
    }
    // All but the last N: everything is read, the tail held back.
    const bytes = concatBytes(await (async () => { const parts = []; for await (const c of all())
        parts.push(c); return parts; })());
    if (mode.unit === 'bytes') {
        await write(bytes.subarray(0, Math.max(0, bytes.length - mode.count)));
        return;
    }
    let end = bytes.length;
    if (mode.count === 0) {
        await write(bytes);
        return;
    }
    // Drop the last N lines (a final line without its delimiter is one).
    let scan = end > 0 && bytes[end - 1] === delim ? end - 1 : end;
    for (let dropped = 0; dropped < mode.count; dropped++) {
        const i = scan === 0 ? -1 : bytes.lastIndexOf(delim, scan - 1);
        if (i === -1) {
            end = 0;
            break;
        }
        end = i + 1;
        scan = i;
    }
    await write(bytes.subarray(0, end));
}
export default command;
