/**
 * A filesystem held in memory: for tests, a bare embedder's /tmp, and
 * anything that needs a scratch tree with POSIX shape and no storage.
 *
 * Synchronous (its `sync` is itself), no credentials (one identity: its
 * entries carry the uid/gid given at construction), and its own revision per
 * entry so a cache over it can tell a change.
 *
 * Its feed (VFS.changes) is its journal: each path's newest change, the
 * removals among them (tombstones) kept no more than its tree has entries,
 * so the journal costs what the tree does, as a relist after a pruned
 * removal does. A cursor below the newest pruned removal is a poison.
 */
import type { VfsInvalidatedPath, VfsListEntry } from '../runtime/os-contracts.js';
import type { SyncVFS, VFS, VfsChanges, VfsDirent, VfsFileType, VfsStat } from './vfs.js';
import { pageOf, treeListing } from './immutable-changes.js';
import { runtimeStatOf } from './runtime-stat.js';
import { syscallError, type VfsError, type VfsErrorCode } from './vfs-error.js';
import { timeAt } from './posix-access.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';

type Entry = {
  /** Its number, its own for its life (a rename keeps it). */
  ino: number;
  data: Uint8Array;
  target: string;
  mode: number;
  mtimeMs: number;
  revision: number;
} & ({ type: 'directory'; children: Map<string, Entry> } | { type: Exclude<VfsFileType, 'directory'>; children: null });

const EMPTY = new Uint8Array(0);

/** One call as Node names it, for its errors: the syscall and the paths its caller gave. */
interface Call {
  syscall: string;
  path: string;
  dest?: string;
}

function fail(code: VfsErrorCode, call: Call): VfsError {
  return syscallError(code, call.syscall, call.path, { dest: call.dest });
}

export class MemoryVFS implements VFS {
  /** VFS.storesWrites: a regular file holds what it was written. */
  readonly storesWrites = true;
  private readonly root: Entry;
  private clock = 0;
  private inos = 0;
  /** Entries in its tree, its root among them: what bounds its tombstones. */
  private count = 0;
  /** Each changed path's newest change (absolute), in the order of their revisions; `gone`: a removal. */
  private readonly changed = new Map<string, { rev: number; structural: boolean; gone: boolean }>();
  private tombstones = 0;
  /** The newest pruned removal's revision: a cursor below it is a poison. */
  private floor = 0;
  private listed: { rev: number; entries: VfsListEntry[] } | null = null;
  private readonly epoch = `memory:${globalThis.crypto.randomUUID()}`;
  readonly sync: SyncVFS = this;
  readonly changes: VfsChanges;

  constructor(private readonly owner: { uid: number; gid: number } = { uid: 0, gid: 0 }) {
    this.root = this.entry('directory', 0o755);
    const vfs = this;
    this.changes = {
      epoch: this.epoch,
      revision: () => vfs.clock,
      since: (epoch, cursor, options) => vfs.since(epoch, cursor, options?.namespace === true),
      list: (after, limit) => {
        if (vfs.listed === null || vfs.listed.rev !== vfs.clock) vfs.listed = { rev: vfs.clock, entries: treeListing(vfs) };
        return pageOf(vfs.listed.entries, after, limit, vfs.epoch, vfs.clock);
      },
    };
  }

  private entry(type: VfsFileType, mode: number): Entry {
    const fields = {
      ino: ++this.inos, data: new Uint8Array(0), target: '', mode, mtimeMs: Date.now(), revision: ++this.clock,
    };
    this.count++;
    return type === 'directory' ? { type, ...fields, children: new Map<string, Entry>() } : { type, ...fields, children: null };
  }

