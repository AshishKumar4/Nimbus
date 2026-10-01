import { resolve } from '../../utils/path.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
import { adjustMode, compileMode } from '../../utils/mode-change.js';
const command = async (ctx) => {
    let recursive = false;
    let modeStr = '';
    const files = [];
    for (const arg of ctx.args) {
        if (!modeStr && (arg === '-R' || arg === '-r' || arg === '--recursive')) {
            recursive = true;
        }
        else if (!modeStr) {
            modeStr = arg;
        }
        else {
            files.push(arg);
        }
    }
    if (!modeStr || files.length === 0) {
        await ctx.stderr.write('chmod: missing operand\n');
        return 1;
    }
    const spec = compileMode(modeStr);
    if (!spec) {
        await ctx.stderr.write(`chmod: invalid mode: '${modeStr}'\n`);
        return 1;
    }
    let exitCode = 0;
    const applyChmod = async (filePath) => {
        const st = (await statOrThrow(ctx.vfs, filePath));
        // No umask: a clause without a who applies to everyone.
        (await ctx.vfs.chmod(filePath, adjustMode(st.mode, st.type === 'directory', 0, spec)));
        if (recursive && st.type === 'directory') {
            for (const entry of (await ctx.vfs.readdir(filePath))) {
                (await applyChmod(filePath === '/' ? '/' + entry.name : filePath + '/' + entry.name));
            }
        }
    };
    for (const file of files) {
        try {
            (await applyChmod(resolve(ctx.cwd, file)));
        }
        catch (e) {
            const message = isVfsError(e) || e instanceof Error ? e.message : String(e);
            await ctx.stderr.write(`chmod: cannot access '${file}': ${message}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
};
export default command;
