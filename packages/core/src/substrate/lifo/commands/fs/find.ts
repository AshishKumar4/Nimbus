/**
 * find(1), as GNU findutils 4.10 behaves for the expression language it
 * implements (see find/expression.ts for what is refused, and why).
 *
 * The command line is parsed whole before anything is visited; the walk
 * (find/walk.ts) hands each file to the expression in fts order, reading
 * ahead of it when the expression only looks; commands run by -exec and
 * -execdir are child processes started through the shell (`runAs` with the
 * caller's own credential), from find's directory or the file's.
 */

import type { Command, CommandContext } from '../types.js';
import type { ProcessStat } from '../../../../runtime/process-files.js';
import { isVfsError, VFS_STRERROR, type VfsErrorCode } from '../../../../vfs/vfs-error.js';
import { NIMBUS_VERSION } from '../../../../constants.js';
import { findUnixGroupName, findUnixUserName } from '../../../../shell/unix-accounts.js';
import { globMatch } from '../../utils/glob.js';
import { FindUsageError, quote } from './find/errors.js';
import { parseFindCommand, type Expression, type FindPlan, type Primary, type TypeLetter } from './find/expression.js';
import { fileTypeLetter, renderFormat, type FileTypeLetter } from './find/format.js';
import { FindEntry, READ_AHEAD_CALLS, Walker, type VisitResult } from './find/walk.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What one -exec … + command line may carry, as findutils' bc_use_sensible_arg_max sets it. */
const EXEC_ARGUMENT_BYTES = 128 * 1024;

/** -quit, which ends the walk wherever the evaluation is. */
class Quit extends Error {}

/** Whether the expression only looks, so the walk may read ahead of it. */
function onlyLooks(expression: Expression): boolean {
  switch (expression.kind) {
    case 'and': case 'or': case 'comma': return onlyLooks(expression.left) && onlyLooks(expression.right);
    case 'not': return onlyLooks(expression.operand);
    case 'primary': return expression.primary.kind !== 'exec' && expression.primary.kind !== 'delete';
  }
}

/**
 * Whether evaluating the expression reads every file's stat before anything
 * can cut it short, so reading stats ahead costs nothing the walk would not
 * spend: `-size +1M -name x` does, `-name x -size +1M` stats only the x's.
 */
function readsStatsFirst(expression: Expression): boolean {
  switch (expression.kind) {
    case 'and': case 'or': return readsStatsFirst(expression.left);
    case 'comma': return readsStatsFirst(expression.left) || readsStatsFirst(expression.right);
    case 'not': return readsStatsFirst(expression.operand);
    case 'primary': {
      const primary = expression.primary;
      switch (primary.kind) {
        case 'true': case 'false': case 'name': case 'path': case 'print': case 'prune': case 'quit':
        case 'delete': case 'exec': case 'access':
          return false;
        // A regular file and a device are told apart by a stat; a test that wants both, or neither, needs none.
        case 'type': {
          if (primary.target) return true;
          const others = [primary.types.f, primary.types.b, primary.types.c, primary.types.p, primary.types.s];
          return others.some((wanted) => wanted === true) && others.some((wanted) => wanted !== true);
        }
        case 'printf': return primary.format.needs === 'stat';
        default: return true;
      }
    }
  }
}

/** Every primary, left to right: the order findutils runs pending -exec … + batches in at the end. */
function primaries(expression: Expression): Primary[] {
  switch (expression.kind) {
    case 'and': case 'or': case 'comma': return [...primaries(expression.left), ...primaries(expression.right)];
    case 'not': return primaries(expression.operand);
    case 'primary': return [expression.primary];
  }
}

function compare(value: number, cmp: 'lt' | 'eq' | 'gt', against: number): boolean {
  return cmp === 'gt' ? value > against : cmp === 'lt' ? value < against : value === against;
}

/** findutils' pred_timewindow: after, before, or within `window` seconds after the reference. */
function timeWindow(time: number, cmp: 'lt' | 'eq' | 'gt', reference: number, window: number): boolean {
  if (cmp !== 'eq') return compare(time, cmp, reference);
  const delta = (time - reference) / 1000;
  return delta > 0 && delta <= window;
}

function timeOf(stat: ProcessStat, field: 'atime' | 'ctime' | 'mtime'): number {
  return field === 'atime' ? stat.atimeMs : field === 'ctime' ? stat.ctimeMs : stat.mtimeMs;
}

