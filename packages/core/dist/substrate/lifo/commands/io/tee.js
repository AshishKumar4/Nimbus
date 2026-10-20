import { operandPath } from '../../utils/path.js';
import { inputChunks, writeBytes } from '../../utils/bytes-io.js';
import { withOpenFiles } from '../../../../runtime/process-files.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { getopt } from '../../utils/args.js';
// GNU tee (coreutils 9.7) on bytes, streaming: standard input to standard
// output and every FILE as it arrives. -a appends; a FILE that cannot be
// opened is reported and the rest still get the input (status 1); -i, -p and
// --output-error are accepted (there are no signals or broken pipes to treat
// differently here).
/** GNU tee's options, its long ones in its table's order. */
const TEE_OPTIONS = {
    short: 'aip',
    long: { append: ['a', 'none'], 'ignore-interrupts': ['i', 'none'], 'output-error': ['output-error', 'optional'] },
};
const command = async (ctx) => {
    let append = false;
    const files = [];
    const usage = async (message) => {
        await ctx.stderr.write(`tee: ${message}\nTry 'tee --help' for more information.\n`);
        return 1;
    };
    for (const event of getopt(ctx.args, TEE_OPTIONS)) {
        if (event.kind === 'error')
            return usage(event.message);
        if (event.kind === 'operand')
            files.push(event.value);
        else if (event.key === 'a')
            append = true;
    }
    let status = 0;
    const report = async (file, error) => {
        status = 1;
        await ctx.stderr.write(`tee: ${file}: ${strerror(error)}\n`);
    };
    // Each FILE operand is an open description of its own, as GNU's tee opens
    // one per occurrence (so `tee f f` writes the input once without -a): the
    // input goes to the file the open found, whatever the name names after.
    // Every one is synced and closed however tee ends.
    const operand = new Map();
    await withOpenFiles(ctx.vfs, async (open) => {
        const outputs = [];
        for (const file of files) {
            if (file === '-') {
                outputs.push({ file, open: null });
                continue;
            }
            try {
                const opened = await open(operandPath(ctx.cwd, file), { write: true, create: true, append, truncate: !append });
                operand.set(opened, file);
                outputs.push({ file, open: opened });
            }
            catch (error) {
                await report(file, error);
            }
        }
        for await (const chunk of inputChunks(ctx, '-')) {
            await writeBytes(ctx.stdout, chunk);
            for (const out of [...outputs]) {
                try {
                    if (out.open === null)
                        await writeBytes(ctx.stdout, chunk);
                    else
                        await out.open.write(chunk);
                }
                catch (error) {
                    // A FILE that cannot be written is reported once and written no more, as GNU's tee does.
                    outputs.splice(outputs.indexOf(out), 1);
                    // Its failure is told; what its close would answer adds nothing.
                    if (out.open !== null)
                        await out.open.close().catch(() => undefined);
                    await report(out.file, error);
                }
            }
        }
    }, async (file, error) => report(operand.get(file) ?? file.path, error));
    return status;
};
export default command;
