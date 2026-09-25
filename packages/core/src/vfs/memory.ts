/**
 * A filesystem held in memory: for tests, a bare embedder's /tmp, and
 * anything that needs a scratch tree with POSIX shape and no storage.
 *
 * Synchronous (its `sync` is itself), no credentials (one identity: its
 * entries carry the uid/gid given at construction), and its own revision per
 * entry so a cache over it can tell a change.
 */
import type { SyncVFS, VFS, VfsDirent, VfsFileType, VfsStat } from './vfs.js';
import { VfsError } from './vfs-error.js';

interface Entry {
  type: VfsFileType;
  data: Uint8Array;
  target: string;
  mode: number;
  mtimeMs: number;
  revision: number;
  children: Map<string, Entry> | null;
}

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

function segments(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out;
}

export class MemoryVFS implements VFS {
  private readonly root: Entry;
  private clock = 0;
  readonly sync: SyncVFS = this as unknown as SyncVFS;

  constructor(private readonly owner: { uid: number; gid: number } = { uid: 0, gid: 0 }) {
    this.root = this.entry('directory', 0o755);
  }

  private entry(type: VfsFileType, mode: number): Entry {
    return {
      type, data: new Uint8Array(0), target: '', mode, mtimeMs: Date.now(), revision: ++this.clock,
      children: type === 'directory' ? new Map() : null,
    };
  }

  private touch(entry: Entry): void {
    entry.mtimeMs = Date.now();
    entry.revision = ++this.clock;
  }

  /** The entry at `path`, following symlinks except a final one when `follow` is false. */
  private find(path: string, follow = true, hops = 0): Entry | null {
    const parts = segments(path);
    let at = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (at.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
      const next = at.children!.get(parts[i]!);
      if (next === undefined) return null;
      if (next.type === 'symlink' && (follow || i < parts.length - 1)) {
        if (hops >= 40) throw new VfsError('ELOOP', 'too many symbolic links', path);
        const base = next.target.startsWith('/') ? '' : `/${parts.slice(0, i).join('/')}`;
        return this.find(`${base}/${next.target}/${parts.slice(i + 1).join('/')}`, follow, hops + 1);
      }
      at = next;
    }
    return at;
  }