/** One -exec … + (or -execdir … +) site and the files waiting for its next command line. */
class Batch {
  readonly pending: string[] = [];
  bytes: number;
  directory: string | null = null;

  constructor(readonly primary: Extract<Primary, { kind: 'exec' }>) {
    this.bytes = primary.argv.reduce((total, arg) => total + encoder.encode(arg).length + 1, 0);
  }
}

class FindRun {
  private readonly walker: Walker;
  private readonly batches = new Map<Primary, Batch>();
  private readonly userNames = new Map<number, string | null>();
  private readonly groupNames = new Map<number, string | null>();
  private pruned = false;
  private lastDepth: number | null = null;

  constructor(private readonly ctx: CommandContext, readonly plan: FindPlan) {
    for (const primary of primaries(plan.expression)) {
      if (primary.kind === 'exec' && primary.batch) this.batches.set(primary, new Batch(primary));
    }
    this.walker = new Walker({
      vfs: ctx.vfs,
      cwd: ctx.cwd,
      symlinks: plan.symlinks,
      maxDepth: plan.maxDepth,
      minDepth: plan.minDepth,
      depthFirst: plan.depthFirst,
      sameDevice: plan.sameDevice,
      ignoreVanished: plan.ignoreVanished,
      readAhead: onlyLooks(plan.expression) ? READ_AHEAD_CALLS : 0,
      prefetchStats: readsStatsFirst(plan.expression),
      readAheadSubtrees: !primaries(plan.expression).some((primary) => primary.kind === 'prune'),
      signal: ctx.signal,
      report: (message) => this.diagnose(message),
    }, {
      event: (depth, newStart) => this.event(depth, newStart),
      visit: (entry) => this.visit(entry),
    });
  }

  async diagnose(message: string): Promise<void> {
    await this.ctx.stderr.write(`find: ${message}\n`);
  }

  async run(): Promise<number> {
    try {
      await this.walker.run(this.plan.startPoints);
    } finally {
      // However the walk ends (a closed pipe throws out of a write), nothing it started outlives it.
      await this.walker.settled();
    }
    // findutils' cleanup: what -exec … + and -execdir … + still hold runs, -quit or not.
    for (const batch of this.batches.values()) await this.flush(batch);
    if (this.ctx.signal.aborted) return 130;
    return this.walker.status;
  }

  /** -execdir … + runs its batch where the walk's depth changes (findutils' complete_pending_execdirs). */
  private async event(depth: number, newStart: boolean): Promise<void> {
    if (newStart || depth !== this.lastDepth) {
      for (const batch of this.batches.values()) if (batch.primary.inDirectory) await this.flush(batch);
    }
    this.lastDepth = depth;
  }

  private async visit(entry: FindEntry): Promise<VisitResult> {
    this.pruned = false;
    try {
      await this.evaluate(this.plan.expression, entry);
    } catch (error) {
      if (error instanceof Quit) return 'quit';
      throw error;
    }
    return this.pruned ? 'prune' : 'continue';
  }

  private async evaluate(expression: Expression, entry: FindEntry): Promise<boolean> {
    switch (expression.kind) {
      case 'and': return (await this.evaluate(expression.left, entry)) && (await this.evaluate(expression.right, entry));
      case 'or': return (await this.evaluate(expression.left, entry)) || (await this.evaluate(expression.right, entry));
      case 'comma':
        await this.evaluate(expression.left, entry);
        return await this.evaluate(expression.right, entry);
      case 'not': return !(await this.evaluate(expression.operand, entry));
      case 'primary': return await this.test(expression.primary, entry);
    }
  }

