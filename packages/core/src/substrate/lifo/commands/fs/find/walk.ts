/**
 * find's walk, in fts order: each start point, then depth first in the order
 * readdir returns names, a directory before its contents (or after them,
 * under -depth). The visitor sees files strictly in that order.
 *
 * What the visitor will ask for next is read ahead of it: when a directory's
 * listing arrives, its subdirectories' listings (and, when the expression
 * reads stats, its entries' stats) are queued in the order the walk will
 * reach them, and a bounded number run at once. Nothing read ahead is
 * observable: an error is reported when the visitor reaches it, and work for
 * a subtree the visitor never enters is dropped. A mount whose every readdir
 * is a network round trip then costs about one round trip per level of
 * concurrency, not per directory.
 *
 * Read-ahead is for walks that only look. When the expression runs commands
 * or deletes, a directory must be read when the walk reaches it, after the
 * visits that may have changed it, so the caller turns it off.
 */

import type { ProcessStat, ProcessView } from '../../../../../runtime/process-files.js';
import type { VfsDirent, VfsFileType } from '../../../../../vfs/vfs.js';
import { isVfsError, syscallError, VFS_STRERROR, type VfsError } from '../../../../../vfs/vfs-error.js';
import { resolve } from '../../../utils/path.js';
import { quote } from './errors.js';
import type { SymlinkMode } from './expression.js';
import { baseName } from './format.js';

/** A settled filesystem call: never a rejected promise, so work read ahead and then dropped cannot fail the walk. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: VfsError };

async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (isVfsError(error)) return { ok: false, error };
    throw error;
  }
}

/** A position in walk order: the start point's index, then each child's index. A prefix (an ancestor) comes first. */
type Key = readonly number[];

function compareKeys(a: Key, b: Key): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** One unit of filesystem work: started when there is room ahead of the walk, or at once when the walk needs it. */
class Task<T> {
  private promise: Promise<Outcome<T>> | null = null;
  /** A listing started ahead of the walk, holding a place in the read-ahead window until the walk takes it or passes it. */
  held = false;

  constructor(
    readonly key: Key,
    readonly listing: boolean,
    private readonly run: () => Promise<T>,
    private readonly scheduler: Scheduler,
  ) {}

  get started(): boolean {
    return this.promise !== null;
  }

  /** The outcome, starting the work now if nothing has yet. */
  result(): Promise<Outcome<T>> {
    if (this.promise === null) {
      this.scheduler.started();
      this.promise = settle(this.run).finally(() => this.scheduler.settled());
    }
    return this.promise;
  }
}

/** A min-heap of tasks by walk order. */
class TaskQueue {
  private readonly heap: Task<unknown>[] = [];

  peek(): Task<unknown> | undefined {
    return this.heap[0];
  }

  push(task: Task<unknown>): void {
    const heap = this.heap;
    heap.push(task);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (compareKeys(heap[parent].key, heap[i].key) <= 0) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  pop(): Task<unknown> | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && compareKeys(heap[left].key, heap[smallest].key) < 0) smallest = left;
        if (right < heap.length && compareKeys(heap[right].key, heap[smallest].key) < 0) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Filesystem calls in flight ahead of the walk, when the walk reads ahead. */
export const READ_AHEAD_CALLS = 16;
/** Directory listings held for the walk before it reaches them. */
const READ_AHEAD_LISTINGS = 256;

/**
 * Starts queued tasks in walk order, at most `calls` filesystem calls at
 * once and at most READ_AHEAD_LISTINGS listings waiting for the walk. A task
 * the walk has passed is dropped from the queue; only the walk itself can
 * still start it (a -depth visit going back to its directory).
 */
class Scheduler {
  private readonly queue = new TaskQueue();
  private readonly holding = new TaskQueue();
  private inFlight = 0;
  private held = 0;
  private position: Key = [];
  private stopped = false;
  /** Resolves once nothing is in flight, after stop(). */
  private idle: (() => void) | null = null;

  constructor(private readonly calls: number) {}

  get enabled(): boolean {
    return this.calls > 0;
  }

  task<T>(key: Key, listing: boolean, run: () => Promise<T>): Task<T> {
    return new Task(key, listing, run, this);
  }

