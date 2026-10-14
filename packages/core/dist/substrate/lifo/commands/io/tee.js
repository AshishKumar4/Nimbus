import { resolve } from '../../utils/path.js';
import { inputChunks, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
// GNU tee (coreutils 9.7) on bytes, streaming: standard input to standard
// output and every FILE as it arrives. -a appends; a FILE that cannot be
// opened is reported and the rest still get the input (status 1); -i, -p and
// --output-error are accepted (there are no signals or broken pipes to treat
// differently here).
const command = async (ctx) => {
    let append = false;
    const files = [];
    const usage = async (message) => {
        await ctx.stderr.write(`tee: ${message}\nTry 'tee --help' for more information.\n`);
        return 1;
    };
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '--') {
            files.push(...ctx.args.slice(i + 1));
            break;
        }
        if (arg.startsWith('--')) {
            const name = arg.slice(2).split('=', 1)[0];
            if (name === 'append')
                append = true;
            else if (name !== 'ignore-interrupts' && name !== 'output-error')
                return usage(`unrecognized option '${arg}'`);
            continue;
        }
        if (!arg.startsWith('-') || arg === '-') {
            files.push(arg);
            continue;
        }
        for (const flag of arg.slice(1)) {
            if (flag === 'a')
                append = true;
            else if (flag !== 'i' && flag !== 'p')
                return usage(`invalid option -- '${flag}'`);
        }
    }
    let status = 0;
    // Each FILE operand is an open description of its own, as GNU's tee opens
    // one per occurrence (so `tee f f` writes the input once without -a): the
    // input goes to the file the open found, whatever the name names after.
    const outputs = [];
    for (const file of files) {
        if (file === '-') {
            outputs.push({ file, open: null });
            continue;
        }
        try {
            outputs.push({ file, open: await ctx.vfs.open(resolve(ctx.cwd, file), { write: true, create: true, append, truncate: !append }) });
        }
        catch (error) {
            await ctx.stderr.write(`tee: ${file}: ${strerror(error)}\n`);
            status = 1;
        }
    }
    try {
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
                    await ctx.stderr.write(`tee: ${out.file}: ${strerror(error)}\n`);
                    status = 1;
                    outputs.splice(outputs.indexOf(out), 1);
                    // Its failure is told; what its close would answer adds nothing.
                    if (out.open !== null)
                        await out.open.close().catch(() => undefined);
                }
            }
        }
    }
    finally {
        for (const out of outputs) {
            if (out.open === null)
                continue;
            try {
                await out.open.sync();
                await out.open.close();
            }
            catch (error) {
                await ctx.stderr.write(`tee: ${out.file}: ${strerror(error)}\n`);
                status = 1;
            }
        }
    }
    return status;
};
export default command;
