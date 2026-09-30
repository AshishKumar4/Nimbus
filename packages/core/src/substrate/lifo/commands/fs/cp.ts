import type { Command, CommandContext } from '../types.js';
import { resolve, basename, dirname } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { isVfsError, syscallError } from '../../../../vfs/vfs-error.js';
import { exists, lstatOrThrow, statOrThrow } from '../../../../vfs/vfs.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'r' },
  'recursive-upper': { type: 'boolean' as const, short: 'R' },
  archive: { type: 'boolean' as const, short: 'a' },
  preserve: { type: 'boolean' as const, short: 'p' },
  force: { type: 'boolean' as const, short: 'f' },
  'no-clobber': { type: 'boolean' as const, short: 'n' },
  verbose: { type: 'boolean' as const, short: 'v' },
  'target-directory': { type: 'string' as const, short: 't' },
  help: { type: 'boolean' as const },
};

const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    await ctx.stdout.write('Usage: cp [-rRapfnv] SOURCE... DEST\n');
    await ctx.stdout.write('  -r, -R      copy directories recursively\n');
    await ctx.stdout.write('  -p          preserve mode, ownership and timestamps\n');
    await ctx.stdout.write('  -a          same as -R -p\n');
    await ctx.stdout.write('  -f          overwrite the destination without prompting\n');
    await ctx.stdout.write('  -n          never overwrite an existing destination\n');
    await ctx.stdout.write('  -v          print each copy\n');
    await ctx.stdout.write('  -t DIR      copy every SOURCE into DIR\n');
    return 0;
  }
  if (unknown.length > 0) {
    await ctx.stderr.write(`cp: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
    return 1;
  }
  const recursive = flags.recursive === true || flags['recursive-upper'] === true || flags.archive === true;
  const preserve = flags.preserve === true || flags.archive === true;
  const targetDir = typeof flags['target-directory'] === 'string' && flags['target-directory']
    ? flags['target-directory']
    : null;
  const sources = targetDir ? positional : positional.slice(0, -1);
  const rawDest = targetDir ?? positional[positional.length - 1];
  if (sources.length === 0 || rawDest === undefined) {
    await ctx.stderr.write('cp: missing operand\n');
    return 1;
  }

  const dest = resolve(ctx.cwd, rawDest);
  const destIsDir = await isDirectory(ctx, dest);
  if ((sources.length > 1 || targetDir) && !destIsDir) {
    await ctx.stderr.write(`cp: target '${rawDest}' is not a directory\n`);
    return 1;
  }

  let exitCode = 0;
  for (const source of sources) {
    const src = resolve(ctx.cwd, source);
    const target = destIsDir ? resolve(dest, basename(src)) : dest;
    try {
      const stat = await lstatOrThrow(ctx.vfs, src);
      if (stat.type === 'directory') {
        if (!recursive) {
          await ctx.stderr.write(`cp: -r not specified; omitting directory '${source}'\n`);
          exitCode = 1;
          continue;
        }
        if (target === src || target.startsWith(`${src}/`)) {
          await ctx.stderr.write(`cp: cannot copy a directory, '${source}', into itself, '${rawDest}'\n`);
          exitCode = 1;
          continue;
        }
        await copyTree(ctx, src, target, preserve, flags['no-clobber'] === true);
      } else {
        if (flags['no-clobber'] && (await ctx.vfs.exists(target))) continue;
        await copyEntry(ctx, src, target, stat, preserve);
      }
      if (flags.verbose) await ctx.stdout.write(`'${source}' -> '${target}'\n`);
    } catch (e) {
      if (isVfsError(e)) {
        await ctx.stderr.write(`cp: ${e.message}\n`);
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
    return (await statOrThrow(ctx.vfs, path)).type === 'directory';
  } catch (error) {
    if (isVfsError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/**
 * A new destination is one copy of inode rows (the filesystem shares the
 * bytes). An existing one is merged into, and a copy the filesystem cannot
 * make in one piece (across mounts) goes entry by entry.
 */
async function copyTree(ctx: CommandContext, src: string, target: string, preserve: boolean, noClobber: boolean): Promise<void> {
  if (!(await ctx.vfs.exists(target))) {
    try {
      await ctx.vfs.copy(src, target, { recursive: true, preserve });
      return;
    } catch (error) {
      if (errorCode(error) !== 'EXDEV') throw error;
    }
  }
  const stat = await lstatOrThrow(ctx.vfs, src);
  if (!(await ctx.vfs.exists(target))) await ctx.vfs.mkdir(target, { mode: stat.mode | 0o700 });
  else if ((await lstatOrThrow(ctx.vfs, target)).type !== 'directory') throw syscallError('ENOTDIR', 'cp', src, { dest: target });
  for (const entry of await ctx.vfs.readdir(src)) {
    const from = resolve(src, entry.name);
    const to = resolve(target, entry.name);
    const child = await lstatOrThrow(ctx.vfs, from);
    if (child.type === 'directory') await copyTree(ctx, from, to, preserve, noClobber);
    else if (!(noClobber && (await ctx.vfs.exists(to)))) await copyEntry(ctx, from, to, child, preserve);
  }
  if (preserve) await applyPreserved(ctx, target, stat);
}

async function copyEntry(
  ctx: CommandContext,
  src: string,
  target: string,
  stat: { type: string; mode: number; mtimeMs: number; atimeMs?: number },
  preserve: boolean,
): Promise<void> {
  if (!(await ctx.vfs.exists(dirname(target)))) throw syscallError('ENOENT', 'copyfile', src, { dest: target });
  if (stat.type === 'symlink') {
    const link = await ctx.vfs.readlink(src);
    if (await ctx.vfs.exists(target)) await ctx.vfs.unlink(target);
    await ctx.vfs.symlink(link, target);
    return;
  }
  await ctx.vfs.copy(src, target);
  if (preserve) await applyPreserved(ctx, target, stat);
}

async function applyPreserved(
  ctx: CommandContext,
  target: string,
  stat: { mode: number; mtimeMs: number; atimeMs?: number },
): Promise<void> {
  await ctx.vfs.chmod(target, stat.mode);
  await ctx.vfs.utimes(target, stat.atimeMs ?? stat.mtimeMs, stat.mtimeMs);
}

export default command;