  /** Queue `task` to run ahead of the walk. */
  ahead(task: Task<unknown>): void {
    if (!this.enabled || task.started) return;
    this.queue.push(task);
    this.pump();
  }

  started(): void {
    this.inFlight++;
  }

  settled(): void {
    this.inFlight--;
    if (this.inFlight === 0) this.idle?.();
    this.pump();
  }

  /** The walk has taken a listing, or passed it: its place in the window is free. */
  release(task: Task<unknown>): void {
    if (!task.held) return;
    task.held = false;
    this.held--;
    this.pump();
  }

  /** The walk has reached `key`: everything before it is behind the walk. */
  advance(key: Key): void {
    this.position = key;
    for (let task = this.holding.peek(); task !== undefined && compareKeys(task.key, key) < 0; task = this.holding.peek()) {
      this.holding.pop();
      this.release(task);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Once the calls already started have answered: find's reads do not outlive it. */
  async drained(): Promise<void> {
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => { this.idle = resolve; });
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < this.calls && this.held < READ_AHEAD_LISTINGS) {
      const task = this.queue.pop();
      if (task === undefined) break;
      if (task.started || compareKeys(task.key, this.position) < 0) continue;
      if (task.listing) {
        task.held = true;
        this.held++;
        this.holding.push(task);
      }
      void task.result();
    }
  }
}

export interface WalkOptions {
  readonly vfs: ProcessView;
  readonly cwd: string;
  readonly symlinks: SymlinkMode;
  readonly maxDepth: number;
  readonly minDepth: number;
  readonly depthFirst: boolean;
  readonly sameDevice: boolean;
  readonly ignoreVanished: boolean;
  /** Filesystem calls to run ahead of the visitor; 0 reads each thing when the visitor needs it. */
  readonly readAhead: number;
  /** Whether the expression reads stats, so entries' stats are worth reading ahead. */
  readonly prefetchStats: boolean;
  /**
   * Whether only what the walk already knows (-maxdepth, -xdev, a loop) can
   * keep it out of a subtree, so whole subtrees are read ahead. When the
   * expression can -prune, only the level below where the walk is.
   */
  readonly readAheadSubtrees: boolean;
  readonly signal: AbortSignal;
  /** A diagnostic, after `find: `. Every diagnostic also makes the exit status 1. */
  report(message: string): Promise<void>;
}

export type VisitResult = 'continue' | 'prune' | 'quit';

export interface Visitor {
  /**
   * Every fts event's depth, visited or not, in order; `newStart` marks a
   * start point's first. -execdir … + runs its batch where either changes.
   */
  event(depth: number, newStart: boolean): Promise<void>;
  visit(entry: FindEntry): Promise<VisitResult>;
}

/** A file the walk reached, with its stats and listing read once, on first need or ahead of it. */
export class FindEntry {
  private lstatTask: Task<ProcessStat | null> | null = null;
  private followTask: Task<ProcessStat | null> | null = null;
  private listingTask: Task<VfsDirent[]> | null = null;
  private childEntries: FindEntry[] | null = null;
  private statReported = false;

  constructor(
    private readonly walker: Walker,
    readonly key: Key,
    /** The path as find prints it. */
    readonly path: string,
    /** The path the filesystem resolves. */
    readonly absolute: string,
    /** What -name matches: the last component. */
    readonly name: string,
    readonly depth: number,
    readonly start: string,
    /** The type readdir gave (links not followed); null for a start point, whose type comes from its stat. */
    readonly direntType: VfsFileType | null,
    readonly parent: FindEntry | null,
  ) {}

  private get lstatWork(): Task<ProcessStat | null> {
    this.lstatTask ??= this.walker.statTask(this, false);
    return this.lstatTask;
  }

  private get followWork(): Task<ProcessStat | null> {
    this.followTask ??= this.walker.statTask(this, true);
    return this.followTask;
  }

  /** lstat(2): null when the file is gone. */
  lstat(): Promise<Outcome<ProcessStat | null>> {
    return this.lstatWork.result();
  }

  /** stat(2), links followed: null when nothing is at the end of them. */
  followed(): Promise<Outcome<ProcessStat | null>> {
    return this.followWork.result();
  }

