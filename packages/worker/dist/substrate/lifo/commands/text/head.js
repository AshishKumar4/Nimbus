import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { encode } from '../../utils/encoding.js';
import { SinkWriter, streamRange } from '../../../../_shared/byte-stream.js';
const command = async (ctx) => {
    let lines = 10;
    let bytes;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-n' || arg === '-c') {
            const count = parseCount(ctx.args[++i]);
            if (count === null) {
                ctx.stderr.write(`head: invalid count\n`);
                return 1;
            }
            if (arg === '-c')
                bytes = count;
            else
                lines = count;
        }
        else if (/^-[nc]\d/.test(arg)) {
            const count = parseCount(arg.slice(2));
            if (count === null) {
                ctx.stderr.write(`head: invalid count\n`);
                return 1;
            }
            if (arg[1] === 'c')
                bytes = count;
            else
                lines = count;
        }
        else if (/^-\d+$/.test(arg)) {
            lines = Number.parseInt(arg.slice(1), 10);
        }
        else {
            files.push(arg);
        }
    }
    if (files.length === 0) {
        if (!ctx.stdin) {
            ctx.stderr.write('head: missing file operand\n');
            return 1;
        }
        if (bytes === undefined) {
            ctx.stdout.write(headLines(await ctx.stdin.readAll(), lines));
            return 0;
        }
        // -c counts bytes, so pull bounded chunks rather than draining the
        // producer and slicing characters off the end.
        const writer = new SinkWriter(ctx.stdout);
        let copied = 0;
        while (copied < bytes) {
            const want = bytes - copied;
            const chunk = ctx.stdin.readBytes ? await ctx.stdin.readBytes(want) : await ctx.stdin.read();
            if (chunk === null)
                break;
            const encoded = encode(chunk).subarray(0, want);
            writer.write(encoded);
            copied += encoded.length;
        }
        writer.end();
        return 0;
    }
    let exitCode = 0;
    const writer = bytes === undefined ? null : new SinkWriter(ctx.stdout);
    for (const file of files) {
        const path = resolve(ctx.cwd, file);
        try {
            if (files.length > 1)
                ctx.stdout.write(`==> ${file} <==\n`);
            if (writer === null) {
                ctx.stdout.write(headLines(ctx.vfs.readFileString(path), lines));
            }
            else {
                // Bounded read: works on regular files and on endless character
                // devices alike, since neither is ever materialised whole.
                streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
                    length: bytes,
                    signal: ctx.signal,
                });
            }
        }
        catch (e) {
            if (e instanceof VFSError) {
                ctx.stderr.write(`head: ${file}: ${e.message}\n`);
                exitCode = 1;
            }
            else {
                throw e;
            }
        }
    }
    writer?.end();
    return exitCode;
};
function headLines(text, count) {
    const all = text.split('\n');
    const selected = all.slice(0, count);
    return selected.join('\n') + (all.length > count ? '\n' : '');
}
function parseCount(value) {
    if (!value)
        return null;
    const match = /^(\d+)([bkKmMgG]?)$/.exec(value);
    if (!match)
        return null;
    const scale = { '': 1, b: 512, k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, g: 1024 ** 3, G: 1024 ** 3 };
    return Number.parseInt(match[1], 10) * scale[match[2]];
}
export default command;
