import { concatBytes, readAllInput, utf8SequenceLength, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
// util-linux rev (2.41) in a UTF-8 locale: each line's characters reversed,
// its newline kept (a last line without one gets none). A NUL is a
// character. A byte sequence that is not valid UTF-8 stops it, as it stops
// util-linux: the lines before it are printed, the error follows, status 1.
const command = async (ctx) => {
    const files = [];
    for (const arg of ctx.args) {
        if (arg.startsWith('-') && arg !== '-' && arg !== '--') {
            await ctx.stderr.write(`rev: invalid option -- '${arg.slice(1, 2)}'\nTry 'rev --help' for more information.\n`);
            return 1;
        }
        if (arg !== '--')
            files.push(arg);
    }
    let status = 0;
    for (const file of files.length > 0 ? files : ['-']) {
        let bytes;
        try {
            bytes = await readAllInput(ctx, file);
        }
        catch (error) {
            await ctx.stderr.write(`rev: cannot open ${file}: ${strerror(error)}\n`);
            status = 1;
            continue;
        }
        const out = [];
        let at = 0;
        let failed = false;
        while (at < bytes.length) {
            const nl = bytes.indexOf(0x0a, at);
            const end = nl === -1 ? bytes.length : nl;
            // The line's characters, as byte ranges.
            const chars = [];
            for (let i = at; i < end;) {
                const len = utf8SequenceLength(bytes, i);
                if (len === 0 || i + len > end) {
                    failed = true;
                    break;
                }
                chars.push([i, i + len]);
                i += len;
            }
            if (failed)
                break;
            const line = new Uint8Array(end - at + (nl === -1 ? 0 : 1));
            let w = 0;
            for (let k = chars.length - 1; k >= 0; k--) {
                const [s, e] = chars[k];
                line.set(bytes.subarray(s, e), w);
                w += e - s;
            }
            if (nl !== -1)
                line[w] = 0x0a;
            out.push(line);
            at = end + 1;
        }
        await writeBytes(ctx.stdout, concatBytes(out));
        if (failed) {
            await ctx.stderr.write('rev: fgetwc() failed: Invalid or incomplete multibyte or wide character\n');
            return 1;
        }
    }
    return status;
};
export default command;