  private async test(primary: Primary, entry: FindEntry): Promise<boolean> {
    switch (primary.kind) {
      case 'true': return true;
      case 'false': return false;
      case 'name': return globMatch(primary.pattern, primary.fold ? entry.name.toLowerCase() : entry.name);
      case 'path': return globMatch(primary.pattern, primary.fold ? entry.path.toLowerCase() : entry.path);
      case 'lname': {
        const stat = await entry.statForTest();
        if (stat === null || stat.type !== 'symlink') return false;
        const target = await this.linkTarget(entry);
        return target !== null && globMatch(primary.pattern, primary.fold ? target.toLowerCase() : target);
      }
      case 'type': return primary.target ? await this.testTargetType(entry, primary.types) : await this.testType(entry, primary.types);
      case 'size': {
        const stat = await entry.statForTest();
        if (stat === null) return false;
        const units = Math.floor(stat.size / primary.unit) + (stat.size % primary.unit !== 0 ? 1 : 0);
        return compare(units, primary.cmp, primary.count);
      }
      case 'time': {
        const stat = await entry.statForTest();
        return stat !== null && timeWindow(timeOf(stat, primary.field), primary.cmp, primary.reference, primary.window);
      }
      case 'used': {
        // How long after its last change the file was last read; never, when it was not read since (findutils' pred_used).
        const stat = await entry.statForTest();
        return stat !== null && stat.atimeMs >= stat.ctimeMs && timeWindow(stat.ctimeMs - stat.atimeMs, primary.cmp, primary.reference, 86400);
      }
      case 'newer': {
        const stat = await entry.statForTest();
        return stat !== null && timeOf(stat, primary.field) > primary.reference;
      }
      case 'perm': {
        const stat = await entry.statForTest();
        if (stat === null) return false;
        const bits = stat.type === 'directory' ? primary.directory : primary.file;
        if (primary.match === 'exact') return (stat.mode & 0o7777) === bits;
        if (primary.match === 'all') return (stat.mode & bits) === bits;
        return bits === 0 || (stat.mode & bits) !== 0;
      }
      case 'number': {
        const stat = await entry.statForTest();
        if (stat === null) return false;
        const value = primary.field === 'uid' ? stat.uid : primary.field === 'gid' ? stat.gid : primary.field === 'nlink' ? stat.nlink : stat.ino;
        return compare(value, primary.cmp, primary.value);
      }
      case 'nouser': {
        const stat = await entry.statForTest();
        return stat !== null && (await this.userName(stat.uid)) === null;
      }
      case 'nogroup': {
        const stat = await entry.statForTest();
        return stat !== null && (await this.groupName(stat.gid)) === null;
      }
      case 'empty': return await this.testEmpty(entry);
      case 'access':
        try {
          await this.ctx.vfs.access(entry.absolute, primary.mode);
          return true;
        } catch (error) {
          if (isVfsError(error)) return false;
          throw error;
        }
      case 'samefile': {
        const stat = await entry.statForTest();
        return stat !== null && stat.dev === primary.dev && stat.ino === primary.ino;
      }
      case 'print':
        await this.ctx.stdout.write(entry.path + primary.terminator);
        return true;
      case 'printf': {
        const needs = primary.format.needs;
        const stat = needs === 'stat' ? await entry.statForTest() : null;
        const type = needs === 'path' ? null : stat !== null ? fileTypeLetter(stat) : await this.typeLetter(entry, null);
        if ((needs === 'stat' && stat === null) || (needs === 'type' && type === null)) return false;
        const chunks = await renderFormat(primary.format, {
          path: entry.path,
          start: entry.start,
          depth: entry.depth,
          stat,
          type,
          linkTarget: () => this.linkTarget(entry),
          targetType: () => this.targetTypeLetter(entry),
          userName: (uid) => this.userName(uid),
          groupName: (gid) => this.groupName(gid),
        });
        await this.writeBytes(chunks);
        return true;
      }
      case 'prune': {
        // -depth makes -prune a no-op; otherwise it asks whether this is a directory (findutils' pred_prune).
        if (this.plan.depthFirst) return true;
        const stat = await entry.statForTest();
        if (stat === null) return false;
        if (stat.type === 'directory') this.pruned = true;
        return true;
      }
      case 'quit':
        throw new Quit();
      case 'delete': return await this.delete(entry);
      case 'exec': return await this.exec(primary, entry);
    }
  }

  /**
   * The file's type letter as fts knows it: the walk's stat, for what the
   * walk stats; otherwise readdir's type, where a 'file' (a regular file, or
   * a device readdir cannot tell apart) is asked of a stat when `types` needs
   * the difference and that stat can be had, d_type being what GNU trusts.
   * Null when the walk's stat failed (reported when the walk reached it).
   */
  private async typeLetter(entry: FindEntry, types: Readonly<Partial<Record<TypeLetter, true>>> | null): Promise<FileTypeLetter | null> {
    if (entry.statedByWalk) {
      const stat = await entry.xstat();
      return stat.ok ? fileTypeLetter(stat.value) : null;
    }
    if (entry.direntType === 'symlink') return 'l';
    if (entry.direntType === 'directory') return 'd';
    if (types !== null) {
      const others = [types.f, types.b, types.c, types.p, types.s];
      if (others.every((wanted) => wanted === true) || others.every((wanted) => wanted !== true)) return 'f';
    }
    const stat = await entry.xstat();
    return stat.ok ? fileTypeLetter(stat.value) : 'f';
  }

