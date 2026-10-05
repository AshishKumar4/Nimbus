/**
 * git/worktree/walk.ts — the worktree against the index, one directory at a
 * time (git's diff-files and read_directory in one pass).
 *
 * A directory's listing is merged with the index entries below it, which are
 * one contiguous range of the sorted index: a tracked file is lstat'd and
 * matched as read-cache.c ie_match_stat matches it, a tracked directory is
 * entered, and what the listing has and the index does not is untracked,
 * checked against the exclude rules. Only entries that changed, and the
 * untracked paths, come back; a clean entry costs its lstat and nothing
 * else. Content is read only where the stat cannot decide: stat fields other
 * than the size moved, the entry is racily clean, or it was smudged.
 *
 * What is held is the listing of each directory on the current path, so
 * memory follows the tree's depth and its widest directory, not its size.
 */

import { createHash } from 'node:crypto';

import { oidToHex } from '../pack/format.js';
import { DirCache, EMPTY_BLOB, S_IFGITLINK, S_IFLNK, S_IFMT, S_IFREG, decodePath, objectId, type EntryStat } from './dircache.js';
import type { Excludes } from './excludes.js';

/** What a worktree lstat says (the VFS's stat, times in ms). */
export interface WorktreeStat extends EntryStat {
  type: 'file' | 'directory' | 'symlink' | 'other';
  mode: number;
}

export type WorktreeType = WorktreeStat['type'];

