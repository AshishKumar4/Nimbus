import type { Command } from '../types.js';

/**
 * dirname NAME..., as GNU's: each name loses its last component and the
 * slashes around it, without normalizing (`a/b/..` is `a/b`); a name with
 * no slash is `.`, one of slashes alone `/`.
 */
const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    await ctx.stderr.write('dirname: missing operand\n');
    return 1;
  }

  for (const arg of ctx.args) {
    const trimmed = arg.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const dir = slash === -1 ? (trimmed === '' && arg !== '' ? '/' : '.') : trimmed.slice(0, slash).replace(/\/+$/, '') || '/';
    await ctx.stdout.write(`${dir}\n`);
  }
  return 0;
};

export default command;