  private async testType(entry: FindEntry, types: Readonly<Partial<Record<TypeLetter, true>>>): Promise<boolean> {
    const letter = await this.typeLetter(entry, types);
    return letter !== null && types[letter] === true;
  }

  /** -xtype: the type through the other stat; a link that leads nowhere is a link (findutils' pred_xtype). */
  private async testTargetType(entry: FindEntry, types: Readonly<Partial<Record<TypeLetter, true>>>): Promise<boolean> {
    if ((await entry.statForTest()) === null) return false;
    const outcome = entry.following ? await entry.lstat() : await entry.followed();
    if (outcome.ok && outcome.value !== null) return types[fileTypeLetter(outcome.value)] === true;
    if (!entry.following && (outcome.ok || outcome.error.code === 'ENOTDIR')) return await this.testType(entry, types);
    if (!outcome.ok) await this.diagnoseFile(entry, outcome.error.code);
    return false;
  }

  private async diagnoseFile(entry: FindEntry, code: VfsErrorCode): Promise<void> {
    await this.walker.report(`${quote(entry.path)}: ${VFS_STRERROR[code]}`);
  }

  /** %Y for a link: what it leads to, N when nothing, L for a loop (findutils' %Y). */
  private async targetTypeLetter(entry: FindEntry): Promise<string> {
    const outcome = await entry.followed();
    if (outcome.ok) return outcome.value === null ? 'N' : fileTypeLetter(outcome.value);
    if (outcome.error.code === 'ENOTDIR') return 'N';
    if (outcome.error.code === 'ELOOP') return 'L';
    await this.diagnose(`${quote(entry.path)}: ${VFS_STRERROR[outcome.error.code]}`);
    return '?';
  }

  private async linkTarget(entry: FindEntry): Promise<string | null> {
    try {
      return await this.ctx.vfs.readlink(entry.absolute);
    } catch (error) {
      if (!isVfsError(error)) throw error;
      await this.diagnoseFile(entry, error.code);
      return null;
    }
  }

  /** -empty: a directory with no entries, or a regular file of no bytes (findutils' pred_empty). */
  private async testEmpty(entry: FindEntry): Promise<boolean> {
    const stat = await entry.statForTest();
    if (stat === null) return false;
    if (stat.type !== 'directory') return fileTypeLetter(stat) === 'f' && stat.size === 0;
    const listing = await entry.listing();
    if (listing.ok) return listing.value.length === 0;
    await this.diagnoseFile(entry, listing.error.code);
    return false;
  }

  /** -delete: unlink, or rmdir for a directory; the start point `.` is never removed (findutils' pred_delete). */
  private async delete(entry: FindEntry): Promise<boolean> {
    if (entry.parent === null && entry.start === '.') return true;
    const vfs = this.ctx.vfs;
    let isDirectory = entry.direntType === 'directory';
    if (entry.direntType === null || (entry.direntType === 'symlink' && entry.following)) {
      const stat = await entry.xstat();
      isDirectory = stat.ok && stat.value.type === 'directory';
    }
    try {
      try {
        await (isDirectory ? vfs.rmdir(entry.absolute) : vfs.unlink(entry.absolute));
      } catch (error) {
        if (!isVfsError(error, 'EISDIR')) throw error;
        await vfs.rmdir(entry.absolute);
      }
      return true;
    } catch (error) {
      if (!isVfsError(error)) throw error;
      if (this.plan.ignoreVanished && error.code === 'ENOENT') return true;
      await this.walker.report(`cannot delete ${quote(entry.path)}: ${VFS_STRERROR[error.code]}`);
      return false;
    }
  }

  private async exec(primary: Extract<Primary, { kind: 'exec' }>, entry: FindEntry): Promise<boolean> {
    const place = primary.inDirectory ? await this.execDirectory(entry) : { directory: this.ctx.cwd, argument: entry.path };
    if (place === null) return false;
    if (primary.batch) {
      const batch = this.batches.get(primary);
      if (batch === undefined) throw new Error('find: an -exec … + site without its batch');
      const size = encoder.encode(place.argument).length + 1;
      if (batch.pending.length > 0 && batch.bytes + size > EXEC_ARGUMENT_BYTES) await this.flush(batch);
      batch.directory = place.directory;
      batch.pending.push(place.argument);
      batch.bytes += size;
      return true;
    }
    const argv = primary.argv.map((arg) => arg.split('{}').join(place.argument));
    return (await this.launch(argv, place.directory)) === 0;
  }

