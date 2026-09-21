import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
const spec = {
    recursive: { type: 'boolean', short: 'r' },
    Recursive: { type: 'boolean', short: 'R' },
    force: { type: 'boolean', short: 'f' },
};
const command = async (ctx) => {
    const { flags, positional } = parseArgs(ctx.args, spec);
    const recursive = (flags.recursive || flags.Recursive);
    const force = flags.force;
    if (positional.length === 0) {
        if (force)
            return 0;
        await ctx.stderr.write('rm: missing operand\n');
        return 1;
    }
    let exitCode = 0;
    for (const arg of positional) {
        const path = resolve(ctx.cwd, arg);
        try {
            await ctx.vfs.remove(path, { recursive, force });
        }
        catch (error) {
            await ctx.stderr.write(`rm: ${arg}: ${error instanceof Error ? error.message : String(error)}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
};
export default command;
