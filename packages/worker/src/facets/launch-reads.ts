/**
 * launch-reads.ts — what a launch's build asked the filesystem, so that the
 * module map it built can serve a later launch after writes it never read.
 *
 * The prefetch cache (facets/manager.ts prefetchBundleCache) kept a build
 * only while the session's global revision stayed where it was, and every
 * write moves that revision: a shell history line, or an agent's file tool
 * between two `node -e` runs. Measured 2026-10-23 on a throwaway (verdict
 * 20261023T005039-3f6a52332079): in an express project, a `node -e 1` after a
 * write elsewhere rebuilt its map every time, 1.6-2.5 s against 0.6 s for a
 * kept one.
 *
 * A build's answer depends on what it asked: each path it read, stat'ed,
 * resolved or probed (found or not, which is how a module resolves), and
 * each directory it listed. recordLaunchReads passes a build's bridge
 * through and notes those. A later change (the barrier's report since the
 * build's position, RuntimeFsBridge.acquire) leaves the build's answer as it
 * was unless it names one of them (staleReason):
 *   - a path the build asked about;
 *   - a directory above one, removed, renamed or given another mode or owner
 *     (a structural change, or a subtree's, moves what is under it);
 *   - a name made or removed in a directory the build listed, or one that
 *     changed kind (a listing answers names and kinds, not contents).
 * The barrier reports, beside each changed path, the directory it is in
 * (SqliteVFS's publication records the parent). For a directory the build
 * found there, that record says only that something in it changed, which
 * the record of the child itself answers, so it does not count as a change
 * to the directory the build stat'ed on its way down; otherwise every write
 * in the home directory would invalidate every build that resolved a path
 * under it. For a path the build did not find, it is the path being made,
 * and counts (a package installed where resolution looked first).
 * A build that enumerated the namespace, or that wrote, or that named a path
 * by a descriptor rather than by name, depends on everything.
 */
import type { Awaitable, RuntimeDirentType, RuntimeFsBridge, RuntimeFsPath, RuntimeVfsDirEntry, VfsInvalidatedPath } from '@nimbus-sh/core/runtime/os-contracts.js';

/** What a build asked the filesystem about, by the names the barrier reports (no leading or trailing slash). */
export interface LaunchReads {
  /** Each path it read, stat'ed, resolved or probed, found or not. */
  readonly paths: ReadonlySet<string>;
  /** Each directory it listed, with the names and kinds the listing answered (null: the listing failed). */
  readonly listed: ReadonlyMap<string, ReadonlyMap<string, RuntimeDirentType> | null>;
  /** The paths it asked about that were not there (an answer of null, or an error): a change that makes one counts. */
  readonly absent: ReadonlySet<string>;
  /** It enumerated the namespace, wrote, or named a path it cannot name here: any change may matter. */
  readonly whole: boolean;
}

/** A recording view of a bridge, and what was asked through it so far. */
export interface RecordedLaunchFs {
  readonly view: RuntimeFsBridge;
  reads(): LaunchReads;
}

const nameOf = (path: string): string => path.replace(/^\/+/, '').replace(/\/+$/, '');