  /**
   * Where -execdir runs a command for this file: the directory holding it,
   * as the directory itself (findutils changes to it by descriptor), so a
   * path the command resolves from there is not read through a link the
   * walk followed to get there.
   */
  private async execDirectory(entry: FindEntry): Promise<{ directory: string; argument: string } | null> {
    const place = entry.execDirectory;
    try {
      return { directory: await this.ctx.vfs.realpath(place.directory), argument: place.argument };
    } catch (error) {
      if (!isVfsError(error)) throw error;
      await this.walker.report(`Failed to save working directory in order to run a command on ${quote(entry.path)}: ${VFS_STRERROR[error.code]}`);
      return null;
    }
  }

  /** Run what a batch holds as one command line; a failure is find's exit status, not the test's. */
  private async flush(batch: Batch): Promise<void> {
    if (batch.pending.length === 0) return;
    const argv = [...batch.primary.argv, ...batch.pending];
    const directory = batch.directory ?? this.ctx.cwd;
    batch.pending.length = 0;
    batch.bytes = batch.primary.argv.reduce((total, arg) => total + encoder.encode(arg).length + 1, 0);
    if ((await this.launch(argv, directory)) !== 0) this.walker.fail();
  }

  /**
   * A child process for `argv`, under find's own credential, in `directory`:
   * its exit status, or 1 when there is no such program, which findutils'
   * child reports before it exits so.
   */
  private async launch(argv: string[], directory: string): Promise<number> {
    try {
      return await this.ctx.runAs(this.ctx.cred, argv, { cwd: directory });
    } catch (error) {
      if (!isVfsError(error) || error.syscall !== 'execvp') throw error;
      await this.diagnose(`${quote(argv[0] ?? '')}: ${VFS_STRERROR[error.code]}`);
      return 1;
    }
  }

  private async writeBytes(chunks: readonly Uint8Array[]): Promise<void> {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length === 0) return;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (this.ctx.stdout.writeBytes) await this.ctx.stdout.writeBytes(bytes);
    else await this.ctx.stdout.write(decoder.decode(bytes));
  }

  private async userName(uid: number): Promise<string | null> {
    if (!this.userNames.has(uid)) this.userNames.set(uid, await accountName(() => findUnixUserName(this.ctx.vfs, uid)));
    return this.userNames.get(uid) ?? null;
  }

  private async groupName(gid: number): Promise<string | null> {
    if (!this.groupNames.has(gid)) this.groupNames.set(gid, await accountName(() => findUnixGroupName(this.ctx.vfs, gid)));
    return this.groupNames.get(gid) ?? null;
  }
}

/** An account's name, where an unreadable /etc/passwd or /etc/group means it has none (as getpwuid reports it). */
async function accountName(lookup: () => Promise<string | null>): Promise<string | null> {
  try {
    return await lookup();
  } catch (error) {
    if (isVfsError(error)) return null;
    throw error;
  }
}

const command: Command = async (ctx) => {
  const warnings: string[] = [];
  const flushWarnings = async (): Promise<void> => {
    for (const warning of warnings.splice(0)) await ctx.stderr.write(`find: ${warning}\n`);
  };
  let parsed;
  try {
    parsed = await parseFindCommand(ctx.args, {
      vfs: ctx.vfs,
      cwd: ctx.cwd,
      env: ctx.env,
      now: Date.now(),
      warnings: ctx.isFdTerminal?.(0) ?? false,
      version: NIMBUS_VERSION,
      warn: (message) => warnings.push(message),
    });
  } catch (error) {
    if (!(error instanceof FindUsageError)) throw error;
    await flushWarnings();
    await ctx.stderr.write(`find: ${error.message}\n`);
    for (const line of error.continuation) await ctx.stderr.write(`${line}\n`);
    return 1;
  }
  await flushWarnings();
  if (parsed.kind === 'info') {
    await ctx.stdout.write(parsed.text);
    return 0;
  }
  return await new FindRun(ctx, parsed).run();
};

export default command;
