import type { Command } from '../types.js';
import { resolve, dirname } from '../../utils/path.js';
import { parseZip } from '../../utils/archive.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  list: { type: 'boolean' as const, short: 'l' },
  overwrite: { type: 'boolean' as const, short: 'o' },
  'never-overwrite': { type: 'boolean' as const, short: 'n' },
  quiet: { type: 'boolean' as const, short: 'q' },
  junk: { type: 'boolean' as const, short: 'j' },
  pipe: { type: 'boolean' as const, short: 'p' },
  dir: { type: 'string' as const, short: 'd' },
  help: { type: 'boolean' as const },
};

const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    await ctx.stdout.write('Usage: unzip [-lonqjp] [-d dir] archive.zip\n');
    await ctx.stdout.write('  -l       list contents\n');
    await ctx.stdout.write('  -o       overwrite existing files without prompting\n');
    await ctx.stdout.write('  -n       never overwrite existing files\n');
    await ctx.stdout.write('  -q       quiet\n');
    await ctx.stdout.write('  -j       junk paths, extract every entry into one directory\n');
    await ctx.stdout.write('  -p       extract to stdout\n');
    await ctx.stdout.write('  -d dir   extract to directory\n');
    return 0;
  }
  if (unknown.length > 0) {
    await ctx.stderr.write(`unzip: invalid option: ${unknown[0]}\n`);
    return 1;
  }

  const archiveFile = positional[0];
  if (!archiveFile) {
    await ctx.stderr.write('unzip: missing archive operand\n');
    return 1;
  }

  const listOnly = flags.list === true;
  const toStdout = flags.pipe === true;
  const quiet = flags.quiet === true || toStdout;
  const junkPaths = flags.junk === true;
  const neverOverwrite = flags['never-overwrite'] === true;
  const destDir = typeof flags.dir === 'string' ? flags.dir : '';
  const archivePath = resolve(ctx.cwd, archiveFile);
  const targetDir = destDir ? resolve(ctx.cwd, destDir) : ctx.cwd;

  try {
    const data = (await ctx.vfs.readFile(archivePath));
    const entries = parseZip(data);

    if (listOnly) {
      await ctx.stdout.write('  Length      Name\n');
      await ctx.stdout.write('---------  ----\n');
      let totalSize = 0;
      for (const entry of entries) {
        const size = entry.data.length;
        totalSize += size;
        const path = entry.isDirectory ? entry.path + '/' : entry.path;
        await ctx.stdout.write(`${String(size).padStart(9)}  ${path}\n`);
      }
      await ctx.stdout.write('---------  ----\n');
      await ctx.stdout.write(`${String(totalSize).padStart(9)}  ${entries.length} file(s)\n`);
      return 0;
    }

    if (destDir) {
      try { (await ctx.vfs.mkdir(targetDir, { recursive: true })); } catch { /* exists */ }
    }

    for (const entry of entries) {
      const name = junkPaths ? entry.path.slice(entry.path.lastIndexOf('/') + 1) : entry.path;
      if (entry.isDirectory) {
        if (junkPaths) continue;
        const entryPath = resolve(targetDir, name);
        try { (await ctx.vfs.mkdir(entryPath, { recursive: true })); } catch { /* exists */ }
        if (!quiet) await ctx.stdout.write(`  extracting: ${entry.path}/\n`);
        continue;
      }

      if (toStdout) {
        writeBytes(ctx.stdout, entry.data);
        continue;
      }

      const entryPath = resolve(targetDir, name);
      if (neverOverwrite && (await ctx.vfs.exists(entryPath))) continue;
      const parent = dirname(entryPath);
      try { (await ctx.vfs.mkdir(parent, { recursive: true })); } catch { /* exists */ }
      (await ctx.vfs.writeFile(entryPath, entry.data));
      if (!quiet) await ctx.stdout.write(`  extracting: ${entry.path}\n`);
    }
  } catch (e) {
    if (e instanceof VFSError) {
      await ctx.stderr.write(`unzip: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  return 0;
};

function writeBytes(stdout: { write(text: string): void; writeBytes?(bytes: Uint8Array): void }, bytes: Uint8Array): void {
  if (stdout.writeBytes) stdout.writeBytes(bytes);
  else stdout.write(new TextDecoder().decode(bytes));
}

export default command;
