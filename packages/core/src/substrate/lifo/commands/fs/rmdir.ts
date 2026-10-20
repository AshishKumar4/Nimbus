import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { operandPath } from '../../utils/path.js';
import { isVfsError, VFS_STRERROR } from '../../../../vfs/vfs-error.js';

const spec = {
  parents: { type: 'boolean' as const, short: 'p' },
};

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);

  if (positional.length === 0) {
    await ctx.stderr.write('rmdir: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const arg of positional) {
    const path = operandPath(ctx.cwd, arg);
    try {
      (await ctx.vfs.rmdir(path));

      if (flags.parents) {
        // Walk up removing empty parent directories
        const entry = path.replace(/\/+$/, '');
        let parent = entry.slice(0, entry.lastIndexOf('/')) || '/';
        while (parent !== '/' && parent !== '.') {
          try {
            (await ctx.vfs.rmdir(parent));
            parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
          } catch {
            break;
          }
        }
      }
    } catch (e) {
      if (isVfsError(e)) {
        await ctx.stderr.write(`rmdir: failed to remove '${arg}': ${VFS_STRERROR[e.code]}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
