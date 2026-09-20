import type { CredentialedVfs, SqliteVFS, VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry, type SymlinkRegistry } from '../vfs/symlink-registry.js';
import type {
  RuntimeFileHandle,
  RuntimeFsPath,
  RuntimeReadOptions,
  RuntimeSynchronousFs,
  RuntimeFsBridge,
  RuntimeOpenFlags,
  RuntimeVfsDirEntry,
  RuntimeVfsStat,
  VfsAcquireResult,
  VfsListPage,
} from './os-contracts.js';

interface OpenDescription {
  handle: RuntimeFileHandle;
  node: VfsOpenDescription;
  refs: number;
}

export interface SqliteDescriptorScope {
  nextId: number;
  handles: Map<number, OpenDescription>;
  closed: boolean;
}

export function createSqliteDescriptorScope(): SqliteDescriptorScope {
  return { nextId: 1, handles: new Map(), closed: false };
}

export class SqliteRuntimeFsBridge implements RuntimeFsBridge {
  readonly synchronous: RuntimeSynchronousFs = this;
  private legacySymlinks: SymlinkRegistry;
  private readonly vfs: CredentialedVfs;

  constructor(vfs: CredentialedVfs, private readonly rawVfs: SqliteVFS, private readonly scope = createSqliteDescriptorScope()) {
    this.vfs = vfs;
    this.legacySymlinks = getSymlinkRegistry(rawVfs);
  }

  dispose(): void {
    for (const id of this.scope.handles.keys()) this.close(id);
    this.scope.closed = true;
  }

