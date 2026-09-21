import type { Command } from '../types.js';
import { basename as pathBasename } from '../../utils/path.js';

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    await ctx.stderr.write('basename: missing operand\n');
    return 1;
  }

  const name = ctx.args[0];
  const suffix = ctx.args[1];
  await ctx.stdout.write(pathBasename(name, suffix) + '\n');
  return 0;
};

export default command;