  /** What changed since `cursor` of `epoch`: each path's newest change after it, with its lstat now where `stats`. */
  private since(epoch: string, cursor: number, stats: boolean): { epoch: string; rev: number; paths: VfsInvalidatedPath[]; poison: boolean } {
    const rev = this.clock;
    if (epoch !== this.epoch || cursor < this.floor || cursor > rev) return { epoch: this.epoch, rev, paths: [], poison: true };
    const paths: VfsInvalidatedPath[] = [];
    for (const [path, change] of this.changed) {
      if (change.rev <= cursor) continue;
      const entry: VfsInvalidatedPath = change.structural ? { path, rev: change.rev, structural: true } : { path, rev: change.rev };
      if (stats) {
        let stat: VfsStat | null = null;
        try { stat = this.stat(path, { follow: false }); } catch { stat = null; }
        entry.stat = stat === null ? null : runtimeStatOf(stat);
        if (stat?.type === 'symlink') entry.linkTarget = this.readlink(path);
      }
      paths.push(entry);
    }
    return { epoch: this.epoch, rev, paths, poison: false };
  }

  /** `path` changed now (`structural`: a directory removed, moved or given another mode; `gone`: nothing is there). */
  private note(path: string, structural = false, gone = false): void {
    const key = `/${rootClampedSegments(path).join('/')}`;
    const had = this.changed.get(key);
    if (had !== undefined) {
      this.changed.delete(key);
      if (had.gone) this.tombstones--;
    }
    this.changed.set(key, { rev: this.clock, structural, gone });
    if (!gone) return;
    this.tombstones++;
    // What was under a removed directory is covered by its removal, which is newer.
    if (structural) {
      const under = key === '/' ? '/' : `${key}/`;
      for (const [at, change] of this.changed) {
        if (at.startsWith(under)) {
          this.changed.delete(at);
          if (change.gone) this.tombstones--;
        }
      }
    }
    for (const [at, change] of this.changed) {
      if (this.tombstones <= this.count) break;
      if (!change.gone) continue;
      this.changed.delete(at);
      this.tombstones--;
      if (change.rev > this.floor) this.floor = change.rev;
    }
  }

  /** The entries `entry` holds, itself among them. */
  private static sizeOf(entry: Entry): number {
    let n = 1;
    if (entry.type === 'directory') for (const child of entry.children.values()) n += MemoryVFS.sizeOf(child);
    return n;
  }

  private touch(entry: Entry): void {
    entry.mtimeMs = Date.now();
    entry.revision = ++this.clock;
  }

