import { parseChownOwnership } from '../../../../shell/unix-accounts.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
const spec = {
    recursive: { type: 'boolean', short: 'R' },
};
const command = async (ctx) => {
    const parsed = parseArgs('chown', ctx.args, spec);
    if (!parsed.ok) {
        ctx.stderr.write(parsed.error);
        return 1;
    }
    const { flags, positional } = parsed;
    if (positional.length < 2) {
        ctx.stderr.write('chown: missing operand\n');
        return 1;
    }
    const vfs = ctx.vfs;
    let requested;
    try {
        requested = parseChownOwnership(vfs, positional[0]);
    }
    catch (error) {
        ctx.stderr.write(`chown: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    const apply = (path) => {
        if (flags.recursive && vfs.stat(path).type === 'directory') {
            for (const child of vfs.readdir(path))
                apply(resolve(path, child.name));
        }
        vfs.chown(path, requested.uid, requested.gid);
    };
    let exitCode = 0;
    for (const file of positional.slice(1)) {
        try {
            apply(resolve(ctx.cwd, file));
        }
        catch (error) {
            ctx.stderr.write(`chown: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
};
export default command;
