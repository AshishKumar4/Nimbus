import { parseArgs } from '../../utils/args.js';
import { resolve, dirname } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
const spec = {
    parents: { type: 'boolean', short: 'p' },
};
const command = async (ctx) => {
    const parsed = parseArgs('rmdir', ctx.args, spec);
    if (!parsed.ok) {
        ctx.stderr.write(parsed.error);
        return 1;
    }
    const { flags, positional } = parsed;
    if (positional.length === 0) {
        ctx.stderr.write('rmdir: missing operand\n');
        return 1;
    }
    let exitCode = 0;
    for (const arg of positional) {
        const path = resolve(ctx.cwd, arg);
        try {
            ctx.vfs.rmdir(path);
            if (flags.parents) {
                // Walk up removing empty parent directories
                let parent = dirname(path);
                while (parent !== '/' && parent !== '.') {
                    try {
                        ctx.vfs.rmdir(parent);
                        parent = dirname(parent);
                    }
                    catch {
                        break;
                    }
                }
            }
        }
        catch (e) {
            if (e instanceof VFSError) {
                ctx.stderr.write(`rmdir: ${arg}: ${e.message}\n`);
                exitCode = 1;
            }
            else {
                throw e;
            }
        }
    }
    return exitCode;
};
export default command;