  /** Whether this file is examined through its links (findutils' following_links). */
  get following(): boolean {
    return this.walker.options.symlinks === 'L' || (this.walker.options.symlinks === 'H' && this.depth === 0);
  }

  /** A start point written with a trailing slash names the directory a link leads to, as path resolution does. */
  private get forcesFollow(): boolean {
    return this.depth === 0 && this.start.length > 1 && this.start.endsWith('/');
  }

  /** Queue the stat xstat will need, to be read ahead of the walk. */
  prefetchStat(): void {
    this.walker.scheduler.ahead(this.following || this.forcesFollow ? this.followWork : this.lstatWork);
  }

  /**
   * The stat find examines (findutils' xstat): the link itself under -P,
   * its target under -L (or -H at depth 0), the link again when it dangles.
   */
  async xstat(): Promise<Outcome<ProcessStat>> {
    if (this.following || this.forcesFollow) {
      const followed = await this.followed();
      if (followed.ok && followed.value !== null) return { ok: true, value: followed.value };
      if (followed.ok || followed.error.code === 'ENOTDIR') {
        if (this.forcesFollow) return { ok: false, error: followed.ok ? syscallError('ENOENT', 'stat', this.path) : followed.error };
        return this.present(await this.lstat());
      }
      return followed;
    }
    return this.present(await this.lstat());
  }

  private present(outcome: Outcome<ProcessStat | null>): Outcome<ProcessStat> {
    if (!outcome.ok) return outcome;
    return outcome.value === null ? { ok: false, error: syscallError('ENOENT', 'lstat', this.path) } : { ok: true, value: outcome.value };
  }

  /**
   * The stat a predicate needs, or null after reporting why there is none
   * (once per file, as findutils' get_statinfo does).
   */
  async statForTest(): Promise<ProcessStat | null> {
    const outcome = await this.xstat();
    if (outcome.ok) return outcome.value;
    await this.reportStatError(outcome.error);
    return null;
  }

  async reportStatError(error: VfsError): Promise<void> {
    if (this.statReported) return;
    this.statReported = true;
    if (this.walker.options.ignoreVanished && error.code === 'ENOENT') return;
    await this.walker.report(`${quote(this.path)}: ${VFS_STRERROR[error.code]}`);
  }

  private get listingWork(): Task<VfsDirent[]> {
    this.listingTask ??= this.walker.listingTask(this);
    return this.listingTask;
  }

  /** Queue the listing, to be read ahead of the walk. */
  prefetchListing(): void {
    this.walker.scheduler.ahead(this.listingWork);
  }

  /**
   * The directory's names, for the walk and for -empty. Without read-ahead
   * every call reads the directory again, as GNU's -empty and fts each do.
   */
  listing(): Promise<Outcome<VfsDirent[]>> {
    if (!this.walker.scheduler.enabled) return settle(() => this.walker.options.vfs.readdir(this.absolute));
    return this.listingWork.result();
  }

  /** The entries of this directory's listing, made once for the walk and its read-ahead alike. */
  children(listing: readonly VfsDirent[]): FindEntry[] {
    if (this.childEntries !== null) return this.childEntries;
    const prefix = this.path.endsWith('/') ? this.path.slice(0, -1) : this.path;
    this.childEntries = listing.map((dirent, index) => new FindEntry(
      this.walker, [...this.key, index], `${prefix}/${dirent.name}`,
      this.absolute === '/' ? `/${dirent.name}` : `${this.absolute}/${dirent.name}`,
      dirent.name, this.depth + 1, this.start, dirent.type, this,
    ));
    return this.childEntries;
  }

  /** The listing, taken by the walk to descend: it no longer holds a place in the read-ahead window. */
  async takeListing(): Promise<Outcome<VfsDirent[]>> {
    const outcome = await this.listing();
    if (this.listingTask !== null) this.walker.scheduler.release(this.listingTask);
    return outcome;
  }

  /**
   * Whether the walk stats this file itself, as fts does: a start point, a
   * directory (to know it can be entered, and where it is), and a link it
   * follows. Every other file's type is what readdir said.
   */
  get statedByWalk(): boolean {
    return this.direntType === null || this.direntType === 'directory' || (this.direntType === 'symlink' && this.following);
  }

