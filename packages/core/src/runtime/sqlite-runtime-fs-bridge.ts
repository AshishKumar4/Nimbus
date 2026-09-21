import { SqliteVFSProvider, type CredentialedVfs, type SqliteVFS, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
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
  /** Aborted when the scope closes; cancels in-flight stream commits. */
  abort: AbortController;
  subscriptions: Set<() => void>;
}

export function createSqliteDescriptorScope(): SqliteDescriptorScope {
  return { nextId: 1, handles: new Map(), closed: false, abort: new AbortController(), subscriptions: new Set() };
}


export class SqliteRuntimeFsBridge implements RuntimeFsBridge {
  readonly synchronous: RuntimeSynchronousFs = this;
  private legacySymlinks: SymlinkRegistry;
  private readonly vfs: CredentialedVfs;

  constructor(vfs: CredentialedVfs, private readonly rawVfs: SqliteVFS, private readonly scope = createSqliteDescriptorScope(), private readonly getKernel?: () => VFS | undefined) {
    this.vfs = vfs;
    this.legacySymlinks = getSymlinkRegistry(rawVfs);
  }

  private get kernel(): VFS | undefined { return this.getKernel?.(); }

  dispose(): void {
    for (const id of this.scope.handles.keys()) this.close(id);
    this.scope.closed = true;
    this.scope.abort.abort();
  }

  /**
   * Where a path lives, decided only after confinement: a kernel mount is
   * consulted with the fully resolved path, so a `..` or an absolute path
   * inside a capability can never reach `/proc` or `/dev` sideways.
   */
  private locate(path: RuntimeFsPath, followSymlinks: boolean): Located | null {
    const resolved = this.resolveDataPath(path, followSymlinks);
    if (resolved === null) return null;
    const kernel = this.kernel;
    if (!kernel) return { path: resolved };
    const provider = kernel.getProvider('/' + resolved);
    if (provider && !(provider.provider instanceof SqliteVFSProvider)) return { mount: kernel, path: '/' + resolved };
    return { path: resolved };
  }

  private virtualStat(mount: VFS, path: string): RuntimeVfsStat {
    const stat = mount.stat(path);
    return { ...stat, dev: 0, ino: mount.inodeIdentity(path), nlink: 1, atime: stat.mtime, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: 0 };
  }

  /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
  private rootStat(): RuntimeVfsStat {
    if (this.kernel) return this.virtualStat(this.kernel, '/');
    const now = Date.now();
    return {
      dev: this.rawVfs.deviceId, ino: 0, nlink: 1, type: 'directory', size: 0,
      ctime: now, atime: now, mtime: now, mode: 0o40755, uid: 0, gid: 0,
      revision: this.rawVfs.revision(),
    };
  }