/** `bridge`, passed through, noting what each call asks about (see the header). */
export function recordLaunchReads(bridge: RuntimeFsBridge): RecordedLaunchFs {
  const paths = new Set<string>();
  const listed = new Map<string, ReadonlyMap<string, RuntimeDirentType> | null>();
  const absent = new Set<string>();
  let whole = false;
  const read = (path: RuntimeFsPath | string): void => {
    if (typeof path === 'string') paths.add(nameOf(path));
    else whole = true;
  };
  /** `answer` to a question about `path`, noting the path absent when it answers null or fails. */
  const found = <T>(path: RuntimeFsPath, answer: () => Awaitable<T>): Awaitable<T> => {
    read(path);
    const missing = (): void => { if (typeof path === 'string') absent.add(nameOf(path)); };
    let value: Awaitable<T>;
    try {
      value = answer();
    } catch (error) {
      missing();
      throw error;
    }
    if (!(value instanceof Promise)) {
      if (value === null) missing();
      return value;
    }
    return value.then((settled) => {
      if (settled === null) missing();
      return settled;
    }, (error: Error) => {
      missing();
      throw error;
    });
  };
  /** A listing of `path`, noted with what it answered. */
  const list = (path: RuntimeFsPath, answer: () => Awaitable<RuntimeVfsDirEntry[]>): Awaitable<RuntimeVfsDirEntry[]> => {
    if (typeof path !== 'string') {
      whole = true;
      return answer();
    }
    const name = nameOf(path);
    const note = (entries: RuntimeVfsDirEntry[]): RuntimeVfsDirEntry[] => {
      listed.set(name, new Map(entries.map((entry) => [entry.name, entry.type])));
      return entries;
    };
    listed.set(name, null);
    return found(path, () => {
      const entries = answer();
      return entries instanceof Promise ? entries.then(note) : note(entries);
    });
  };
  /** A descriptor opened on `path`: it may read or list it. */
  const opened = (path: RuntimeFsPath): void => {
    read(path);
    if (typeof path === 'string') listed.set(nameOf(path), null);
  };
  /** A call whose answer this module cannot attribute to a name: the build depends on everything. */
  const everything = (): void => { whole = true; };
  const view: RuntimeFsBridge = {
    ...(bridge.gateLaunch !== undefined ? { gateLaunch: (...args) => bridge.gateLaunch!(...args) } : {}),
    stat: (...args) => found(args[0], () => bridge.stat(...args)),
    readFile: (...args) => found(args[0], () => bridge.readFile(...args)),
    writeFile: (...args) => { everything(); return bridge.writeFile(...args); },
    writeFileFrom: (...args) => { everything(); return bridge.writeFileFrom(...args); },
    readRange: (...args) => found(args[0], () => bridge.readRange(...args)),
    writeRange: (...args) => { everything(); return bridge.writeRange(...args); },
    truncate: (...args) => { everything(); return bridge.truncate(...args); },
    utimes: (...args) => { everything(); return bridge.utimes(...args); },
    chmod: (...args) => { everything(); return bridge.chmod(...args); },
    access: (...args) => found(args[0], () => bridge.access(...args)),
    chown: (...args) => { everything(); return bridge.chown(...args); },
    // A descriptor reads, or lists, what it was opened on.
    open: (...args) => { opened(args[0]); return bridge.open(...args); },
    reopen: (...args) => { everything(); return bridge.reopen(...args); },
    read: (...args) => bridge.read(...args),
    write: (...args) => { everything(); return bridge.write(...args); },
    close: (...args) => bridge.close(...args),
    readdir: (...args) => list(args[0], () => bridge.readdir(...args)),
    mkdir: (...args) => { everything(); return bridge.mkdir(...args); },
    unlink: (...args) => { everything(); return bridge.unlink(...args); },
    rmdir: (...args) => { everything(); return bridge.rmdir(...args); },
    rename: (...args) => { everything(); return bridge.rename(...args); },
    readlink: (...args) => found(args[0], () => bridge.readlink(...args)),
    linkLeadsTo: (...args) => { read(args[0]); read(args[1]); return bridge.linkLeadsTo(...args); },
    symlink: (...args) => { everything(); return bridge.symlink(...args); },
    fsync: (...args) => bridge.fsync(...args),
    revision: (...args) => { if (args[0] === undefined) everything(); else read(args[0]); return bridge.revision(...args); },
    ...(bridge.contentKey !== undefined ? { contentKey: (...args) => { read(args[0]); return bridge.contentKey!(...args); } } : {}),
    acquire: (...args) => bridge.acquire(...args),
    list: (...args) => { everything(); return bridge.list(...args); },
    ...(bridge.subscribe !== undefined ? { subscribe: (...args) => { read(args[0]); return bridge.subscribe!(...args); } } : {}),
    // Resolving a path reads each name on the way to it, which the ancestor rule covers.
    realpath: (...args) => found(args[0], () => bridge.realpath(...args)),
    remove: (...args) => { everything(); return bridge.remove(...args); },
    copyFile: (...args) => { everything(); return bridge.copyFile(...args); },
    copyTree: (...args) => { everything(); return bridge.copyTree(...args); },
    fstat: (...args) => bridge.fstat(...args),
    dup: (...args) => bridge.dup(...args),
    seek: (...args) => bridge.seek(...args),
    setStatus: (...args) => bridge.setStatus(...args),
    readdirHandle: (...args) => bridge.readdirHandle(...args),
    ftruncate: (...args) => { everything(); return bridge.ftruncate(...args); },
    fchmod: (...args) => { everything(); return bridge.fchmod(...args); },
    fchown: (...args) => { everything(); return bridge.fchown(...args); },
    futimes: (...args) => { everything(); return bridge.futimes(...args); },
    writeBatch: (...args) => { everything(); return bridge.writeBatch(...args); },
    writeStream: (...args) => { everything(); return bridge.writeStream(...args); },
    acquireExclusiveMutation: (...args) => { everything(); return bridge.acquireExclusiveMutation(...args); },
    releaseExclusiveMutation: (...args) => bridge.releaseExclusiveMutation(...args),
    awaitRecall: (...args) => bridge.awaitRecall(...args),
    recalled: (...args) => bridge.recalled(...args),
    published: (...args) => bridge.published(...args),
  };
  return { view, reads: () => ({ paths: new Set(paths), listed: new Map(listed), absent: new Set(absent), whole }) };
}

