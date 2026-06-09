import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry, type SymlinkRegistry } from '../vfs/symlink-registry.js';
import type {
  RuntimeFileHandle,
  RuntimeFsBridge,
  RuntimeOpenFlags,
  RuntimeVfsDirEntry,
  RuntimeVfsStat,
} from './os-contracts.js';

export class SqliteRuntimeFsBridge implements RuntimeFsBridge {
  private nextHandleId = 1;
  private handles = new Map<number, RuntimeFileHandle>();
  private symlinks: SymlinkRegistry;

  constructor(private readonly vfs: SqliteVFS) {
    this.symlinks = getSymlinkRegistry(vfs);
  }

  async stat(path: string, options: { followSymlinks?: boolean } = {}): Promise<RuntimeVfsStat | null> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p) return null;
    if (this.symlinks.isSymlink(p) && options.followSymlinks === false) {
      const target = this.symlinks.readlink(p) || '';
      const now = Date.now();
      return {
        type: 'symlink',
        size: new TextEncoder().encode(target).byteLength,
        ctime: now,
        atime: now,
        mtime: now,
        mode: 0o777,
        revision: this.vfs.revision(p),
      };
    }
    try {
      const st = this.vfs.stat(p);
      return {
        type: st.type === 'directory' ? 'directory' : 'file',
        size: st.size,
        ctime: st.ctime,
        atime: st.atime,
        mtime: st.mtime,
        mode: st.mode,
        revision: this.vfs.revision(p),
      };
    } catch {
      return null;
    }
  }

  async readFile(path: string, options: { followSymlinks?: boolean } = {}): Promise<Uint8Array | null> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p) return null;
    try {
      return this.vfs.readFile(p);
    } catch {
      return null;
    }
  }

  async writeFile(
    path: string,
    bytes: string | Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): Promise<void> {
    const p = this.resolveDataPath(path, true) || normalizeVfsPath(path);
    this.assertExpectedRevision(p, options.expectedRevision);
    if (options.createParents !== false) this.ensureParent(p);
    this.vfs.writeFile(p, bytes);
  }

  async readRange(
    path: string,
    offset: number,
    length: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<Uint8Array | null> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p) return null;
    try {
      return this.vfs.readRange(p, offset, length);
    } catch {
      return null;
    }
  }

  async writeRange(
    path: string,
    offset: number,
    bytes: Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): Promise<number> {
    const p = this.resolveDataPath(path, true) || normalizeVfsPath(path);
    this.assertExpectedRevision(p, options.expectedRevision);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'write', path);
    if (options.createParents !== false) this.ensureParent(p);
    this.vfs.writeRange(p, offset, bytes);
    return bytes.byteLength;
  }

  async truncate(
    path: string,
    size: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<void> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p || !this.vfs.exists(p)) throw fsError('ENOENT', 'truncate', path);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'truncate', path);
    this.vfs.truncate(p, size);
  }

  async utimes(
    path: string,
    atimeMs: number,
    mtimeMs: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<void> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p || !this.vfs.exists(p)) throw fsError('ENOENT', 'utimes', path);
    this.vfs.utimes(p, atimeMs, mtimeMs);
  }

  async open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle> {
    const normalizedFlags = normalizeOpenFlags(flags);
    const p = this.resolveDataPath(path, normalizedFlags.followSymlinks) || normalizeVfsPath(path);
    this.assertExpectedRevision(p, normalizedFlags.expectedRevision);

    const exists = this.vfs.exists(p);
    if (!exists && !normalizedFlags.create) throw fsError('ENOENT', 'open', path);
    if (exists && this.vfs.isDirectory(p)) throw fsError('EISDIR', 'open', path);
    if (!exists) {
      this.ensureParent(p);
      this.vfs.writeFile(p, new Uint8Array(0));
    } else if (normalizedFlags.truncate) {
      this.vfs.truncate(p, 0);
    }

    const stat = this.vfs.stat(p);
    const handle: RuntimeFileHandle = {
      id: this.nextHandleId++,
      path: p,
      flags: normalizedFlags,
      position: normalizedFlags.append ? stat.size : 0,
      baseRevision: this.vfs.revision(p),
      closed: false,
    };
    this.handles.set(handle.id, handle);
    return { ...handle };
  }

  async read(handleId: number, offset: number | null, length: number): Promise<Uint8Array> {
    const handle = this.getHandle(handleId);
    if (!handle.flags.read) throw fsError('EBADF', 'read', handle.path);
    const start = offset == null ? handle.position : Math.max(0, offset);
    const out = this.vfs.readRange(handle.path, start, Math.max(0, length));
    if (offset == null) handle.position = start + out.byteLength;
    return out;
  }

  async write(handleId: number, offset: number | null, bytes: Uint8Array): Promise<number> {
    const handle = this.getHandle(handleId);
    if (!handle.flags.write) throw fsError('EBADF', 'write', handle.path);
    if (handle.baseRevision < this.vfs.revision(handle.path)) {
      throw fsError('ESTALE', 'write', handle.path);
    }
    const start = handle.flags.append
      ? (this.vfs.exists(handle.path) ? this.vfs.stat(handle.path).size : 0)
      : offset == null ? handle.position : Math.max(0, offset);
    this.vfs.writeRange(handle.path, start, bytes);
    const end = start + bytes.byteLength;
    if (offset == null || handle.flags.append) handle.position = end;
    handle.baseRevision = this.vfs.revision(handle.path);
    return bytes.byteLength;
  }

  async close(handleId: number): Promise<void> {
    const handle = this.getHandle(handleId);
    handle.closed = true;
    this.handles.delete(handleId);
  }

  async readdir(path: string, options: { followSymlinks?: boolean } = {}): Promise<RuntimeVfsDirEntry[]> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p) return [];
    const entries: RuntimeVfsDirEntry[] = this.vfs.readdir(p).map((entry) => ({
      name: entry.name,
      type: entry.type === 'directory' ? 'directory' as const : 'file' as const,
    }));
    const prefix = p ? `${p}/` : '';
    for (const link of this.symlinks.list()) {
      if (parentVfsPath(link.link) !== p) continue;
      entries.push({ name: link.link.slice(prefix.length), type: 'symlink' });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): Promise<void> {
    this.vfs.mkdir(normalizeVfsPath(path), { recursive: !!options.recursive });
  }

  async unlink(path: string): Promise<void> {
    const p = normalizeVfsPath(path);
    if (this.symlinks.delete(p)) return;
    this.vfs.unlink(p);
  }

  async rmdir(path: string): Promise<void> {
    this.vfs.rmdir(normalizeVfsPath(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const oldPath = normalizeVfsPath(from);
    const newPath = normalizeVfsPath(to);
    const linkTarget = this.symlinks.readlink(oldPath);
    if (linkTarget !== null) {
      this.symlinks.delete(oldPath);
      this.symlinks.set(newPath, linkTarget);
      return;
    }
    this.ensureParent(newPath);
    this.vfs.rename(oldPath, newPath);
  }

  async readlink(path: string): Promise<string | null> {
    return this.symlinks.readlink(normalizeVfsPath(path));
  }

  async symlink(target: string, path: string): Promise<void> {
    const p = normalizeVfsPath(path);
    this.ensureParent(p);
    this.symlinks.set(p, target);
  }

  async fsync(): Promise<void> {
    this.vfs.flushAll();
  }

  async revision(path?: string): Promise<number> {
    if (path === undefined) return this.vfs.revision();
    const p = this.resolveDataPath(path, true) ?? normalizeVfsPath(path);
    return this.vfs.revision(p);
  }

  subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void {
    return this.vfs.events.onPath(normalizeVfsPath(path), listener);
  }

  private resolveDataPath(path: string, followSymlinks: boolean): string | null {
    const p = normalizeVfsPath(path);
    if (!followSymlinks) return p;
    return this.symlinks.resolveChain(p);
  }

  private ensureParent(path: string): void {
    const parent = parentVfsPath(path);
    if (parent && !this.vfs.exists(parent)) this.vfs.mkdir(parent, { recursive: true });
  }

  private assertExpectedRevision(path: string, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return;
    if (expectedRevision !== this.vfs.revision(path)) {
      throw fsError('ESTALE', 'write', `revision ${expectedRevision}`);
    }
  }

  private getHandle(handleId: number): RuntimeFileHandle {
    const handle = this.handles.get(handleId);
    if (!handle || handle.closed) throw fsError('EBADF', 'fd', String(handleId));
    return handle;
  }
}

function normalizeOpenFlags(flags: RuntimeOpenFlags): RuntimeFileHandle['flags'] {
  return {
    read: !!flags.read || !flags.write,
    write: !!flags.write,
    append: !!flags.append,
    create: !!flags.create,
    truncate: !!flags.truncate,
    followSymlinks: flags.followSymlinks !== false,
    expectedRevision: flags.expectedRevision,
  };
}

function fsError(code: string, syscall: string, path: string): Error {
  const err: any = new Error(`${code}: ${syscall} '${path}'`);
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}