  stat(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsStat | null {
    const followSymlinks = options.followSymlinks !== false;
    const p = this.resolveDataPath(path, followSymlinks);
    if (p === null) return null;
    if (!followSymlinks && !this.vfs.exists(p)) {
      const target = this.legacySymlinks.readlink(p);
      if (target === null) return null;
      throw fsError('ENOTSUP', 'stat legacy symlink', path);
    }
    try {
      const st = followSymlinks ? this.vfs.stat(p) : this.vfs.lstat(p);
      const type = st.type === 'directory'
        ? 'directory'
        : st.type === 'symlink'
          ? 'symlink'
          : 'file';
      return {
        dev: st.dev, ino: st.ino, nlink: st.nlink,
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

  readFile(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): Uint8Array | null {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (p === null) return null;
    try {
      return this.vfs.readFile(p);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  writeFile(
    path: RuntimeFsPath,
    bytes: string | Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): number {
    const p = this.resolveMutationPath(path, true, 'write');
    this.assertExpectedRevision(p, options.expectedRevision);
    if (options.createParents !== false) this.ensureParent(p);
    this.vfs.writeFile(p, bytes);
    // Read back in the same synchronous turn as the mutation, so nothing can
    // interleave: this is exactly the revision this write produced. Asking
    // again after an await would report a peer's clock as our own.
    return this.rawVfs.revision();
  }

  readRange(
    path: RuntimeFsPath,
    offset: number,
    length: number,
    options: RuntimeReadOptions = {},
  ): Uint8Array | null {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (p === null) return null;
    if ((options.expectedEpoch === undefined) !== (options.expectedRevision === undefined)) {
      throw fsError('EINVAL', 'read', path);
    }
    if (options.expectedEpoch !== undefined && (options.expectedEpoch !== this.rawVfs.epoch
      || options.expectedRevision !== this.rawVfs.revision())) {
      throw fsError('ESTALE', 'read', path);
    }
    try {
      return options.cached === false
        ? this.vfs.readRangeUncached(p, offset, length)
        : this.vfs.readRange(p, offset, length);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  writeRange(
    path: RuntimeFsPath,
    offset: number,
    bytes: Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): number {
    const p = this.resolveMutationPath(path, true, 'write');
    this.assertExpectedRevision(p, options.expectedRevision);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'write', path);
    if (options.createParents !== false) this.ensureParent(p);
    this.vfs.writeRange(p, offset, bytes);
    return bytes.byteLength;
  }

  appendOnce(
    path: RuntimeFsPath,
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
    digest: string,
    bytes: Uint8Array,
  ): number {
    return this.vfs.appendOnce(this.pathArgument(path), pid, writerId, moduleId, operationId, digest, bytes);
  }

  acknowledgeAppend(
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
  ): void {
    this.vfs.acknowledgeAppend(pid, writerId, moduleId, operationId);
  }

  truncate(
    path: RuntimeFsPath,
    size: number,
    options: { followSymlinks?: boolean } = {},
  ): void {
    const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'truncate');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'truncate', path);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'truncate', path);
    this.vfs.truncate(p, size);
  }

  utimes(
    path: RuntimeFsPath,
    atimeMs: number,
    mtimeMs: number,
    options: { followSymlinks?: boolean } = {},
  ): void {
    const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'utimes');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'utimes', path);
    this.vfs.utimes(p, atimeMs, mtimeMs);
  }

  chmod(path: RuntimeFsPath, mode: number): void {
    const p = this.resolveMutationPath(path, true, 'chmod');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chmod', path);
    this.vfs.chmod(p, mode);
  }

  access(path: RuntimeFsPath, mode: number): void {
    this.vfs.access(this.pathArgument(path), mode);
  }

  chown(
    path: RuntimeFsPath,
    uid: number,
    gid: number,
    options: { followSymlinks?: boolean } = {},
  ): void {
    const followSymlinks = options.followSymlinks !== false;
    const p = this.resolveMutationPath(path, followSymlinks, 'chown');
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chown', path);
    this.vfs.chown(p, uid, gid, { followSymlinks });
  }

  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle {
    const normalizedFlags = normalizeOpenFlags(flags);
    const mutates = normalizedFlags.write || normalizedFlags.create ||
      normalizedFlags.truncate || normalizedFlags.append;
    const p = mutates
      ? this.resolveMutationPath(path, normalizedFlags.followSymlinks, 'open')
      : this.resolveDataPath(path, normalizedFlags.followSymlinks);
    if (p === null) throw fsError('ELOOP', 'open', path);
    this.assertExpectedRevision(p, normalizedFlags.expectedRevision);

    const exists = this.vfs.exists(p);
    if (normalizedFlags.exclusive && normalizedFlags.create && exists) throw fsError('EEXIST', 'open', path);
    if (normalizedFlags.directory && (!exists || !this.vfs.isDirectory(p))) throw fsError('ENOTDIR', 'open', path);
    if (!exists && !normalizedFlags.create) throw fsError('ENOENT', 'open', path);
    if (exists && this.vfs.isDirectory(p) && mutates) throw fsError('EISDIR', 'open', path);
    if (exists) this.vfs.access(p, (normalizedFlags.read ? 4 : 0) | (normalizedFlags.write ? 2 : 0));
    if (!exists) {
      this.ensureParent(p);
      this.vfs.writeFile(p, new Uint8Array(0));
    } else if (normalizedFlags.truncate) {
      this.vfs.truncate(p, 0);
    }

    const stat = this.vfs.stat(p);
    const handle: RuntimeFileHandle = {
      id: this.scope.nextId++,
      path: p,
      flags: Object.freeze(normalizedFlags),
      position: normalizedFlags.append ? stat.size : 0,
      baseRevision: this.rawVfs.revision(p),
      closed: false,
    };
    this.scope.handles.set(handle.id, { handle, node: this.rawVfs.openDescription(p, this.vfs.cred, normalizedFlags), refs: 1 });
    return { ...handle };
  }

  read(handleId: number, offset: number | null, length: number): Uint8Array {
    const handle = this.getHandle(handleId);
    if (!handle.flags.read) throw fsError('EBADF', 'read', handle.path);
    const start = offset == null ? handle.position : Math.max(0, offset);
    const out = this.description(handleId).node.read(start, Math.max(0, length));
    if (offset == null) handle.position = start + out.byteLength;
    return out;
  }

  write(handleId: number, offset: number | null, bytes: Uint8Array): number {
    const handle = this.getHandle(handleId);
    if (!handle.flags.write) throw fsError('EBADF', 'write', handle.path);
    const start = handle.flags.append
      ? this.description(handleId).node.stat().size
      : offset == null ? handle.position : Math.max(0, offset);
    this.description(handleId).node.write(start, bytes);
    const end = start + bytes.byteLength;
    if (offset == null || handle.flags.append) handle.position = end;
    handle.baseRevision = this.rawVfs.revision(handle.path);
    return bytes.byteLength;
  }

  close(handleId: number): void {
    const opened = this.description(handleId);
    this.scope.handles.delete(handleId);
    if (--opened.refs === 0) { opened.handle.closed = true; opened.node.close(); }
  }

  readdir(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsDirEntry[] {
    const p = this.resolveDataPath(path, options.followSymlinks !== false);
    if (p === null) return [];
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

  mkdir(path: RuntimeFsPath, options: { recursive?: boolean; mode?: number } = {}): void {
    const p = this.resolveMutationPath(path, false, 'mkdir');
    if (this.vfs.exists(p)) {
      if (options.recursive && this.vfs.isDirectory(p)) return;
      throw fsError('EEXIST', 'mkdir', path);
    }
    this.vfs.mkdir(p, { recursive: !!options.recursive, mode: options.mode });
  }

  unlink(path: RuntimeFsPath): void {
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

  rmdir(path: RuntimeFsPath): void {
    const p = this.resolveMutationPath(path, false, 'rmdir');
    if (!this.vfs.isDirectory(p)) throw fsError('ENOTDIR', 'rmdir', path);
    this.vfs.rmdir(p);
  }

  rename(from: RuntimeFsPath, to: RuntimeFsPath): void {
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

  readlink(path: RuntimeFsPath): string | null {
    const p = this.resolveDataPath(path, false);
    if (p === null) return null;
    if (this.vfs.isSymlink(p)) return this.vfs.readlink(p);
    return this.legacySymlinks.readlink(p);
  }

  symlink(target: string, path: RuntimeFsPath): void {
    const p = this.resolveMutationPath(path, false, 'symlink');
    if (this.vfs.exists(p) || this.legacySymlinks.isSymlink(p)) {
      throw fsError('EEXIST', 'symlink', path);
    }
    this.ensureParent(p);
    this.vfs.symlink(target, p);
  }

  fsync(handleId?: number): void {
    if (handleId !== undefined) this.description(handleId);
    // SqliteVFS writes are synchronously durable before their calls return.
  }

  revision(path?: RuntimeFsPath): number {
    if (path === undefined) return this.rawVfs.revision();
    const p = this.resolveDataPath(path, true) ?? normalizeVfsPath(this.pathArgument(path));
    return this.rawVfs.revision(p);
  }

  acquire(epoch: string | null, cursor: number): VfsAcquireResult {
    return this.rawVfs.invalidatedSince(epoch, cursor);
  }

  list(after?: string | null, limit?: number): VfsListPage {
    return this.vfs.list(after ?? null, limit);
  }

  subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void {
    return this.rawVfs.events.onPath(normalizeVfsPath(path), listener);
  }

  realpath(path: RuntimeFsPath): string {
    const resolved = this.resolveDataPath(path, true);
    if (resolved === null) throw fsError('ELOOP', 'realpath', path);
    this.vfs.stat(resolved);
    return '/' + resolved;
  }

  remove(path: RuntimeFsPath, options: { recursive?: boolean; force?: boolean } = {}): void {
    try {
      if (options.recursive) this.vfs.removeRecursive(this.pathArgument(path));
      else this.unlink(path);
    } catch (error) {
      if (!(options.force && hasErrorCode(error, 'ENOENT'))) throw error;
    }
  }

  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void { this.vfs.copyFile(this.pathArgument(from), this.pathArgument(to)); }

  writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0]) {
    return this.vfs.writeBatch(payload);
  }

  writeStream(stream: ReadableStream<Uint8Array>, options?: Parameters<CredentialedVfs['writeStream']>[1]) {
    return this.vfs.writeStream(stream, options);
  }

  acquireExclusiveMutation(path: RuntimeFsPath, options?: { includeMissingAncestors?: boolean }) {
    this.vfs.access(parentVfsPath(this.pathArgument(path)), 0o3);
    return this.rawVfs.acquireExclusiveMutation(this.pathArgument(path), options);
  }

  releaseExclusiveMutation(owner: string): void { this.rawVfs.releaseExclusiveMutation(owner); }

  private pathArgument(path: RuntimeFsPath): string {
    if (typeof path === 'string') return path;
    const node = this.description(path.directory).node;
    if (node.stat().type !== 'directory') throw fsError('ENOTDIR', 'path', path.path);
    if (path.path.startsWith('/')) return path.path;
    return node.path() + '/' + path.path;
  }

  private resolveDataPath(path: RuntimeFsPath, followSymlinks: boolean): string | null {
    const pending = this.pathArgument(path).split('/').filter(Boolean);
    const resolved: string[] = [];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const segment = pending.shift()!;
      if (segment === '.') continue;
      if (segment === '..') { resolved.pop(); continue; }
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

  private resolveMutationPath(path: RuntimeFsPath, followSymlinks: boolean, syscall: string): string {
    this.rawVfs.assertMutationAllowed(normalizeVfsPath(this.pathArgument(path)));
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

  private description(handleId: number): OpenDescription {
    const description = this.scope.handles.get(handleId);
    if (!description || this.scope.closed) throw fsError('EBADF', 'fd', String(handleId));
    return description;
  }

  private getHandle(handleId: number): RuntimeFileHandle { return this.description(handleId).handle; }

  fstat(handleId: number): RuntimeVfsStat {
    return { ...this.description(handleId).node.stat(), revision: this.rawVfs.revision() };
  }

  dup(handleId: number): RuntimeFileHandle {
    const opened = this.description(handleId);
    const id = this.scope.nextId++;
    opened.refs++;
    this.scope.handles.set(id, opened);
    return { ...opened.handle, id };
  }

  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number {
    const handle = this.getHandle(handleId);
    const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : whence === 'end' ? this.fstat(handleId).size : NaN;
    const position = base + offset;
    if (!Number.isSafeInteger(position) || position < 0) throw fsError('EINVAL', 'seek', handle.path);
    handle.position = position;
    return position;
  }

  setStatus(handleId: number, status: { append?: boolean }): void {
    const handle = this.getHandle(handleId);
    if (status.append !== undefined) handle.flags = Object.freeze({ ...handle.flags, append: status.append });
  }

  readdirHandle(handleId: number): RuntimeVfsDirEntry[] { return this.description(handleId).node.readdir(); }
  ftruncate(handleId: number, size: number): void { this.description(handleId).node.truncate(size); }
  fchmod(handleId: number, mode: number): void { this.description(handleId).node.chmod(mode); }
  fchown(handleId: number, uid: number, gid: number): void { this.description(handleId).node.chown(uid, gid); }
  futimes(handleId: number, atime: number, mtime: number): void { this.description(handleId).node.utimes(atime, mtime); }
}

function normalizeOpenFlags(flags: RuntimeOpenFlags): RuntimeFileHandle['flags'] {
  return {
    read: !!flags.read || !flags.write,
    write: !!flags.write,
    append: !!flags.append,
    create: !!flags.create,
    exclusive: !!flags.exclusive,
    directory: !!flags.directory,
    truncate: !!flags.truncate,
    followSymlinks: flags.followSymlinks !== false,
    expectedRevision: flags.expectedRevision,
  };
}

/** An error carrying the fields Node's `fs` puts on a failed syscall. */
interface FsError extends Error {
  code: string;
  syscall: string;
  path: string;
}

function fsError(code: string, syscall: string, path: RuntimeFsPath): FsError {
  const name = typeof path === 'string' ? path : path.path;
  return Object.assign(new Error(`${code}: ${syscall} '${name}'`), { code, syscall, path: name });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
