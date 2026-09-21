import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
const command = async (ctx) => {
    if (ctx.args.length === 0) {
        await ctx.stderr.write('stat: missing operand\n');
        return 1;
    }
    let exitCode = 0;
    for (const arg of ctx.args) {
        const path = resolve(ctx.cwd, arg);
        try {
            const st = (await ctx.vfs.stat(path));
            // Stored modes may carry POSIX S_IF* filetype bits; display the
            // permission bits like stat(1) does.
            const mode = '0' + (st.mode & 0o7777).toString(8);
            const type = st.type === 'directory' ? 'directory' : 'regular file';
            await ctx.stdout.write(`  File: ${arg}\n`);
            await ctx.stdout.write(`  Size: ${st.size}\tType: ${type}\n`);
            await ctx.stdout.write(`  Mode: ${mode}\n`);
            await ctx.stdout.write(`  Created: ${new Date(st.ctime).toISOString()}\n`);
            await ctx.stdout.write(`  Modified: ${new Date(st.mtime).toISOString()}\n`);
        }
        catch (e) {
            if (e instanceof VFSError) {
                await ctx.stderr.write(`stat: ${arg}: ${e.message}\n`);
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
