import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { gzipFiles } from './gzip.js';

const spec = {
  keep: { type: 'boolean' as const, short: 'k' },
  force: { type: 'boolean' as const, short: 'f' },
  quiet: { type: 'boolean' as const, short: 'q' },
  help: { type: 'boolean' as const },
};

/** gunzip: gzip -d, which rejects compression levels. */
const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    await ctx.stdout.write('Usage: gunzip [-kfq] file.gz...\n');
    await ctx.stdout.write('  -k, --keep    keep original file\n');
    await ctx.stdout.write('  -f, --force   overwrite an existing output file\n');
    await ctx.stdout.write('  -q, --quiet   suppress warnings\n');
    return 0;
  }
  if (unknown.length > 0) {
    await ctx.stderr.write(`gunzip: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
    return 1;
  }
  if (positional.length === 0) {
    await ctx.stderr.write('gunzip: missing file operand\n');
    return 1;
  }
  return await gzipFiles(ctx, positional, {
    name: 'gunzip', decompress: true, keep: flags.keep === true, force: flags.force === true, quiet: flags.quiet === true,
  });
};

export default command;
