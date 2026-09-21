import { parseChownOwnership } from '../../../../shell/unix-accounts.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
const spec = {
    recursive: { type: 'boolean', short: 'R' },
};
const command = async (ctx) => {
    const { flags, positional } = parseArgs(ctx.args, spec);
    if (positional.length < 2) {
        await ctx.stderr.write('chown: missing operand\n');
        return 1;
    }
    const vfs = ctx.vfs;
    let requested;
    try {
        requested = (await parseChownOwnership(vfs, positional[0]));
    }
    catch (error) {
        await ctx.stderr.write(`chown: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    const apply = async (path) => {
        if (flags.recursive && (await vfs.stat(path)).type === 'directory') {
            for (const child of (await vfs.readdir(path)))
                (await apply(resolve(path, child.name)));
        }
        (await vfs.chown(path, requested.uid, requested.gid));
    };
    let exitCode = 0;
    for (const file of positional.slice(1)) {
        try {
            (await apply(resolve(ctx.cwd, file)));
        }
        catch (error) {
            await ctx.stderr.write(`chown: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
};
export default command;