/** The worktree calls a walk makes, at repo-relative paths ('' is the top). */
export interface WorktreeFs {
  /** A directory's entries and their types; [] when it is not a directory. */
  list(dir: string): Promise<Array<{ name: string; type: WorktreeType }>>;
  lstat(path: string): Promise<WorktreeStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  /** Bytes [offset, offset + length), clipped to the file's end. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  readlink(path: string): Promise<string>;
}

/** What reading the worktree cost, for the measurements. */
export interface WalkCounters {
  readdirs: number;
  lstats: number;
  filesRead: number;
  bytesRead: number;
  /** Objects read from the store: trees, mostly. */
  objectsRead: number;
}

export function newCounters(): WalkCounters {
  return { readdirs: 0, lstats: 0, filesRead: 0, bytesRead: 0, objectsRead: 0 };
}

/** One worktree in its repository's terms. */
export interface Worktree {
  fs: WorktreeFs;
  /** core.filemode: the owner's exec bit is a change. */
  filemode: boolean;
  /** core.autocrlf=true: a valid UTF-8 file is hashed with CRLF as LF, as cf-git adds it. */
  autocrlf: boolean;
  counters: WalkCounters;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();


/** The bytes git would store for the worktree file or link at `path` (convert_to_git's share of it). */
export async function worktreeBlob(tree: Worktree, path: string, type: WorktreeType): Promise<Uint8Array> {
  tree.counters.filesRead++;
  if (type === 'symlink') return encoder.encode(await tree.fs.readlink(path));
  const data = await tree.fs.readFile(path);
  tree.counters.bytesRead += data.length;
  if (!tree.autocrlf) return data;
  try {
    return encoder.encode(textDecoder.decode(data).replace(/\r\n/g, '\n'));
  } catch {
    return data;
  }
}

/** A file is hashed this many bytes at a time, past this size: a big file is never held whole to be compared. */
const HASH_CHUNK = 1 << 20;

/** The id of the blob git would store for the file or link at `path`, `st` its lstat. */
export async function worktreeBlobId(tree: Worktree, path: string, st: WorktreeStat): Promise<string> {
  if (st.type !== 'file' || tree.autocrlf || st.size <= HASH_CHUNK) {
    return objectId('blob', await worktreeBlob(tree, path, st.type));
  }
  tree.counters.filesRead++;
  const hash = createHash('sha1').update(encoder.encode(`blob ${st.size}\0`));
  for (let offset = 0; offset < st.size;) {
    const chunk = await tree.fs.readRange(path, offset, Math.min(HASH_CHUNK, st.size - offset));
    // Shorter than its stat said: the file changed under the read, and so is not the blob.
    if (chunk.length === 0) return '';
    hash.update(chunk);
    offset += chunk.length;
    tree.counters.bytesRead += chunk.length;
  }
  return oidToHex(hash.digest());
}

/** The index mode of a worktree file (ce_mode_from_stat): without a trusted exec bit a file keeps `indexMode`. */
export function modeFromStat(stat: WorktreeStat, indexMode: number | undefined, filemode: boolean): number {
  if (stat.type === 'symlink') return S_IFLNK;
  if (!filemode && indexMode !== undefined && (indexMode & S_IFMT) === S_IFREG) return indexMode;
  return stat.mode & 0o100 ? 0o100755 : 0o100644;
}

// ce_match_stat_basic's verdicts.
const MTIME = 1;
const CTIME = 2;
const OWNER = 4;
const MODE = 8;
const INODE = 16;
const DATA = 32;
const TYPE = 64;

/** ce_match_stat_basic, in whole seconds (git without USE_NSEC), dev ignored (without USE_STDEV): 0 when the stat matches. */
export function matchStat(dc: DirCache, i: number, st: WorktreeStat, filemode: boolean): number {
  const mode = dc.mode(i);
  let changed = 0;
  switch (mode & S_IFMT) {
    case S_IFREG:
      if (st.type !== 'file') changed |= TYPE;
      if (filemode && ((mode ^ st.mode) & 0o100)) changed |= MODE;
      break;
    case S_IFLNK:
      if (st.type !== 'symlink') changed |= TYPE;
      break;
    case S_IFGITLINK:
      return st.type === 'directory' ? 0 : TYPE;
  }
  if (dc.mtimeSeconds(i) !== Math.floor(st.mtimeMs / 1000) % 0x100000000) changed |= MTIME;
  if (dc.ctimeSeconds(i) !== Math.floor(st.ctimeMs / 1000) % 0x100000000) changed |= CTIME;
  if (dc.uid(i) !== st.uid % 0x100000000 || dc.gid(i) !== st.gid % 0x100000000) changed |= OWNER;
  if (dc.ino(i) !== st.ino % 0x100000000) changed |= INODE;
  if (dc.size(i) !== st.size % 0x100000000) changed |= DATA;
  // A racily smudged entry: size 0 for a blob that is not empty.
  if (dc.size(i) === 0 && dc.oid(i) !== EMPTY_BLOB) changed |= DATA;
  return changed;
}

/** How a tracked entry differs from the worktree. */
export interface Dirty {
  /** M: content or exec bit; D: gone (or a directory where a file was); T: a file became a link, or back. */
  change: 'M' | 'D' | 'T';
  /** The worktree's lstat, absent for D. */
  stat: WorktreeStat | null;
  /** The worktree blob's id, when the walk hashed it. */
  oid?: string;
  /** D because a directory stands where the file was, not because nothing does. */
  directory?: boolean;
}

/**
 * refresh_cache_ent for one entry the worktree holds: null when it matches
 * (its stat refreshed in `dc` when the content had to decide), else how it
 * differs.
 */
export async function compareEntry(
  tree: Worktree, dc: DirCache, i: number, path: string, st: WorktreeStat, uncleanIsDirty = false,
): Promise<Dirty | null> {
  const changed = matchStat(dc, i, st, tree.filemode);
  if (changed & TYPE) return { change: 'T', stat: st };
  if (changed & MODE) return { change: 'M', stat: st };
  if ((dc.mode(i) & S_IFMT) === S_IFGITLINK) {
    dc.markUptodate(i);
    return null;
  }
  const racy = changed === 0 && dc.isRacy(i);
  if (changed === 0 && !racy) {
    dc.markUptodate(i);
    return null;
  }
  // The size moved on an entry that recorded one: modified, with nothing read. And, for git add,
  // any entry whose stat does not prove it clean: add_files_to_cache (DIFF_RACY_IS_MODIFIED) adds it again.
  if (((changed & DATA) && dc.size(i) !== 0) || uncleanIsDirty) return { change: 'M', stat: st };
  const oid = await worktreeBlobId(tree, path, st);
  if (oid !== dc.oid(i)) return { change: 'M', stat: st, oid: oid || undefined };
  dc.refresh(i, st);
  return null;
}

export interface ScanOptions {
  /** Repo-relative literal pathspecs; none, or '', is the whole tree. */
  specs?: readonly string[];
  /** Untracked files: none, collapsed to the directories holding them (git's normal), or each one. */
  untracked: 'no' | 'normal' | 'all';
  /** The exclude rules; null lists ignored paths as untracked too (ls-files -o without --exclude-standard). */
  excludes: Excludes | null;
  /** Ignored files are untracked too, each one (add -f). */
  ignoredToo?: boolean;
  /**
   * An entry whose stat does not prove it clean (stat moved, or racily clean)
   * is 'M' unhashed, for the caller to add again, as git add and commit -a
   * do: the entry takes fresh stat and its directories' cache trees go.
   */
  uncleanIsDirty?: boolean;
}

export interface ScanResult {
  /** Tracked entries that differ from the worktree, by entry number. */
  dirty: Map<number, Dirty>;
  /** Untracked paths in walk order; a directory ends in '/'. */
  untracked: string[];
}

/** One listing name's tracked kinds: a file entry, a directory of entries, a gitlink. */
const TRACKED_FILE = 1;
const TRACKED_DIR = 2;
const TRACKED_GITLINK = 4;

/**
 * diff-files and read_directory over the whole worktree (or `specs`):
 * every tracked entry that differs, and what is untracked. Unmerged entries
 * (stage > 0) are left to the caller; skip-worktree and assume-unchanged
 * entries are never looked at, as git never looks at them.
 */
export async function scanWorktree(tree: Worktree, dc: DirCache, options: ScanOptions): Promise<ScanResult> {
  const specs = (options.specs ?? []).includes('') ? [] : options.specs ?? [];
  const inScope = (path: string) => specs.length === 0 || specs.some((spec) => path === spec || path.startsWith(`${spec}/`));
  const onTheWay = (dir: string) => specs.some((spec) => spec.startsWith(`${dir}/`));
  const result: ScanResult = { dirty: new Map(), untracked: [] };
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const list = async (dir: string) => {
    tree.counters.readdirs++;
    return await tree.fs.list(dir);
  };

  const excluded = async (path: string, isDir: boolean) => options.excludes !== null && await options.excludes.isExcluded(path, isDir);

  /** -unormal's probe: anything untracked and not ignored below `dir`, a nested repository included. */
  const holdsUntracked = async (dir: string): Promise<boolean> => {
    for (const { name, type } of await list(dir)) {
      if (name === '.git') continue;
      const path = join(dir, name);
      if (type !== 'directory') {
        if (type !== 'other' && !await excluded(path, false)) return true;
        continue;
      }
      if (await excluded(path, true)) continue;
      if ((await list(path)).some((entry) => entry.name === '.git') || await holdsUntracked(path)) return true;
    }
    return false;
  };

  /**
   * An untracked path. A directory is listed whole ('dir/'), unless the
   * index holds a file at its name (`shadowed`): git drops such a name from
   * what it lists (index_name_is_other), though not the files below it.
   */
  const untracked = async (path: string, type: WorktreeType, shadowed = false): Promise<void> => {
    if (type === 'other') return;
    const ignored = await excluded(path, type === 'directory');
    if (ignored && !options.ignoredToo) return;
    if (type !== 'directory') {
      if (inScope(path)) result.untracked.push(path);
      return;
    }
    // A nested repository is listed as its directory, never entered.
    const entries = await list(path);
    if (entries.some((entry) => entry.name === '.git')) {
      if (inScope(path) && !shadowed) result.untracked.push(`${path}/`);
      return;
    }
    if (options.untracked === 'normal' && inScope(path) && !ignored) {
      if (!shadowed && await holdsUntracked(path)) result.untracked.push(`${path}/`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const child = join(path, entry.name);
      if (inScope(child) || (entry.type === 'directory' && onTheWay(child))) await untracked(child, entry.type);
    }
  };

  const deleted = (lo: number, hi: number) => {
    for (let i = lo; i < hi; i++) {
      if (dc.stage(i) !== 0 || dc.skipWorktree(i) || dc.assumeValid(i)) continue;
      if (inScope(dc.path(i))) result.dirty.set(i, { change: 'D', stat: null });
    }
  };

  const walk = async (dir: string, lo: number, hi: number): Promise<void> => {
    const listing = new Map<string, WorktreeType>();
    for (const { name, type } of await list(dir)) if (name !== '.git') listing.set(name, type);
    const tracked = new Map<string, number>();
    const skip = dir ? encoder.encode(dir).length + 1 : 0;
    for (let i = lo; i < hi;) {
      const rest = dc.pathBytes(i).subarray(skip);
      const slash = rest.indexOf(0x2f);
      if (slash >= 0) {
        // A directory: the run of entries below it.
        const name = decodePath(rest.subarray(0, slash));
        const path = join(dir, name);
        const [, end] = dc.rangeUnder(path, i, hi);
        tracked.set(name, (tracked.get(name) ?? 0) | TRACKED_DIR);
        if (inScope(path) || onTheWay(path)) {
          if (listing.get(name) === 'directory') await walk(path, i, end);
          else deleted(i, end);
        }
        i = end;
        continue;
      }
      const name = dc.path(i).slice(dir ? dir.length + 1 : 0);
      const path = join(dir, name);
      const gitlink = (dc.mode(i) & S_IFMT) === S_IFGITLINK;
      tracked.set(name, (tracked.get(name) ?? 0) | (gitlink ? TRACKED_GITLINK : TRACKED_FILE));
      let next = i + 1;
      while (next < hi && dc.stage(next) !== 0 && dc.path(next) === dc.path(i)) next++;
      if (dc.stage(i) === 0 && !dc.skipWorktree(i) && !dc.assumeValid(i) && inScope(path)) {
        const type = listing.get(name);
        if (type === undefined || (type === 'directory' && !gitlink)) {
          result.dirty.set(i, type === undefined ? { change: 'D', stat: null } : { change: 'D', stat: null, directory: true });
        } else {
          tree.counters.lstats++;
          const st = await tree.fs.lstat(path);
          const dirty = st === null ? { change: 'D' as const, stat: null } : await compareEntry(tree, dc, i, path, st, options.uncleanIsDirty);
          if (dirty) result.dirty.set(i, dirty);
        }
      }
      i = next;
    }
    if (options.untracked === 'no') return;
    for (const [name, type] of listing) {
      const kinds = tracked.get(name) ?? 0;
      // A gitlink owns whatever is at its path; a file entry a non-directory, a directory of entries a directory.
      if (kinds & TRACKED_GITLINK) continue;
      if (kinds & (type === 'directory' ? TRACKED_DIR : TRACKED_FILE)) continue;
      const path = join(dir, name);
      if (inScope(path) || (type === 'directory' && onTheWay(path))) await untracked(path, type, (kinds & TRACKED_FILE) !== 0);
    }
  };

  await walk('', 0, dc.count);
  return result;
}
