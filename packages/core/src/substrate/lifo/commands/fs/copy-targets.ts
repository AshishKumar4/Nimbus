import type { CommandContext } from '../types.js';
import { resolve, basename } from '../../utils/path.js';
import { VFS_STRERROR } from '../../../../vfs/vfs-error.js';

/** Where cp's or mv's sources go: each source's target, from one look at the destination. */
export interface CopyTargets {
  readonly sources: readonly string[];
  /** The destination as the user named it, for messages. */
  readonly rawDest: string;
  readonly destIsDir: boolean;
  /** Where `src` (an absolute path) lands: inside the destination directory, else the destination. */
  targetFor(src: string): string;
}

/**
 * cp's and mv's operands, as GNU's read them: `-t DIR SOURCE...` or
 * `SOURCE... DEST`. -t, or more than one source, needs a directory, and
 * the refusal is GNU's ("target directory 'DIR': Not a directory", "target
 * 'DEST': No such file or directory"). A string is the message to print
 * after `NAME: `; null, a missing operand.
 */
export async function resolveCopyTargets(
  ctx: CommandContext,
  positional: readonly string[],
  targetDirectory: string | null,
): Promise<CopyTargets | string | null> {
  const sources = targetDirectory ? positional : positional.slice(0, -1);
  const rawDest = targetDirectory ?? positional[positional.length - 1];
  if (sources.length === 0 || rawDest === undefined) return null;
  const dest = resolve(ctx.cwd, rawDest);
  const stat = await ctx.vfs.stat(dest);
  const destIsDir = stat?.type === 'directory';
  if ((sources.length > 1 || targetDirectory) && !destIsDir) {
    return `target ${targetDirectory ? 'directory ' : ''}'${rawDest}': ${VFS_STRERROR[stat === null ? 'ENOENT' : 'ENOTDIR']}`;
  }
  return { sources, rawDest, destIsDir, targetFor: (src) => (destIsDir ? resolve(dest, basename(src)) : dest) };
}