  stat(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsStat | null {
    const followSymlinks = options.followSymlinks !== false;
    const located = this.locate(path, followSymlinks);
    if (located === null) return null;
    if (located.mount) return located.mount.exists(located.path) ? this.virtualStat(located.mount, located.path) : null;
    const p = located.path;
    if (p === '') return this.rootStat();
    if (!followSymlinks && !this.vfs.exists(p)) {
      const target = this.legacySymlinks.readlink(p);
      if (target === null) return null;
      const now = Date.now();
      return {
        dev: this.rawVfs.deviceId,
        ino: 0,
        nlink: 1,
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
    const located = this.locate(path, options.followSymlinks !== false);
    if (located === null) return null;
    try {
      return located.mount ? located.mount.readFile(located.path) : this.vfs.readFile(located.path);
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
    const located = this.locateMutation(path, true, 'write');
    if (located.mount) {
      if (options.expectedRevision !== undefined) throw fsError('ESTALE', 'write', path);
      located.mount.writeFile(located.path, bytes);
      return this.rawVfs.revision();
    }
    const p = located.path;
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
    if ((options.expectedEpoch === undefined) !== (options.expectedRevision === undefined)) {
      throw fsError('EINVAL', 'read', path);
    }
    const located = this.locate(path, options.followSymlinks !== false);
    if (located === null) return null;
    if (located.mount) {
      if (options.expectedEpoch !== undefined) throw fsError('ESTALE', 'read', path);
      return located.mount.readRange(located.path, offset, length);
    }
    const p = located.path;
    if (options.expectedEpoch !== undefined && (options.expectedEpoch !== this.rawVfs.epoch
      || options.expectedRevision !== this.rawVfs.revision(p))) {
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
    const located = this.locateMutation(path, true, 'write');
    if (located.mount) {
      if (options.expectedRevision !== undefined) throw fsError('ESTALE', 'write', path);
      located.mount.writeRange(located.path, offset, bytes);
      return bytes.byteLength;
    }
    const p = located.path;
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
    return this.vfs.appendOnce(this.sqlitePath(path, true, 'append'), pid, writerId, moduleId, operationId, digest, bytes);
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
    const located = this.locateMutation(path, options.followSymlinks !== false, 'truncate');
    if (located.mount) { located.mount.truncate(located.path, size); return; }
    const p = located.path;
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
    const located = this.locateMutation(path, options.followSymlinks !== false, 'utimes');
    if (located.mount) { located.mount.utimes(located.path, atimeMs, mtimeMs); return; }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'utimes', path);
    this.vfs.utimes(p, atimeMs, mtimeMs);
  }

  chmod(path: RuntimeFsPath, mode: number): void {
    const located = this.locateMutation(path, true, 'chmod');
    if (located.mount) { located.mount.chmod(located.path, mode); return; }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chmod', path);
    this.vfs.chmod(p, mode);
  }

  access(path: RuntimeFsPath, mode: number): void {
    const located = this.locate(path, true);
    if (located === null) throw fsError('ELOOP', 'access', path);
    if (located.mount) located.mount.access(located.path, mode);
    else this.vfs.access(located.path, mode);
  }

  chown(
    path: RuntimeFsPath,
    uid: number,
    gid: number,
    options: { followSymlinks?: boolean } = {},
  ): void {
    const followSymlinks = options.followSymlinks !== false;
    const located = this.locateMutation(path, followSymlinks, 'chown');
    if (located.mount) { located.mount.chown(located.path, uid, gid); return; }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chown', path);
    this.vfs.chown(p, uid, gid, { followSymlinks });
  }

  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle {
    const normalizedFlags = normalizeOpenFlags(flags);
    const mutates = normalizedFlags.write || normalizedFlags.create ||
      normalizedFlags.truncate || normalizedFlags.append;
    const located = mutates
      ? this.locateMutation(path, normalizedFlags.followSymlinks, 'open')
      : this.locate(path, normalizedFlags.followSymlinks);
    if (located === null) throw fsError('ELOOP', 'open', path);
    if (located.mount) return this.openMount(located.mount, located.path, path, normalizedFlags);
    const p = located.path;
    if (p === '') return this.openRoot(path, normalizedFlags);
    this.assertExpectedRevision(p, normalizedFlags.expectedRevision);

    const exists = this.vfs.exists(p);
    if (normalizedFlags.exclusive && normalizedFlags.create && exists) throw fsError('EEXIST', 'open', path);
    if (normalizedFlags.directory && (!exists || !this.vfs.isDirectory(p))) throw fsError('ENOTDIR', 'open', path);
    if (!exists && !normalizedFlags.create) throw fsError('ENOENT', 'open', path);
    // A directory opens for reading whatever rights were asked for: a WASI
    // guest requests a capability set, not an access mode, and a directory
    // simply never grants fd_write (the write itself answers EISDIR). What
    // refuses here is content the open would change.
    if (exists && this.vfs.isDirectory(p) && (normalizedFlags.truncate || normalizedFlags.append)) throw fsError('EISDIR', 'open', path);
    if (exists) this.vfs.access(p, (normalizedFlags.read ? 4 : 0) | (normalizedFlags.write && !this.vfs.isDirectory(p) ? 2 : 0));
    if (!exists) {
      this.ensureParent(p);
      this.vfs.writeFile(p, new Uint8Array(0), { mode: flags.mode });
    } else if (normalizedFlags.truncate) {
      this.vfs.truncate(p, 0);
    }

    const stat = this.vfs.stat(p);
    const node = this.rawVfs.openDescription(p, this.vfs.cred, normalizedFlags);
    const handle: RuntimeFileHandle = {
      id: this.scope.nextId++,
      path: p,
      flags: Object.freeze(normalizedFlags),
      position: normalizedFlags.append ? stat.size : 0,
      closed: false,
    };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
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
    const node = this.description(handleId).node;
    const start = handle.flags.append
      ? node.stat().size
      : offset == null ? handle.position : Math.max(0, offset);
    node.write(start, bytes);
    const end = start + bytes.byteLength;
    if (offset == null || handle.flags.append) handle.position = end;
    return bytes.byteLength;
  }

  close(handleId: number): void {
    const opened = this.description(handleId);
    this.scope.handles.delete(handleId);
    if (--opened.refs === 0) { opened.handle.closed = true; opened.node.close(); }
  }

  readdir(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsDirEntry[] {
    const located = this.locate(path, options.followSymlinks !== false);
    if (located === null) return [];
    if (located.mount) return located.mount.readdir(located.path);
    const p = located.path;
    const entries = new Map<string, RuntimeVfsDirEntry>();
    if (p === '' && this.kernel) {
      for (const entry of this.kernel.readdir('/')) if (this.kernel.getProvider('/' + entry.name)) entries.set(entry.name, entry);
    }
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
    const located = this.locateMutation(path, false, 'mkdir');
    if (located.mount) { located.mount.mkdir(located.path, { recursive: !!options.recursive }); return; }
    const p = located.path;
    if (this.vfs.exists(p)) {
      if (options.recursive && this.vfs.isDirectory(p)) return;
      throw fsError('EEXIST', 'mkdir', path);
    }
    this.vfs.mkdir(p, { recursive: !!options.recursive, mode: options.mode });
  }

  unlink(path: RuntimeFsPath): void {
    const located = this.locateMutation(path, false, 'unlink');
    if (located.mount) { located.mount.unlink(located.path); return; }
    const p = located.path;
    if (this.vfs.exists(p)) {
      const staleLegacy = this.legacySymlinks.isSymlink(p);
      if (staleLegacy) this.legacySymlinks.assertMutable(p);
      this.vfs.unlink(p);
      if (staleLegacy) this.legacySymlinks.delete(p);
      return;
    }
    // A registry-only symlink has no inode of its own; the name still exists.
    if (!this.legacySymlinks.isSymlink(p)) throw fsError('ENOENT', 'unlink', path);
    this.legacySymlinks.delete(p);
  }

  rmdir(path: RuntimeFsPath): void {
    const located = this.locateMutation(path, false, 'rmdir');
    if (located.mount) { located.mount.rmdir(located.path); return; }
    const p = located.path;
    if (!this.vfs.isDirectory(p)) throw fsError('ENOTDIR', 'rmdir', path);
    this.vfs.rmdir(p);
  }

  rename(from: RuntimeFsPath, to: RuntimeFsPath): void {
    const oldPath = this.sqlitePath(from, false, 'rename');
    const newPath = this.sqlitePath(to, false, 'rename');
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
    const located = this.locate(path, false);
    if (located === null) return null;
    if (located.mount) return located.mount.readlink(located.path);
    const p = located.path;
    if (this.vfs.isSymlink(p)) return this.vfs.readlink(p);
    return this.legacySymlinks.readlink(p);
  }

  symlink(target: string, path: RuntimeFsPath): void {
    const located = this.locateMutation(path, false, 'symlink');
    if (located.mount) { located.mount.symlink(target, located.path); return; }
    const p = located.path;
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
    const located = this.locate(path, true);
    if (located === null) throw fsError('ELOOP', 'revision', path);
    return located.mount ? 0 : this.rawVfs.revision(located.path);
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
      if (!options.recursive) { this.unlink(path); return; }
      const located = this.locateMutation(path, false, 'remove');
      if (located.mount) located.mount.rmdirRecursive(located.path);
      else this.vfs.removeRecursive(located.path);
    } catch (error) {
      if (!(options.force && hasErrorCode(error, 'ENOENT'))) throw error;
    }
  }

  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void {
    const source = this.locate(from, true);
    if (source === null) throw fsError('ELOOP', 'copyFile', from);
    const target = this.locateMutation(to, true, 'copyFile');
    if (!source.mount && !target.mount) { this.vfs.copyFile(source.path, target.path); return; }
    const bytes = source.mount ? source.mount.readFile(source.path) : this.vfs.readFile(source.path);
    if (target.mount) target.mount.writeFile(target.path, bytes);
    else { this.ensureParent(target.path); this.vfs.writeFile(target.path, bytes); }
  }

  writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0]) {
    return this.vfs.writeBatch(payload);
  }

  writeStream(stream: ReadableStream<Uint8Array>, options?: Parameters<CredentialedVfs['writeStream']>[1]) {
    return this.vfs.writeStream(stream, options);
  }

  acquireExclusiveMutation(path: RuntimeFsPath, options?: { includeMissingAncestors?: boolean }) {
    const p = this.sqlitePath(path, false, 'acquireExclusiveMutation');
    const parent = parentVfsPath(p);
    if (parent && !(options?.includeMissingAncestors && !this.vfs.exists(parent))) this.vfs.access(parent, 0o3);
    return this.rawVfs.acquireExclusiveMutation(p, options);
  }

  releaseExclusiveMutation(owner: string): void { this.rawVfs.releaseExclusiveMutation(owner); }

  private pathArgument(path: RuntimeFsPath): string {
    if (typeof path === 'string') return path;
    if ('root' in path) return path.root + '/' + path.path;
    const node = this.description(path.directory).node;
    if (node.stat().type !== 'directory') throw fsError('ENOTDIR', 'path', path.path);
    if (path.path.startsWith('/')) return path.path;
    return node.path() + '/' + path.path;
  }

  private resolveDataPath(path: RuntimeFsPath, followSymlinks: boolean): string | null {
    const rooted = typeof path !== 'string' && path.beneath;
    const root = rooted ? normalizeVfsPath('root' in path ? path.root : this.description(path.directory).node.path()) : null;
    if (rooted && path.path.startsWith('/')) throw fsError('ENOTCAPABLE', 'path', path);
    const pending = this.pathArgument(path).split('/').filter(Boolean);
    const resolved: string[] = [];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const segment = pending.shift();
      if (segment === undefined) break;
      if (segment === '.') continue;
      if (segment === '..') {
        if (root !== null && resolved.join('/') === root) throw fsError('ENOTCAPABLE', 'path', path);
        resolved.pop();
        continue;
      }
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
      if (root !== null && root !== '' && target !== root && !target.startsWith(root + '/')) throw fsError('ENOTCAPABLE', 'path', path);
      pending.unshift(...target.split('/').filter(Boolean));
      resolved.length = 0;
    }

    return resolved.join('/');
  }

  private locateMutation(path: RuntimeFsPath, followSymlinks: boolean, syscall: string): Located {
    // A lease on a directory also covers names inside it that resolve
    // elsewhere through a symlink, so the literal path is checked as well.
    this.rawVfs.assertMutationAllowed(normalizeVfsPath(this.pathArgument(path)));
    const located = this.locate(path, followSymlinks);
    if (located === null) throw fsError('ELOOP', syscall, path);
    if (!located.mount) this.rawVfs.assertMutationAllowed(located.path);
    return located;
  }

  /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
  private sqlitePath(path: RuntimeFsPath, followSymlinks: boolean, syscall: string): string {
    const located = this.locateMutation(path, followSymlinks, syscall);
    if (located.mount) throw fsError('EXDEV', syscall, path);
    return located.path;
  }

  private openRoot(path: RuntimeFsPath, flags: RuntimeFileHandle['flags']): RuntimeFileHandle {
    if (flags.truncate || flags.append) throw fsError('EISDIR', 'open', path);
    const deny = (): never => { throw fsError('EPERM', 'fd', ''); };
    const node: VfsOpenDescription = {
      ino: 0, path: () => '', stat: () => this.rootStat(),
      read: deny, write: deny, truncate: deny, readdir: () => this.readdir(''),
      chmod: deny, chown: deny, utimes: deny, close: () => {},
    };
    const handle: RuntimeFileHandle = { id: this.scope.nextId++, path: '', flags: Object.freeze(flags), position: 0, closed: false };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
  }

  private openMount(mount: VFS, name: string, path: RuntimeFsPath, flags: RuntimeFileHandle['flags']): RuntimeFileHandle {
    const exists = mount.exists(name);
    if (flags.exclusive && flags.create && exists) throw fsError('EEXIST', 'open', path);
    if (!exists && !flags.create) throw fsError('ENOENT', 'open', path);
    if (!exists) mount.writeFile(name, new Uint8Array(0));
    const stat = this.virtualStat(mount, name);
    if (flags.directory && stat.type !== 'directory') throw fsError('ENOTDIR', 'open', path);
    if (stat.type === 'directory' && (flags.truncate || flags.append)) throw fsError('EISDIR', 'open', path);
    mount.access(name, (flags.read ? 4 : 0) | (flags.write && stat.type !== 'directory' ? 2 : 0));
    if (flags.truncate) mount.truncate(name, 0);
    const node: VfsOpenDescription = {
      ino: stat.ino, path: () => name, stat: () => this.virtualStat(mount, name),
      read: (offset, length) => mount.readRange(name, offset, length),
      write: (offset, bytes) => { mount.writeRange(name, offset, bytes); return bytes.length; },
      truncate: size => mount.truncate(name, size), readdir: () => mount.readdir(name),
      chmod: mode => mount.chmod(name, mode), chown: (uid, gid) => mount.chown(name, uid, gid),
      utimes: (atime, mtime) => mount.utimes(name, atime, mtime), close: () => {},
    };
    const handle: RuntimeFileHandle = {
      id: this.scope.nextId++, path: name, flags: Object.freeze(flags),
      position: flags.append ? stat.size : 0, closed: false,
    };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
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

/** A confined path, and whether a kernel mount owns it rather than SQLite. */
type Located = { mount: VFS; path: string } | { mount?: undefined; path: string };

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
