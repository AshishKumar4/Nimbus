import type { Command, CommandContext } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { operandPath } from '../../utils/path.js';
import { isVfsError, VFS_STRERROR } from '../../../../vfs/vfs-error.js';

const spec = {
  parents: { type: 'boolean' as const, short: 'p' },
};

/**
 * The part of `arg`, as written, that mkdir -p met as no directory: its
 * prefix through the first component that is there and is not one, as
 * gnulib's mkancesdirs leaves the name it reports. `arg` when none is.
 */
async function notADirectory(ctx: CommandContext, arg: string): Promise<string> {
  const parts = arg.split('/');
  for (let end = 1; end <= parts.length; end++) {
    const prefix = parts.slice(0, end).join('/');
    if (prefix === '' || prefix.endsWith('/')) continue;
    const stat = await ctx.vfs.stat(operandPath(ctx.cwd, prefix)).catch(() => null);
    if (stat === null) return arg;
    if (stat.type !== 'directory') return prefix;
  }
  return arg;
}

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);

  if (positional.length === 0) {
    await ctx.stderr.write('mkdir: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const arg of positional) {
    const path = operandPath(ctx.cwd, arg);
    try {
      (await ctx.vfs.mkdir(path, { recursive: flags.parents === true }));
    } catch (e) {
      if (isVfsError(e)) {
        const named = flags.parents && e.code === 'ENOTDIR' ? await notADirectory(ctx, arg) : arg;
        await ctx.stderr.write(`mkdir: cannot create directory '${named}': ${VFS_STRERROR[e.code]}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