  /** The type the walk sees: a stat's, for what the walk stats; readdir's otherwise. A failed stat leaves it unknown. */
  async walkType(): Promise<Outcome<VfsFileType>> {
    if (this.direntType !== null && !this.statedByWalk) return { ok: true, value: this.direntType };
    const outcome = await this.xstat();
    return outcome.ok ? { ok: true, value: outcome.value.type } : outcome;
  }

  /** The directory -execdir runs a command for this file in, and the name it gives the command (findutils' record_exec_dir). */
  get execDirectory(): { directory: string; argument: string } {
    if (this.parent !== null) return { directory: this.parent.absolute, argument: `./${this.name}` };
    const base = baseName(this.start);
    const argument = base.startsWith('/') ? base : `./${base}`;
    // gnulib's mdir_name: what precedes the last component, without its trailing slashes.
    const trimmed = this.start.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const directory = trimmed === '' ? '/' : slash === -1 ? '.' : trimmed.slice(0, slash).replace(/\/+$/, '') || '/';
    return { directory: resolve(this.walker.options.cwd, directory), argument };
  }
}

export class Walker {
  readonly scheduler: Scheduler;
  private readonly readAheadDone = new WeakSet<FindEntry>();
  private failed = false;
  private quit = false;
  private newStart = false;

  constructor(readonly options: WalkOptions, private readonly visitor: Visitor) {
    this.scheduler = new Scheduler(options.readAhead);
  }

  private async event(depth: number): Promise<void> {
    const newStart = this.newStart;
    this.newStart = false;
    await this.visitor.event(depth, newStart);
  }

  /** Once every call the walk started, read ahead or not, has answered. */
  async settled(): Promise<void> {
    this.scheduler.stop();
    await this.scheduler.drained();
  }

  /** 0, or 1 once anything has gone wrong. */
  get status(): number {
    return this.failed ? 1 : 0;
  }

  async report(message: string): Promise<void> {
    this.failed = true;
    await this.options.report(message);
  }

  /** A failure the walk caused without a diagnostic of its own (a command that failed under -exec … +). */
  fail(): void {
    this.failed = true;
  }

  statTask(entry: FindEntry, follow: boolean): Task<ProcessStat | null> {
    return this.scheduler.task(entry.key, false, () => this.options.vfs.stat(entry.absolute, { follow }));
  }

  listingTask(entry: FindEntry): Task<VfsDirent[]> {
    return this.scheduler.task(entry.key, true, async () => {
      const listing = await this.options.vfs.readdir(entry.absolute);
      // A listing read for -empty is not one the walk enters; only the walk's own are read below.
      if (this.options.readAheadSubtrees && (await this.descends(entry))) this.readAhead(entry, entry.children(listing));
      return listing;
    });
  }

  /** Whether the walk descends into `entry`, by everything but -prune (which only the visit decides). */
  private async descends(entry: FindEntry): Promise<boolean> {
    if (entry.depth >= this.options.maxDepth) return false;
    const type = await entry.walkType();
    if (!type.ok || type.value !== 'directory') return false;
    if (this.options.sameDevice || this.options.symlinks !== 'P') {
      const stat = await entry.xstat();
      if (!stat.ok) return false;
      if (this.options.sameDevice && stat.value.dev !== (await this.rootDevice(entry))) return false;
      if (this.options.symlinks !== 'P' && (await this.cycleWith(entry, stat.value)) !== null) return false;
    }
    return true;
  }

  private async rootDevice(entry: FindEntry): Promise<number | null> {
    let root = entry;
    while (root.parent !== null) root = root.parent;
    const stat = await root.xstat();
    return stat.ok ? stat.value.dev : null;
  }

  /** The ancestor `stat` is the same directory as, when following links has led back to it. */
  private async cycleWith(entry: FindEntry, stat: ProcessStat): Promise<FindEntry | null> {
    for (let ancestor = entry.parent; ancestor !== null; ancestor = ancestor.parent) {
      const outcome = await ancestor.xstat();
      if (outcome.ok && outcome.value.dev === stat.dev && outcome.value.ino === stat.ino) return ancestor;
    }
    return null;
  }

