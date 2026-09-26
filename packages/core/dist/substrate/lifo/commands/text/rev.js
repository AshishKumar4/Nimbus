import { resolve } from '../../utils/path.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
function reverseLines(text) {
    return text.split('\n').map(line => [...line].reverse().join('')).join('\n');
}
const command = async (ctx) => {
    if (ctx.args.length === 0) {
        if (ctx.stdin) {
            const content = await ctx.stdin.readAll();
            await ctx.stdout.write(reverseLines(content));
            return 0;
        }
        await ctx.stderr.write('rev: missing operand\n');
        return 1;
    }
    let exitCode = 0;
    for (const arg of ctx.args) {
        const path = resolve(ctx.cwd, arg);
        try {
            (await statOrThrow(ctx.vfs, path));
            const content = (await ctx.vfs.readFileString(path));
            await ctx.stdout.write(reverseLines(content));
        }
        catch (e) {
            if (isVfsError(e)) {
                await ctx.stderr.write(`rev: ${arg}: ${e.message}\n`);
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
