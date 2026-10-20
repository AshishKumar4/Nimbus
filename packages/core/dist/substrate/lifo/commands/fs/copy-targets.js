import { operandPath, basename } from '../../utils/path.js';
import { isVfsError, VFS_STRERROR } from '../../../../vfs/vfs-error.js';
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
    const dest = operandPath(ctx.cwd, rawDest);
    let stat;
    try {
        stat = await ctx.vfs.stat(dest);
    }
    catch (error) {
        // A destination it cannot stat (one below a regular file: ENOTDIR), said as GNU's cp and mv say it.
        if (!isVfsError(error))
            throw error;
        return `cannot stat '${rawDest}': ${VFS_STRERROR[error.code]}`;
    }
    const destIsDir = stat?.type === 'directory';
    if ((sources.length > 1 || targetDirectory) && !destIsDir) {
        return `target ${targetDirectory ? 'directory ' : ''}'${rawDest}': ${VFS_STRERROR[stat === null ? 'ENOENT' : 'ENOTDIR']}`;
    }
    return { sources, rawDest, destIsDir, targetFor: (src) => (destIsDir ? operandPath(dest, basename(src)) : dest) };
}