  private parentOf(path: string): { dir: Entry; name: string } {
    const parts = segments(path);
    const name = parts.pop();
    if (name === undefined) throw new VfsError('EBUSY', 'the root cannot be replaced', path);
    const dir = this.find(`/${parts.join('/')}`);
    if (dir === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (dir.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
    return { dir, name };
  }

  private stats(entry: Entry): VfsStat {
    return {
      type: entry.type,
      size: entry.type === 'symlink' ? encoder.encode(entry.target).length : entry.data.length,
      mtimeMs: entry.mtimeMs,
      revision: entry.revision,
      mode: entry.mode,
      uid: this.owner.uid,
      gid: this.owner.gid,
    };
  }

  private file(path: string): Entry {
    const entry = this.find(path);
    if (entry === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (entry.type === 'directory') throw new VfsError('EISDIR', 'is a directory', path);
    return entry;
  }

  stat(path: string, options?: { follow?: boolean }): VfsStat | null {
    const entry = this.find(path, options?.follow !== false);
    return entry === null ? null : this.stats(entry);
  }

  readFile(path: string): Uint8Array {
    return this.file(path).data.slice();
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.file(path).data.slice(offset, offset + length);
  }

  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): void {
    const bytes = data.slice();
    const existing = this.find(path);
    if (existing !== null) {
      if (existing.type === 'directory') throw new VfsError('EISDIR', 'is a directory', path);
      existing.data = bytes;
      this.touch(existing);
      return;
    }
    const { dir, name } = this.parentOf(path);
    const entry = this.entry('file', options?.mode ?? 0o644);
    entry.data = bytes;
    dir.children!.set(name, entry);
    this.touch(dir);
  }

  writeRange(path: string, offset: number, bytes: Uint8Array): void {
    if (this.find(path) === null) this.writeFile(path, EMPTY);
    const entry = this.file(path);
    const next = new Uint8Array(Math.max(entry.data.length, offset + bytes.length));
    next.set(entry.data);
    next.set(bytes, offset);
    entry.data = next;
    this.touch(entry);
  }

  truncate(path: string, size: number): void {
    const entry = this.file(path);
    const next = new Uint8Array(size);
    next.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
    entry.data = next;
    this.touch(entry);
  }

  readdir(path: string): VfsDirent[] {
    const entry = this.find(path);
    if (entry === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (entry.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
    return [...entry.children!].map(([name, child]) => ({ name, type: child.type, stat: this.stats(child) }));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    if (options?.recursive) {
      let at = '';
      for (const part of segments(path)) {
        at += `/${part}`;
        const existing = this.find(at);
        if (existing === null) this.mkdir(at, { mode: options.mode });
        else if (existing.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', at);
      }
      return;
    }
    if (this.find(path, false) !== null) throw new VfsError('EEXIST', 'file exists', path);
    const { dir, name } = this.parentOf(path);
    dir.children!.set(name, this.entry('directory', options?.mode ?? 0o755));
    this.touch(dir);
  }

  unlink(path: string): void {
    if (segments(path).length === 0) throw new VfsError('EISDIR', 'is a directory', path);
    const { dir, name } = this.parentOf(path);
    const entry = dir.children!.get(name);
    if (entry === undefined) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (entry.type === 'directory') throw new VfsError('EISDIR', 'is a directory', path);
    dir.children!.delete(name);
    this.touch(dir);
  }

  rmdir(path: string): void {
    const { dir, name } = this.parentOf(path);
    const entry = dir.children!.get(name);
    if (entry === undefined) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (entry.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
    if (entry.children!.size > 0) throw new VfsError('ENOTEMPTY', 'directory not empty', path);
    dir.children!.delete(name);
    this.touch(dir);
  }

  removeRecursive(path: string): void {
    const { dir, name } = this.parentOf(path);
    if (!dir.children!.delete(name)) throw new VfsError('ENOENT', 'no such file or directory', path);
    this.touch(dir);
  }

  /**
   * POSIX rename(2): a file target is replaced; a directory replaces an empty
   * directory; onto itself, nothing changes.
   */
  rename(from: string, to: string): void {
    // Both parents are resolved before the source is looked up, as rename(2)
    // does: a bad component on either side is its error before ENOENT.
    const source = this.parentOf(from);
    const target = this.parentOf(to);
    const entry = source.dir.children!.get(source.name);
    if (entry === undefined) throw new VfsError('ENOENT', 'no such file or directory', from);
    const fromKey = segments(from).join('/');
    const toKey = segments(to).join('/');
    if (fromKey === toKey) return;
    if (entry.type === 'directory' && `${toKey}/`.startsWith(`${fromKey}/`)) {
      throw new VfsError('EINVAL', 'a directory cannot move beneath itself', to);
    }
    const replaced = target.dir.children!.get(target.name);
    if (replaced !== undefined) {
      if (entry.type === 'directory' && replaced.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', to);
      if (entry.type !== 'directory' && replaced.type === 'directory') throw new VfsError('EISDIR', 'is a directory', to);
      if (replaced.type === 'directory' && replaced.children!.size > 0) throw new VfsError('ENOTEMPTY', 'directory not empty', to);
    }
    source.dir.children!.delete(source.name);
    target.dir.children!.set(target.name, entry);
    this.touch(source.dir);
    this.touch(target.dir);
  }

  symlink(target: string, path: string): void {
    if (this.find(path, false) !== null) throw new VfsError('EEXIST', 'file exists', path);
    const { dir, name } = this.parentOf(path);
    const entry = this.entry('symlink', 0o777);
    entry.target = target;
    dir.children!.set(name, entry);
    this.touch(dir);
  }

  readlink(path: string): string {
    const entry = this.find(path, false);
    if (entry === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    if (entry.type !== 'symlink') throw new VfsError('EINVAL', 'not a symbolic link', path);
    return entry.target;
  }

  chmod(path: string, mode: number): void {
    const entry = this.find(path);
    if (entry === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    entry.mode = mode & 0o7777;
    this.touch(entry);
  }

  utimes(path: string, _atimeMs: number, mtimeMs: number): void {
    const entry = this.find(path);
    if (entry === null) throw new VfsError('ENOENT', 'no such file or directory', path);
    entry.mtimeMs = mtimeMs;
    entry.revision = ++this.clock;
  }

  describe() {
    return { source: 'memory', type: 'tmpfs', options: ['rw'] };
  }
}
