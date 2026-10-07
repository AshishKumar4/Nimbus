import { resolve, basename } from '../../utils/path.js';
import { VFS_STRERROR } from '../../../../vfs/vfs-error.js';
/**
 * cp's and mv's operands, as GNU's read them: `-t DIR SOURCE...` or
 * `SOURCE... DEST`. -t, or more than one source, needs a directory, and
 * the refusal is GNU's ("target directory 'DIR': Not a directory", "target
 * 'DEST': No such file or directory"). A string is the message to print
 * after `NAME: `; null, a missing operand.
 */
export async function resolveCopyTargets(ctx, positional, targetDirectory) {
    const sources = targetDirectory ? positional : positional.slice(0, -1);
    const rawDest = targetDirectory ?? positional[positional.length - 1];
    if (sources.length === 0 || rawDest === undefined)
        return null;
    const dest = resolve(ctx.cwd, rawDest);
    const stat = await ctx.vfs.stat(dest);
    const destIsDir = stat?.type === 'directory';
    if ((sources.length > 1 || targetDirectory) && !destIsDir) {
        return `target ${targetDirectory ? 'directory ' : ''}'${rawDest}': ${VFS_STRERROR[stat === null ? 'ENOENT' : 'ENOTDIR']}`;
    }
    return { sources, rawDest, destIsDir, targetFor: (src) => (destIsDir ? resolve(dest, basename(src)) : dest) };
}
