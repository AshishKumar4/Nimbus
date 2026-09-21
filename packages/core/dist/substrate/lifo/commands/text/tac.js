import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
const command = async (ctx) => {
    let exitCode = 0;
    const processContent = async (content) => {
        const lines = content.replace(/\n$/, '').split('\n');
        lines.reverse();
        await ctx.stdout.write(lines.join('\n') + '\n');
    };
    if (ctx.args.length === 0) {
        await ctx.stderr.write('Usage: tac FILE...\n');
        await ctx.stderr.write('Print files in reverse line order.\n');
        return 1;
    }
    for (const arg of ctx.args) {
        const path = resolve(ctx.cwd, arg);
        try {
            await processContent(await ctx.vfs.readFileString(path));
        }
        catch (e) {
            if (e instanceof VFSError) {
                await ctx.stderr.write(`tac: ${arg}: ${e.message}\n`);
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
