import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'r' },
  Recursive: { type: 'boolean' as const, short: 'R' },
  force: { type: 'boolean' as const, short: 'f' },
};

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  const recursive = (flags.recursive || flags.Recursive) as boolean;
  const force = flags.force as boolean;

  if (positional.length === 0) {
    if (force) return 0;
    await ctx.stderr.write('rm: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const arg of positional) {
    const path = resolve(ctx.cwd, arg);
    try {
      await ctx.vfs.remove(path, { recursive, force });
    } catch (error) {
      await ctx.stderr.write(`rm: ${arg}: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    }
  }

  return exitCode;
};

export default command;