  /** The entry at `path`, following symlinks except a final one when `follow` is false; `call` names a failure. */
  private find(path: string, call: Call, follow = true, hops = 0): Entry | null {
    const parts = rootClampedSegments(path);
    let at = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (at.type !== 'directory') throw fail('ENOTDIR', call);
      const next = at.children!.get(parts[i]!);
      if (next === undefined) return null;
      if (next.type === 'symlink' && (follow || i < parts.length - 1)) {
        if (hops >= 40) throw fail('ELOOP', call);
        const base = next.target.startsWith('/') ? '' : `/${parts.slice(0, i).join('/')}`;
        return this.find(`${base}/${next.target}/${parts.slice(i + 1).join('/')}`, call, follow, hops + 1);
      }
      at = next;
    }
    return at;
  }

  private parentOf(path: string, call: Call): { dir: Extract<Entry, { type: 'directory' }>; name: string } {
    const parts = rootClampedSegments(path);
    const name = parts.pop();
    if (name === undefined) throw syscallError('EBUSY', call.syscall, call.path, { dest: call.dest, detail: 'the root cannot be replaced' });
    const dir = this.find(`/${parts.join('/')}`, call);
    if (dir === null) throw fail('ENOENT', call);
    if (dir.type !== 'directory') throw fail('ENOTDIR', call);
    return { dir, name };
  }

  /** VFS.fileStore: its tree, whichever object (a wrapper of it) is asked. */
  get fileStore(): object {
    return this.root;
  }

  private stats(entry: Entry): VfsStat {
    return {
      ino: entry.ino,
      type: entry.type,
      size: entry.type === 'symlink' ? utf8Length(entry.target) : entry.data.length,
      mtimeMs: entry.mtimeMs,
      revision: entry.revision,
      mode: entry.mode,
      uid: this.owner.uid,
      gid: this.owner.gid,
    };
  }

  private file(path: string, call: Call): Entry {
    const entry = this.find(path, call);
    if (entry === null) throw fail('ENOENT', call);
    if (entry.type === 'directory') throw fail('EISDIR', call);
    return entry;
  }

  stat(path: string, options?: { follow?: boolean }): VfsStat | null {
    const entry = this.find(path, { syscall: options?.follow === false ? 'lstat' : 'stat', path }, options?.follow !== false);
    return entry === null ? null : this.stats(entry);
  }

  readFile(path: string): Uint8Array {
    return this.file(path, { syscall: 'open', path }).data.slice();
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.file(path, { syscall: 'open', path }).data.slice(offset, offset + length);
  }

  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): void {
    const call = { syscall: 'open', path };
    const bytes = data.slice();
    const existing = this.find(path, call);
    if (existing !== null) {
      if (existing.type === 'directory') throw fail('EISDIR', call);
      existing.data = bytes;
      this.touch(existing);
      this.note(path);
      return;
    }
    const { dir, name } = this.parentOf(path, call);
    const entry = this.entry('file', options?.mode ?? 0o644);
    entry.data = bytes;
    dir.children!.set(name, entry);
    this.touch(dir);
    this.note(path);
    this.note(`${path}/..`);
  }

  writeRange(path: string, offset: number, bytes: Uint8Array): void {
    const call = { syscall: 'open', path };
    if (this.find(path, call) === null) this.writeFile(path, EMPTY);
    const entry = this.file(path, call);
    const next = new Uint8Array(Math.max(entry.data.length, offset + bytes.length));
    next.set(entry.data);
    next.set(bytes, offset);
    entry.data = next;
    this.touch(entry);
    this.note(path);
  }

  truncate(path: string, size: number): void {
    const entry = this.file(path, { syscall: 'open', path });
    const next = new Uint8Array(size);
    next.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
    entry.data = next;
    this.touch(entry);
    this.note(path);
  }

  readdir(path: string): VfsDirent[] {
    const call = { syscall: 'scandir', path };
    const entry = this.find(path, call);
    if (entry === null) throw fail('ENOENT', call);
    if (entry.type !== 'directory') throw fail('ENOTDIR', call);
    return [...entry.children!].map(([name, child]) => ({ name, type: child.type, stat: this.stats(child) }));
  }

  /** With `recursive`, the directories it made, top down (VFS.mkdir). */
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): readonly string[] | void {
    const call = { syscall: 'mkdir', path };
    if (options?.recursive) {
      const made: string[] = [];
      let at = '';
      for (const part of rootClampedSegments(path)) {
        at += `/${part}`;
        const existing = this.find(at, call);
        if (existing === null) {
          this.mkdir(at, { mode: options.mode });
          made.push(at);
        } else if (existing.type !== 'directory') throw fail('ENOTDIR', call);
      }
      return made;
    }
    if (this.find(path, call, false) !== null) throw fail('EEXIST', call);
    const { dir, name } = this.parentOf(path, call);
    dir.children!.set(name, this.entry('directory', options?.mode ?? 0o755));
    this.touch(dir);
    this.note(path);
    this.note(`${path}/..`);
  }

  unlink(path: string): void {
    const call = { syscall: 'unlink', path };
    if (rootClampedSegments(path).length === 0) throw fail('EISDIR', call);
    const { dir, name } = this.parentOf(path, call);
    const entry = dir.children!.get(name);
    if (entry === undefined) throw fail('ENOENT', call);
    if (entry.type === 'directory') throw fail('EISDIR', call);
    dir.children!.delete(name);
    this.count--;
    this.touch(dir);
    this.note(path, false, true);
    this.note(`${path}/..`);
  }

  rmdir(path: string): void {
    const call = { syscall: 'rmdir', path };
    const { dir, name } = this.parentOf(path, call);
    const entry = dir.children!.get(name);
    if (entry === undefined) throw fail('ENOENT', call);
    if (entry.type !== 'directory') throw fail('ENOTDIR', call);
    if (entry.children.size > 0) throw fail('ENOTEMPTY', call);
    dir.children!.delete(name);
    this.count--;
    this.touch(dir);
    this.note(path, true, true);
    this.note(`${path}/..`);
  }

  removeRecursive(path: string): void {
    const call = { syscall: 'rm', path };
    const { dir, name } = this.parentOf(path, call);
    const entry = dir.children.get(name);
    if (entry === undefined) throw fail('ENOENT', call);
    dir.children.delete(name);
    this.count -= MemoryVFS.sizeOf(entry);
    this.touch(dir);
    this.note(path, entry.type === 'directory', true);
    this.note(`${path}/..`);
  }

  /**
   * POSIX rename(2): a file target is replaced; a directory replaces an empty
   * directory; onto itself, nothing changes.
   */
  rename(from: string, to: string): void {
    // Both parents are resolved before the source is looked up, as rename(2)
    // does: a bad component on either side is its error before ENOENT.
    const call = { syscall: 'rename', path: from, dest: to };
    const source = this.parentOf(from, call);
    const target = this.parentOf(to, call);
    const entry = source.dir.children!.get(source.name);
    if (entry === undefined) throw fail('ENOENT', call);
    const fromKey = rootClampedSegments(from).join('/');
    const toKey = rootClampedSegments(to).join('/');
    if (fromKey === toKey) return;
    if (entry.type === 'directory' && `${toKey}/`.startsWith(`${fromKey}/`)) {
      throw syscallError('EINVAL', 'rename', from, { dest: to, detail: 'a directory cannot move beneath itself' });
    }
    const replaced = target.dir.children!.get(target.name);
    if (replaced !== undefined) {
      if (entry.type === 'directory' && replaced.type !== 'directory') throw fail('ENOTDIR', call);
      if (entry.type !== 'directory' && replaced.type === 'directory') throw fail('EISDIR', call);
      if (replaced.type === 'directory' && replaced.children.size > 0) throw fail('ENOTEMPTY', call);
    }
    source.dir.children!.delete(source.name);
    target.dir.children!.set(target.name, entry);
    if (replaced !== undefined) this.count--;
    this.touch(source.dir);
    this.touch(target.dir);
    this.note(from, entry.type === 'directory', true);
    this.note(to, replaced?.type === 'directory');
    this.note(`${from}/..`);
    this.note(`${to}/..`);
  }

  symlink(target: string, path: string): void {
    const call = { syscall: 'symlink', path: target, dest: path };
    if (this.find(path, call, false) !== null) throw fail('EEXIST', call);
    const { dir, name } = this.parentOf(path, call);
    const entry = this.entry('symlink', 0o777);
    entry.target = target;
    dir.children!.set(name, entry);
    this.touch(dir);
    this.note(path);
    this.note(`${path}/..`);
  }

  readlink(path: string): string {
    const call = { syscall: 'readlink', path };
    const entry = this.find(path, call, false);
    if (entry === null) throw fail('ENOENT', call);
    if (entry.type !== 'symlink') throw fail('EINVAL', call);
    return entry.target;
  }

  chmod(path: string, mode: number): void {
    const call = { syscall: 'chmod', path };
    const entry = this.find(path, call);
    if (entry === null) throw fail('ENOENT', call);
    entry.mode = mode & 0o7777;
    this.touch(entry);
    this.note(path, entry.type === 'directory');
  }

  /** Its entries keep an mtime alone: the atime is taken and dropped. */
  utimes(path: string, _atime: FsTime, mtime: FsTime): void {
    const call = { syscall: 'utime', path };
    const entry = this.find(path, call);
    if (entry === null) throw fail('ENOENT', call);
    entry.mtimeMs = timeAt(mtime, entry.mtimeMs, Date.now());
    entry.revision = ++this.clock;
    this.note(path);
  }

  describe() {
    return { source: 'memory', type: 'tmpfs', options: ['rw'] };
  }
}
