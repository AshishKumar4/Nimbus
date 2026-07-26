import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
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
  private legacySymlinks: SymlinkRegistry;
  private vfs: CredentialedVfs;

  constructor(vfs: CredentialedVfs, private readonly rawVfs: SqliteVFS) {
    this.vfs = vfs;
    this.legacySymlinks = getSymlinkRegistry(rawVfs);
  }

  updateCredential(vfs: CredentialedVfs): void {
    this.vfs = vfs;
  }

  async stat(path: string, options: { followSymlinks?: boolean } = {}): Promise<RuntimeVfsStat | null> {
    const followSymlinks = options.followSymlinks !== false;
    const p = this.resolveDataPath(path, followSymlinks);
    if (!p) return null;
    if (!followSymlinks && !this.vfs.exists(p)) {
      const target = this.legacySymlinks.readlink(p);
      if (target === null) return null;
      const now = Date.now();
      return {
        type: 'symlink',
        size: new TextEncoder().encode(target).byteLength,
        ctime: now,
        atime: now,
        mtime: now,
        mode: 0o120777,
        uid: 1000,
        gid: 1000,
        revision: this.rawVfs.revision(p),
      };
    }
    try {
      const st = followSymlinks ? this.vfs.stat(p) : this.vfs.lstat(p);
      const type = st.type === 'directory'
        ? 'directory'
        : st.type === 'symlink'
          ? 'symlink'
          : 'file';
      return {
        type,
        size: st.size,
        ctime: st.ctime,
        atime: st.atime,
        mtime: st.mtime,
        mode: type === 'symlink' ? 0o120000 | (st.mode & 0o777) : st.mode,
        uid: st.uid,
        gid: st.gid,
        revision: this.rawVfs.revision(p),
      };
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async readFile(path: string, options: { followSymlinks?: boolean } = {}): Promise<Uint8Array | null> {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (!p) return null;
    try {
      return this.vfs.readFile(p);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async writeFile(
    path: string,
    bytes: string | Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): Promise<void> {
    const p = this.resolveMutationPath(path, true, 'write');
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
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async writeRange(
    path: string,
    offset: number,
    bytes: Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): Promise<number> {
    const p = this.resolveMutationPath(path, true, 'write');
    this.assertExpectedRevision(p, options.expectedRevision);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'write', path);
    if (options.createParents !== false) this.ensureParent(p);
    this.vfs.writeRange(p, offset, bytes);
    return bytes.byteLength;
  }

  async appendOnce(
    path: string,
    pid: number,
    writerId: string,
    operationId: number,
    digest: string,
    bytes: Uint8Array,
  ): Promise<number> {
    return this.vfs.appendOnce(path, pid, writerId, operationId, digest, bytes);
  }

  async acknowledgeAppend(pid: number, writerId: string, operationId: number): Promise<void> {
    this.vfs.acknowledgeAppend(pid, writerId, operationId);
  }

  async truncate(
    path: string,
    size: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<void> {
    const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'truncate');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'truncate', path);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'truncate', path);
    this.vfs.truncate(p, size);
  }

  async utimes(
    path: string,
    atimeMs: number,
    mtimeMs: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<void> {
    const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'utimes');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'utimes', path);
    this.vfs.utimes(p, atimeMs, mtimeMs);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const p = this.resolveMutationPath(path, true, 'chmod');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chmod', path);
    this.vfs.chmod(p, mode);
  }

  async access(path: string, mode: number): Promise<void> {
    this.vfs.access(normalizeVfsPath(path), mode);
  }

  async chown(
    path: string,
    uid: number,
    gid: number,
    options: { followSymlinks?: boolean } = {},
  ): Promise<void> {
    const followSymlinks = options.followSymlinks !== false;
    const p = this.resolveMutationPath(path, followSymlinks, 'chown');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chown', path);
    this.vfs.chown(p, uid, gid, { followSymlinks });
  }

  async open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle> {
    const normalizedFlags = normalizeOpenFlags(flags);
    const mutates = normalizedFlags.write || normalizedFlags.create ||
      normalizedFlags.truncate || normalizedFlags.append;
    const p = mutates
      ? this.resolveMutationPath(path, normalizedFlags.followSymlinks, 'open')
      : this.resolveDataPath(path, normalizedFlags.followSymlinks);
    if (p === null) throw fsError('ELOOP', 'open', path);
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
      baseRevision: this.rawVfs.revision(p),
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
    if (handle.baseRevision < this.rawVfs.revision(handle.path)) {
      throw fsError('ESTALE', 'write', handle.path);
    }
    const start = handle.flags.append
      ? (this.vfs.exists(handle.path) ? this.vfs.stat(handle.path).size : 0)
      : offset == null ? handle.position : Math.max(0, offset);
    this.vfs.writeRange(handle.path, start, bytes);
    const end = start + bytes.byteLength;
    if (offset == null || handle.flags.append) handle.position = end;
    handle.baseRevision = this.rawVfs.revision(handle.path);
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
    const entries = new Map<string, RuntimeVfsDirEntry>();
    for (const entry of this.vfs.readdir(p)) {
      const type = entry.type === 'directory'
        ? 'directory'
        : entry.type === 'symlink'
          ? 'symlink'
          : 'file';
      entries.set(entry.name, { name: entry.name, type });
    }
    const prefix = p ? `${p}/` : '';
    for (const link of this.legacySymlinks.list()) {
      if (parentVfsPath(link.link) !== p) continue;
      const name = link.link.slice(prefix.length);
      if (!entries.has(name)) entries.set(name, { name, type: 'symlink' });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): Promise<void> {
    const p = this.resolveMutationPath(path, false, 'mkdir');
    if (this.vfs.exists(p)) {
      if (options.recursive && this.vfs.isDirectory(p)) return;
      throw fsError('EEXIST', 'mkdir', path);
    }
    this.vfs.mkdir(p, { recursive: !!options.recursive });
  }

  async unlink(path: string): Promise<void> {
    const p = this.resolveMutationPath(path, false, 'unlink');
    if (this.vfs.exists(p)) {
      const staleLegacy = this.legacySymlinks.isSymlink(p);
      if (staleLegacy) this.legacySymlinks.assertMutable(p);
      this.vfs.unlink(p);
      if (staleLegacy) this.legacySymlinks.delete(p);
      return;
    }
    this.legacySymlinks.delete(p);
  }

  async rmdir(path: string): Promise<void> {
    const p = this.resolveMutationPath(path, false, 'rmdir');
    if (!this.vfs.isDirectory(p)) throw fsError('ENOTDIR', 'rmdir', path);
    this.vfs.rmdir(p);
  }

  async rename(from: string, to: string): Promise<void> {
    const oldPath = this.resolveMutationPath(from, false, 'rename');
    const newPath = this.resolveMutationPath(to, false, 'rename');
    if (this.vfs.exists(oldPath)) {
      const staleDestination = this.legacySymlinks.isSymlink(newPath);
      if (staleDestination) this.legacySymlinks.assertMutable(newPath);
      this.assertParentDirectory(newPath, 'rename');
      this.vfs.rename(oldPath, newPath);
      if (staleDestination) this.legacySymlinks.delete(newPath);
      return;
    }
    const linkTarget = this.legacySymlinks.readlink(oldPath);
    if (linkTarget === null) throw fsError('ENOENT', 'rename', from);
    const staleDestination = this.legacySymlinks.isSymlink(newPath);
    this.legacySymlinks.assertMutable(oldPath, ...(staleDestination ? [newPath] : []));
    this.assertParentDirectory(newPath, 'rename');
    if (this.vfs.exists(newPath)) {
      if (this.vfs.isDirectory(newPath)) throw fsError('EISDIR', 'rename', to);
      this.vfs.unlink(newPath);
    }
    this.vfs.symlink(linkTarget, newPath);
    this.legacySymlinks.delete(oldPath);
    if (staleDestination) this.legacySymlinks.delete(newPath);
  }

  async readlink(path: string): Promise<string | null> {
    const p = this.resolveDataPath(path, false);
    if (!p) return null;
    if (this.vfs.isSymlink(p)) return this.vfs.readlink(p);
    return this.legacySymlinks.readlink(p);
  }

  async symlink(target: string, path: string): Promise<void> {
    const p = this.resolveMutationPath(path, false, 'symlink');
    if (this.vfs.exists(p) || this.legacySymlinks.isSymlink(p)) {
      throw fsError('EEXIST', 'symlink', path);
    }
    this.ensureParent(p);
    this.vfs.symlink(target, p);
  }

  async fsync(): Promise<void> {
    // SqliteVFS writes are synchronously durable before their calls return.
  }

  async revision(path?: string): Promise<number> {
    if (path === undefined) return this.rawVfs.revision();
    const p = this.resolveDataPath(path, true) ?? normalizeVfsPath(path);
    return this.rawVfs.revision(p);
  }

  subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void {
    return this.rawVfs.events.onPath(normalizeVfsPath(path), listener);
  }

  private resolveDataPath(path: string, followSymlinks: boolean): string | null {
    const pending = normalizeVfsPath(path).split('/').filter(Boolean);
    const resolved: string[] = [];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const segment = pending.shift()!;
      const candidate = [...resolved, segment].join('/');
      const isFinal = pending.length === 0;
      if (!followSymlinks && isFinal) {
        resolved.push(segment);
        continue;
      }

      let target: string | null;
      if (this.vfs.isSymlink(candidate)) {
        target = this.vfs.resolveSymlink(candidate);
        if (target === null) return null;
      } else if (!this.vfs.exists(candidate)) {
        const legacyTarget = this.legacySymlinks.readlink(candidate);
        target = legacyTarget === null
          ? null
          : legacyTarget.startsWith('/')
            ? normalizeVfsPath(legacyTarget)
            : normalizeVfsPath(`${parentVfsPath(candidate)}/${legacyTarget}`);
      } else {
        target = null;
      }

      if (target === null) {
        resolved.push(segment);
        continue;
      }
      if (seen.has(candidate)) return null;
      seen.add(candidate);
      pending.unshift(...target.split('/').filter(Boolean));
      resolved.length = 0;
    }

    return resolved.join('/');
  }

  private resolveMutationPath(path: string, followSymlinks: boolean, syscall: string): string {
    this.rawVfs.assertMutationAllowed(normalizeVfsPath(path));
    const resolved = this.resolveDataPath(path, followSymlinks);
    if (resolved === null) throw fsError('ELOOP', syscall, path);
    return resolved;
  }

  private ensureParent(path: string): void {
    const parent = parentVfsPath(path);
    if (parent && !this.vfs.exists(parent)) this.vfs.mkdir(parent, { recursive: true });
  }

  private assertParentDirectory(path: string, syscall: string): void {
    const parent = parentVfsPath(path);
    if (!parent) return;
    if (!this.vfs.exists(parent)) throw fsError('ENOENT', syscall, path);
    if (!this.vfs.isDirectory(parent)) throw fsError('ENOTDIR', syscall, path);
  }

  private assertExpectedRevision(path: string, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return;
    if (expectedRevision !== this.rawVfs.revision(path)) {
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

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
