import type { Command, CommandContext } from '../types.js';
import { operandPath, resolve } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { resolveCopyTargets } from './copy-targets.js';
import { isVfsError, strerror, syscallError } from '../../../../vfs/vfs-error.js';
import { lstatOrThrow, statOrThrow } from '../../../../vfs/vfs.js';
import type { ProcessStat } from '../../../../runtime/process-files.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'r' },
  'recursive-upper': { type: 'boolean' as const, short: 'R' },
  archive: { type: 'boolean' as const, short: 'a' },
  preserve: { type: 'boolean' as const, short: 'p' },
  force: { type: 'boolean' as const, short: 'f' },
  'no-clobber': { type: 'boolean' as const, short: 'n' },
  'no-dereference': { type: 'boolean' as const, short: 'P' },
  'no-dereference-links': { type: 'boolean' as const, short: 'd' },
  verbose: { type: 'boolean' as const, short: 'v' },
  'target-directory': { type: 'string' as const, short: 't' },
  help: { type: 'boolean' as const },
};

const command: Command = async (ctx) => {
  const { flags, positional, unknown } = parseArgs(ctx.args, spec);
  if (flags.help) {
    await ctx.stdout.write('Usage: cp [-rRapPdfnv] SOURCE... DEST\n');
    await ctx.stdout.write('  -r, -R      copy directories recursively\n');
    await ctx.stdout.write('  -p          preserve mode, ownership and timestamps\n');
    await ctx.stdout.write('  -a          same as -R -P -p\n');
    await ctx.stdout.write('  -P, -d      copy a symbolic link SOURCE as the link\n');
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
  // GNU's rule: a link named on the command line is followed, unless the
  // copy is recursive or asked not to (-P, -d, -a).
  const followOperand = !recursive && flags['no-dereference'] !== true && flags['no-dereference-links'] !== true;
  const targets = await resolveCopyTargets(ctx, positional, typeof flags['target-directory'] === 'string' && flags['target-directory'] ? flags['target-directory'] : null);
  if (typeof targets === 'string' || targets === null) {
    await ctx.stderr.write(`cp: ${targets ?? 'missing operand'}\n`);
    return 1;
  }
  const { sources, rawDest } = targets;

  let exitCode = 0;
  const copying: Copying = {
    ctx, preserve, noClobber: flags['no-clobber'] === true,
    failed: async (message) => { await ctx.stderr.write(`cp: ${message}\n`); exitCode = 1; },
  };
  for (const source of sources) {
    const src = operandPath(ctx.cwd, source);
    const target = targets.targetFor(src);
    const stat = await statOrThrow(ctx.vfs, src, { follow: followOperand }).catch(async (e: unknown) => {
      if (!isVfsError(e)) throw e;
      await ctx.stderr.write(`cp: cannot stat '${source}': ${strerror(e)}\n`);
      return null;
    });
    if (stat === null) {
      exitCode = 1;
      continue;
    }
    try {
      if (stat.type === 'directory') {
        if (!recursive) {
          await ctx.stderr.write(`cp: -r not specified; omitting directory '${source}'\n`);
          exitCode = 1;
          continue;
        }
        // Where they are, through their links: the names as spelled may say either.
        const sourceAt = await ctx.vfs.realpath(src);
        const parent = target.slice(0, target.lastIndexOf('/')) || '/';
        const parentAt = await ctx.vfs.realpath(parent).catch(() => null);
        const targetAt = parentAt === null ? null : `${parentAt === '/' ? '' : parentAt}/${target.slice(target.lastIndexOf('/') + 1)}`;
        if (targetAt !== null && (targetAt === sourceAt || targetAt.startsWith(`${sourceAt}/`))) {
          await ctx.stderr.write(`cp: cannot copy a directory, '${source}', into itself, '${rawDest}'\n`);
          exitCode = 1;
          continue;
        }
        await copyTree(copying, src, target);
      } else {
        if (copying.noClobber && (await ctx.vfs.exists(target))) continue;
        await copyEntry(copying, src, target, stat);
      }
      if (flags.verbose) await ctx.stdout.write(`'${source}' -> '${resolve('/', target)}'\n`);
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

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/** One cp run: its options, and how a failure that does not stop it is told (status 1). */
interface Copying {
  readonly ctx: CommandContext;
  readonly preserve: boolean;
  readonly noClobber: boolean;
  failed(message: string): Promise<void>;
}

/**
 * A new destination is one copy of inode rows (the filesystem shares the
 * bytes, and keeps what -p keeps). An existing one is merged into, and a copy
 * the filesystem cannot make in one piece (across mounts) goes entry by entry.
 */
async function copyTree(copying: Copying, src: string, target: string): Promise<void> {
  const { ctx, preserve, noClobber } = copying;
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
    const from = operandPath(src, entry.name);
    const to = operandPath(target, entry.name);
    const child = await lstatOrThrow(ctx.vfs, from);
    if (child.type === 'directory') await copyTree(copying, from, to);
    else if (!(noClobber && (await ctx.vfs.exists(to)))) await copyEntry(copying, from, to, child);
  }
  if (preserve) await applyPreserved(copying, target, stat);
}

async function copyEntry(copying: Copying, src: string, target: string, stat: ProcessStat): Promise<void> {
  const { ctx, preserve } = copying;
  const parent = target.slice(0, target.lastIndexOf('/')) || '/';
  if (!(await ctx.vfs.exists(parent))) throw syscallError('ENOENT', 'copyfile', src, { dest: target });
  if (stat.type === 'symlink') {
    const link = await ctx.vfs.readlink(src);
    if (await ctx.vfs.exists(target)) await ctx.vfs.unlink(target);
    await ctx.vfs.symlink(link, target);
  } else {
    await ctx.vfs.copy(src, target);
  }
  if (preserve) await applyPreserved(copying, target, stat);
}

/**
 * -p: the source's mode, owner and times on `target`; a link's own owner and
 * times, and no mode (a link has none of its own). A caller that may not give
 * the file the source's owner keeps its own, silently, as GNU cp does; for
 * root, who may, a refusal is told and the copy goes on (status 1).
 */
async function applyPreserved(copying: Copying, target: string, stat: ProcessStat): Promise<void> {
  const { ctx } = copying;
  const follow = stat.type !== 'symlink';
  try {
    await ctx.vfs.chown(target, stat.uid, stat.gid, { follow });
  } catch (error) {
    const code = errorCode(error);
    if (!isVfsError(error) || (code !== 'EPERM' && code !== 'EINVAL')) throw error;
    if (ctx.cred.uid === 0) await copying.failed(`failed to preserve ownership for '${target}': ${strerror(error)}`);
  }
  if (follow) await ctx.vfs.chmod(target, stat.mode);
  await ctx.vfs.utimes(target, stat.atimeMs, stat.mtimeMs, { follow });
}

export default command;
