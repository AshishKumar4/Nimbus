import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { decompressGzip } from '../../utils/archive.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  keep: { type: 'boolean' as const, short: 'k' },
  force: { type: 'boolean' as const, short: 'f' },
  quiet: { type: 'boolean' as const, short: 'q' },
  help: { type: 'boolean' as const },
};

const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    ctx.stdout.write('Usage: gunzip [-kfq] file.gz...\n');
    ctx.stdout.write('  -k, --keep    keep original file\n');
    ctx.stdout.write('  -f, --force   overwrite an existing output file\n');
    ctx.stdout.write('  -q, --quiet   suppress warnings\n');
    return 0;
  }
  if (unknown.length > 0) {
    ctx.stderr.write(`gunzip: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
    return 1;
  }
  const keep = flags.keep === true;
  const files = positional;

  if (files.length === 0) {
    ctx.stderr.write('gunzip: missing file operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      if (!path.endsWith('.gz')) {
        ctx.stderr.write(`gunzip: ${file}: unknown suffix -- ignored\n`);
        exitCode = 1;
        continue;
      }
      const data = ctx.vfs.readFile(path);
      const decompressed = await decompressGzip(data);
      const outPath = path.slice(0, -3);
      ctx.vfs.writeFile(outPath, decompressed);
      if (!keep) ctx.vfs.unlink(path);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`gunzip: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
