import type { Command, CommandContext } from '../types.js';
import { resolve, basename, dirname } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  force: { type: 'boolean' as const, short: 'f' },
  'no-clobber': { type: 'boolean' as const, short: 'n' },
  verbose: { type: 'boolean' as const, short: 'v' },
  'target-directory': { type: 'string' as const, short: 't' },
  help: { type: 'boolean' as const },
};

const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    await ctx.stdout.write('Usage: mv [-fnv] SOURCE... DEST\n');
    await ctx.stdout.write('  -f          overwrite the destination without prompting\n');
    await ctx.stdout.write('  -n          never overwrite an existing destination\n');
    await ctx.stdout.write('  -v          print each move\n');
    await ctx.stdout.write('  -t DIR      move every SOURCE into DIR\n');
    return 0;
  }
  if (unknown.length > 0) {
    await ctx.stderr.write(`mv: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
    return 1;
  }

  const targetDir = typeof flags['target-directory'] === 'string' && flags['target-directory']
    ? flags['target-directory']
    : null;
  const sources = targetDir ? positional : positional.slice(0, -1);
  const rawDest = targetDir ?? positional[positional.length - 1];

  if (sources.length === 0 || rawDest === undefined) {
    await ctx.stderr.write('mv: missing operand\n');
    return 1;
  }

  const dest = resolve(ctx.cwd, rawDest);
  const destIsDir = (await isDirectory(ctx, dest));
  if (sources.length > 1 && !destIsDir) {
    await ctx.stderr.write(`mv: target '${rawDest}' is not a directory\n`);
    return 1;
  }

  let exitCode = 0;
  for (const source of sources) {
    const src = resolve(ctx.cwd, source);
    const target = destIsDir ? resolve(dest, basename(src)) : dest;
    if (flags['no-clobber'] && (await ctx.vfs.exists(target))) continue;
    try {
      try { await ctx.vfs.rename(src, target); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) throw error;
        await copyAcrossMounts(ctx, src, target);
        await ctx.vfs.remove(src, { recursive: true });
      }
      if (flags.verbose) await ctx.stdout.write(`renamed '${source}' -> '${rawDest}'\n`);
    } catch (e) {
      if (e instanceof VFSError) {
        await ctx.stderr.write(`mv: ${e.message}\n`);
        exitCode = 1;
        continue;
      }
      throw e;
    }
  }
  return exitCode;
};

async function isDirectory(ctx: CommandContext, path: string): Promise<boolean> {
  try {
    return (await ctx.vfs.stat(path)).type === 'directory';
  } catch (error) {
    if (error instanceof VFSError && error.code === 'ENOENT') return false;
    throw error;
  }
}

export default command;

async function copyAcrossMounts(ctx: CommandContext, source: string, target: string): Promise<void> {
  const stat = await ctx.vfs.lstat(source);
  const exists = await ctx.vfs.exists(target);
  if (exists) {
    const destination = await ctx.vfs.lstat(target);
    if (stat.ino !== undefined && stat.dev !== undefined && stat.ino === destination.ino && stat.dev === destination.dev) {
      throw new VFSError('EINVAL', 'source and destination are the same file');
    }
    if (stat.type === 'directory' && (destination.type !== 'directory' || (await ctx.vfs.readdir(target)).length > 0)) {
      throw new VFSError('ENOTEMPTY', target);
    }
  }
  if (stat.type === 'directory') {
    if (!exists) await ctx.vfs.mkdir(target, { mode: stat.mode | 0o700 });
    for (const entry of await ctx.vfs.readdir(source)) {
      await copyAcrossMounts(ctx, resolve(source, entry.name), resolve(target, entry.name));
    }
  } else if (stat.type === 'symlink') {
    await ensureParentDir(ctx, target);
    const link = await ctx.vfs.readlink(source);
    if (exists) await ctx.vfs.unlink(target);
    await ctx.vfs.symlink(link, target);
    return;
  } else {
    await ensureParentDir(ctx, target);
    await ctx.vfs.copyFile(source, target);
  }
  await ctx.vfs.chmod(target, stat.mode);
  await ctx.vfs.utimes(target, stat.atime ?? stat.mtime, stat.mtime);
}

/** A leaf copied across mounts arrives before the destination holds its parent. */
async function ensureParentDir(ctx: CommandContext, target: string): Promise<void> {
  const parent = dirname(target);
  if (!(await ctx.vfs.exists(parent))) await ctx.vfs.mkdir(parent, { recursive: true });
}