  /** Walk every start point, until the last or until -quit or an abort ends the walk. */
  async run(startPoints: readonly string[]): Promise<void> {
    const starts = startPoints.length > 0 ? startPoints : ['.'];
    for (let i = 0; i < starts.length && !this.quit; i++) {
      const start = starts[i];
      const trimmed = start.replace(/\/+$/, '');
      const entry = new FindEntry(
        this, [i], start, resolve(this.options.cwd, start),
        trimmed === '' ? (start === '' ? '' : '/') : trimmed.slice(trimmed.lastIndexOf('/') + 1),
        0, start, null, null,
      );
      this.newStart = true;
      // fts reports a start point that is not there before anything else; an empty name is never there.
      const stat: Outcome<ProcessStat> = start === '' ? { ok: false, error: syscallError('ENOENT', 'stat', start) } : await entry.xstat();
      const failure = !stat.ok ? stat.error.code : start.length > 1 && start.endsWith('/') && stat.value.type !== 'directory' ? 'ENOTDIR' : null;
      if (failure !== null) {
        await this.event(0);
        await this.report(`${quote(start)}: ${VFS_STRERROR[failure]}`);
        continue;
      }
      await this.walk(entry);
    }
    this.scheduler.stop();
  }

  private async walk(entry: FindEntry): Promise<void> {
    if (this.options.signal.aborted) {
      this.stopWalk();
      return;
    }
    this.scheduler.advance(entry.key);
    const { options } = this;

    const type = await entry.walkType();
    if (!type.ok) {
      // A file fts cannot stat is reported, and visited with its type unknown; a link loop is not visited.
      await entry.reportStatError(type.error);
      if (type.error.code === 'ELOOP') return;
    }
    const isDirectory = type.ok && type.value === 'directory';
    if (isDirectory && options.symlinks !== 'P') {
      const stat = await entry.xstat();
      const ancestor = stat.ok ? await this.cycleWith(entry, stat.value) : null;
      if (ancestor !== null) {
        await this.event(entry.depth);
        await this.report(`File system loop detected; ${quote(entry.path)} is part of the same file system loop as ${quote(ancestor.path)}.`);
        return;
      }
    }

    await this.event(entry.depth);
    const visited = entry.depth >= options.minDepth;
    let prune = false;
    if (!options.depthFirst && visited) {
      const result = await this.visitor.visit(entry);
      if (result === 'quit') {
        this.stopWalk();
        return;
      }
      prune = result === 'prune';
    }

    if (isDirectory && !prune && entry.depth < options.maxDepth && (await this.descends(entry))) {
      const listing = await entry.takeListing();
      if (!listing.ok) {
        await this.report(`${quote(entry.path)}: ${VFS_STRERROR[listing.error.code]}`);
      } else {
        const children = entry.children(listing.value);
        if (this.scheduler.enabled) this.readAhead(entry, children);
        for (const child of children) {
          await this.walk(child);
          if (this.quit) return;
        }
      }
      await this.event(entry.depth);
    }

    if (options.depthFirst && visited) {
      if ((await this.visitor.visit(entry)) === 'quit') this.stopWalk();
    }
  }

  /**
   * Queue what the walk will want from these children: the stats it takes
   * (and the expression's, when it reads them), and the listings of the
   * directories it will descend into. Under -xdev only the stat says whether
   * a directory is on this device, and when links are followed only the
   * stats of its ancestors say whether it is one of them; then a probe queued
   * in its place reads those first, and never lists a directory on another
   * device or one the walk will refuse as a loop.
   */
  private readAhead(parent: FindEntry, children: readonly FindEntry[]): void {
    if (this.readAheadDone.has(parent)) return;
    this.readAheadDone.add(parent);
    const { options, scheduler } = this;
    const decidedByStats = options.sameDevice || options.symlinks !== 'P';
    for (const child of children) {
      if (options.prefetchStats || child.statedByWalk) child.prefetchStat();
      if (child.depth >= options.maxDepth) continue;
      if (child.direntType !== 'directory' && !(child.direntType === 'symlink' && child.following)) continue;
      if (!decidedByStats) {
        child.prefetchListing();
        continue;
      }
      scheduler.ahead(scheduler.task(child.key, false, async () => {
        if (await this.descends(child)) child.prefetchListing();
      }));
    }
  }

  private stopWalk(): void {
    this.quit = true;
    this.scheduler.stop();
  }
}