/**
 * Whether the build asked about a name under one of `mountPoints` (a mount
 * other than the session's own store). A mounted backend's files change
 * where the session's barrier may not see them, so such a build serves only
 * while nothing at all has changed, as every build did before this module.
 */
export function readsUnderMounts(reads: LaunchReads, mountPoints: readonly string[]): boolean {
  const points = mountPoints.map(nameOf).filter((point) => point !== '');
  if (points.length === 0) return false;
  return [...reads.paths, ...reads.listed.keys()].some((name) => points.some((point) => name === point || name.startsWith(point + '/')));
}

/**
 * What `reads` costs held, in UTF-16 bytes with a flat allowance for each
 * entry: the prefetch cache's bound prices an entry with it.
 */
export function launchReadsBytes(reads: LaunchReads): number {
  const each = (name: string): number => name.length * 2 + 48;
  let bytes = 0;
  for (const name of reads.paths) bytes += each(name);
  for (const name of reads.absent) bytes += each(name);
  for (const [name, listing] of reads.listed) {
    bytes += each(name);
    if (listing !== null) for (const entry of listing.keys()) bytes += each(entry);
  }
  return bytes;
}

/** Each directory above `name`, nearest first. */
function ancestorsOf(name: string): string[] {
  const out: string[] = [];
  for (let at = name.lastIndexOf('/'); at > 0; at = name.lastIndexOf('/', at - 1)) out.push(name.slice(0, at));
  // The root is above every name.
  out.push('');
  return out;
}

/** The directory `name` is in ('' for a name at the root). */
function parentOf(name: string): string {
  const at = name.lastIndexOf('/');
  return at === -1 ? '' : name.slice(0, at);
}

/** The kind a name has now, as a listing names it, or null when nothing is there. */
export type KindNow = (name: string) => Promise<RuntimeDirentType | null>;

/**
 * Why `changes` (a barrier's report since the build's cursor) can change
 * what a build that asked `reads` answers, or null when none of them can.
 * `kindNow` answers what is at a name in a directory the build listed, now,
 * which says whether the listing would answer the same.
 */
export async function staleReason(reads: LaunchReads, changes: readonly VfsInvalidatedPath[], kindNow: KindNow): Promise<string | null> {
  if (changes.length === 0) return null;
  if (reads.whole) return `${nameOf(changes[0]!.path)} changed, and the build enumerated or wrote`;
  // Every directory above a name the build asked about: a structural change there moves what is under it.
  const above = new Set<string>();
  for (const name of [...reads.paths, ...reads.listed.keys()]) for (const ancestor of ancestorsOf(name)) above.add(ancestor);
  // The directories the report names as the parent of another of its changes.
  const parents = new Set<string>();
  for (const change of changes) parents.add(parentOf(nameOf(change.path)));
  for (const change of changes) {
    const name = nameOf(change.path);
    if (change.structural === true || change.subtree === true) {
      if (reads.paths.has(name) || reads.listed.has(name) || above.has(name)) return `${name} was moved, removed or changed under, above or at what the build read`;
      continue;
    }
    // A name above what the build read, changed by itself rather than as the parent of a change in it: a symlink on the
    // way there retargeted (only a directory's change is structural).
    if (above.has(name) && !parents.has(name)) return `${name}, on the way to what the build read, changed`;
    // A path the build asked about, unless it found a directory there and the record is only the parent of another change.
    if (reads.paths.has(name) && (reads.absent.has(name) || !parents.has(name))) return `${name}, which the build ${reads.absent.has(name) ? 'did not find' : 'read'}, changed`;
    // A name in a directory the build listed: made, removed, or of another kind than the listing said.
    const parent = parentOf(name);
    if (!reads.listed.has(parent)) continue;
    const listing = reads.listed.get(parent);
    if (listing === null || listing === undefined) return `${name} changed in ${parent || '/'}, which the build listed without an answer to compare`;
    const leaf = name.slice(parent === '' ? 0 : parent.length + 1);
    const was = listing.get(leaf) ?? null;
    const now = await kindNow(name);
    if (was !== now) return `${name} in ${parent || '/'}, which the build listed, was ${was ?? 'absent'} and is ${now ?? 'absent'}`;
  }
  return null;
}
