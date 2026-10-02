import { ROOT_DIRECTORY_MODE, ROOT_INODE, type CredentialedVfs, type SqliteVFS, type VfsNameResolution, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { runtimeStatOf, type CompositeVFS } from '../vfs/composite.js';
import { readDeclaredSource, type SyncVFS, type VfsRemoval, type VfsStat } from '../vfs/vfs.js';
import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry, type SymlinkRegistry } from '../vfs/symlink-registry.js';
import { errnoDescription } from '../vfs/vfs-error.js';
import type {
  RuntimeFileHandle,
  RuntimeFsPath,
  RuntimeReadOptions,
  RuntimeSynchronousFs,
  RuntimeFsBridge,
  RuntimeOpenFlags,
  RuntimeVfsDirEntry,
  RuntimeVfsStat,
  VfsAcquireOptions,
  VfsAcquireResult,
  VfsListPage,
  VfsMutationReceipt,
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

  /** The namespace as this caller sees it: what a path off the SQLite root reaches. */
  private readonly mounted: SyncVFS | undefined;

  constructor(
    vfs: CredentialedVfs,
    private readonly rawVfs: SqliteVFS,
    private readonly scope = createSqliteDescriptorScope(),
    private readonly namespace?: CompositeVFS,
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    private readonly bufferedWriteBytes: number = BUFFERED_WRITE_BYTES,
  ) {
    this.vfs = vfs;
    this.legacySymlinks = getSymlinkRegistry(rawVfs);
    this.mounted = namespace?.sync;
  }

  /**
   * The legacy registry's key for one of this caller's names. Its entries are
   * keyed by storage key, so a confined caller's /tmp/x is its own, and an
   * entry in the shared tmp is not its to see, follow or remove.
   */
  private legacyKey(path: string): string {
    return this.vfs.storageKey(path);
  }

  dispose(): void {
    for (const id of this.scope.handles.keys()) this.close(id);
    this.scope.closed = true;
    this.scope.abort.abort();
  }

  /**
   * Where a path lives, decided only after confinement: the namespace is
   * consulted with the fully resolved path, so a `..` or an absolute path
   * inside a capability can never reach `/proc` or `/dev` sideways.
   */
  private locate(path: RuntimeFsPath, followSymlinks: boolean): Located | null {
    // The namespace declined the walk's first name, and with it every name below.
    const walked = this.walkOnSqlite(path, followSymlinks);
    if (walked !== null) return walked.end === 'absent' ? { path: walked.name, absent: true } : { path: walked.name };
    const resolved = this.resolveDataPath(path, followSymlinks);
    if (resolved === null) return null;
    const mounted = this.mounted;
    if (!mounted || !this.namespace!.composes('/' + resolved)) return { path: resolved };
    return { mount: mounted, path: '/' + resolved };
  }

  /**
   * The path resolved in one walk on SQLite (SqliteVFS.resolveName), or null
   * for the walk component by component (resolveDataPath): for a walk
   * beneath a root, for a spelling with `..` (that walk takes `..`
   * physically, after the link before it, where the engine's names take it
   * lexically), where the namespace lays a mount or a directory above one,
   * and where a name is missing while the legacy registry could hold a link
   * there.
   */
  private walkOnSqlite(path: RuntimeFsPath, followSymlinks: boolean): VfsNameResolution | null {
    if (typeof path !== 'string' && path.beneath) return null;
    const spelled = this.pathArgument(path);
    if (DOT_DOT_SEGMENT.test(spelled)) return null;
    const namespace = this.namespace;
    const walked = this.vfs.resolveName(spelled, followSymlinks, namespace && ((name) => namespace.composes('/' + name)));
    if (walked === null || (walked.end !== 'found' && this.legacySymlinks.size > 0)) return null;
    return walked;
  }

  /** A mounted entry's stat in this contract's shape; a mount never moves the SQLite clock. */
  private virtualStat(mount: SyncVFS, path: string): RuntimeVfsStat {
    const stat = mount.stat(path);
    if (stat === null) throw fsError('ENOENT', 'stat', path);
    return runtimeStatOf(stat);
  }

  /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
  private rootStat(): RuntimeVfsStat {
    const now = Date.now();
    return {
      dev: this.rawVfs.deviceId, ino: ROOT_INODE, nlink: 1, type: 'directory', size: 0,
      ctime: now, atime: now, mtime: now, mode: ROOT_DIRECTORY_MODE, uid: 0, gid: 0,
      revision: this.rawVfs.revision(),
    };
  }

  stat(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsStat | null {
    const followSymlinks = options.followSymlinks !== false;
    let located: Located | null;
    try {
      located = this.locate(path, followSymlinks);
    } catch (error) {
      // A component missing on the way is "not there", whatever form the path takes.
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
    if (located === null) throw fsError('ELOOP', 'stat', path);
    if (located.mount) {
      const stat = located.mount.stat(located.path, { follow: followSymlinks });
      const viewed = stat !== null && stat.type === 'file' ? this.processView(located.mount, located.path) : undefined;
      if (viewed) return { ...runtimeStatOf(stat!), size: viewed.byteLength };
      return stat === null ? null : runtimeStatOf(stat);
    }
    const p = located.path;
    // The walk met the absent name itself; the engine would only say ENOENT.
    if (located.absent) return null;
    if (p === '') return this.rootStat();
    if (!followSymlinks && !this.vfs.exists(p)) {
      const target = this.legacySymlinks.readlink(this.legacyKey(p));
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
        revision: this.vfs.revision(p),
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
        revision: this.vfs.revision(p),
      };
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  readFile(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): Uint8Array | null {
    const located = this.locate(path, options.followSymlinks !== false);
    if (located === null || located.absent) return null;
    try {
      if (!located.mount) return this.vfs.readFile(located.path);
      return this.processView(located.mount, located.path) ?? located.mount.readFile(located.path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  /**
   * A mounted file as this process sees it while it holds buffered writes to
   * it (VFS-PF-001 viewAs, page-cache semantics): the mount's file with each
   * of this process's descriptions of it applied, in open order. Undefined
   * when it holds none pending: then the mount's own file is the answer.
   * Another process's pending writes are never in it.
   */
  private processView(mount: SyncVFS, name: string): Uint8Array | undefined {
    let file: Uint8Array | undefined;
    const seen = new Set<VfsOpenDescription>();
    for (const opened of this.scope.handles.values()) {
      const node = opened.node;
      if (seen.has(node) || node.applyPending === undefined || node.path() !== name || (node.pendingBytes?.() ?? 0) === 0) continue;
      seen.add(node);
      file ??= mount.stat(name) === null ? new Uint8Array(0) : mount.readFile(name);
      file = node.applyPending(file);
    }
    return file;
  }

  writeFile(
    path: RuntimeFsPath,
    bytes: string | Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } = {},
  ): number {
    const located = this.locateMutation(path, true, 'write');
    if (located.mount) {
      if (options.expectedRevision !== undefined) throw fsError('ESTALE', 'write', path);
      if (options.createParents === true) mountParents(located.mount, located.path);
      located.mount.writeFile(located.path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
      return this.rawVfs.revision();
    }
    const p = located.path;
    this.assertExpectedRevision(p, options.expectedRevision);
    if (options.createParents === true) this.ensureParent(p);
    this.vfs.writeFile(p, bytes);
    // Read back in the same synchronous turn as the mutation, so nothing can
    // interleave: this is exactly the revision this write produced. Asking
    // again after an await would report a peer's clock as our own.
    return this.rawVfs.revision();
  }

  async writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number> {
    const located = this.locateMutation(path, true, 'write');
    if (!located.mount) return await this.vfs.writeFileFrom(located.path, size, source);
    // A mounted filesystem has no staging to publish from, so it takes the
    // whole file in one write: nothing reaches it until the source is read,
    // and a source that fails changes nothing.
    const data = await readDeclaredSource(source, size, () => fsError('EINVAL', 'write', path));
    located.mount.writeFile(located.path, data);
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
      const mount = located.mount;
      const viewed = this.processView(mount, located.path);
      if (viewed) return viewed.slice(offset, offset + length);
      if (mount.readRange) return mount.readRange(located.path, offset, length);
      return mount.readFile(located.path).slice(offset, offset + length);
    }
    const p = located.path;
    if (options.expectedEpoch !== undefined && (options.expectedEpoch !== this.rawVfs.epoch
      || options.expectedRevision !== this.vfs.revision(p))) {
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
  ): VfsMutationReceipt {
    const located = this.locateMutation(path, true, 'write');
    if (located.mount) {
      if (options.expectedRevision !== undefined) throw fsError('ESTALE', 'write', path);
      if (!located.mount.writeRange) throw fsError('ENOTSUP', 'write', path);
      if (options.createParents === true) mountParents(located.mount, located.path);
      located.mount.writeRange(located.path, offset, bytes);
      return this.mountReceipt();
    }
    const p = located.path;
    this.assertExpectedRevision(p, options.expectedRevision);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'write', path);
    if (options.createParents === true) this.ensureParent(p);
    return this.receipted(p, () => this.vfs.writeRange(p, offset, bytes));
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
  ): VfsMutationReceipt {
    const located = this.locateMutation(path, options.followSymlinks !== false, 'truncate');
    if (located.mount) { mountOp(located.mount.truncate, 'truncate', path)(located.path, size); return this.mountReceipt(); }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'truncate', path);
    if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'truncate', path);
    return this.receipted(p, () => this.vfs.truncate(p, size));
  }

  utimes(
    path: RuntimeFsPath,
    atimeMs: number | null | undefined,
    mtimeMs: number | null | undefined,
    options: { followSymlinks?: boolean } = {},
  ): VfsMutationReceipt {
    const follow = options.followSymlinks !== false;
    const located = this.locateMutation(path, follow, 'utimes');
    if (located.mount) {
      const now = Date.now();
      const kept = atimeMs === undefined || mtimeMs === undefined ? located.mount.stat(located.path, { follow }) : null;
      mountOp(located.mount.utimes, 'utimes', path)(
        located.path,
        atimeMs === undefined ? kept?.atimeMs ?? now : atimeMs ?? now,
        mtimeMs === undefined ? kept?.mtimeMs ?? now : mtimeMs ?? now,
      );
      return this.mountReceipt();
    }
    const p = located.path;
    if (!(follow ? this.vfs.exists(p) : this.vfs.isSymlink(p) || this.vfs.exists(p))) throw fsError('ENOENT', 'utimes', path);
    return this.receipted(p, () => this.vfs.utimes(p, atimeMs, mtimeMs, { followSymlinks: follow }));
  }

  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt {
    const located = this.locateMutation(path, true, 'chmod');
    if (located.mount) { mountOp(located.mount.chmod, 'chmod', path)(located.path, mode); return this.mountReceipt(); }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chmod', path);
    return this.receipted(p, () => this.vfs.chmod(p, mode));
  }

  access(path: RuntimeFsPath, mode: number): void {
    const located = this.locate(path, true);
    if (located === null) throw fsError('ELOOP', 'access', path);
    if (located.mount) {
      const stat = located.mount.stat(located.path);
      if (stat === null) throw fsError('ENOENT', 'access', path);
      if (!modeAllows(stat, mode, this.vfs.cred)) throw fsError('EACCES', 'access', path);
    } else if (located.path === '') {
      // `/` has no row: its mode is ROOT_DIRECTORY_MODE, owned by root.
      if (!modeAllows(this.rootStat(), mode, this.vfs.cred)) throw fsError('EACCES', 'access', path);
    } else this.vfs.access(located.path, mode);
  }

  chown(
    path: RuntimeFsPath,
    uid: number,
    gid: number,
    options: { followSymlinks?: boolean } = {},
  ): VfsMutationReceipt {
    const followSymlinks = options.followSymlinks !== false;
    const located = this.locateMutation(path, followSymlinks, 'chown');
    if (located.mount) { mountOp(located.mount.chown, 'chown', path)(located.path, uid, gid); return this.mountReceipt(); }
    const p = located.path;
    if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chown', path);
    return this.receipted(p, () => this.vfs.chown(p, uid, gid, { followSymlinks }));
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
    // O_NOFOLLOW on a trailing symlink is ELOOP: there is no descriptor to
    // open on the link itself, and what it points at is exactly what the
    // caller declined to open.
    if (!normalizedFlags.followSymlinks && this.vfs.isSymlink(p)) throw fsError('ELOOP', 'open', path);
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
    if (handle.flags.append && node.writeAppend) {
      node.writeAppend(bytes);
      handle.position += bytes.byteLength;
      return bytes.byteLength;
    }
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
    if (located.mount) return located.mount.readdir(located.path).map((entry) => ({ name: entry.name, type: entry.type }));
    const p = located.path;
    const entries = new Map<string, RuntimeVfsDirEntry>();
    // What the namespace itself puts in `/` (proc, dev, an embedder's mounts) is listed with it.
    if (p === '' && this.namespace) {
      for (const entry of this.namespace.mountedNames('/')) entries.set(entry.name, { name: entry.name, type: entry.type });
    }
    for (const entry of this.vfs.readdir(p)) {
      const type = entry.type === 'directory'
        ? 'directory'
        : entry.type === 'symlink'
          ? 'symlink'
          : 'file';
      entries.set(entry.name, { name: entry.name, type });
    }
    const key = this.legacyKey(p);
    const prefix = key ? `${key}/` : '';
    for (const link of this.legacySymlinks.list()) {
      if (parentVfsPath(link.link) !== key) continue;
      const name = link.link.slice(prefix.length);
      if (!entries.has(name)) entries.set(name, { name, type: 'symlink' });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  mkdir(path: RuntimeFsPath, options: { recursive?: boolean; mode?: number } = {}): void {
    const located = this.locateMutation(path, false, 'mkdir');
    if (located.mount) { located.mount.mkdir(located.path, { recursive: !!options.recursive, mode: options.mode }); return; }
    const p = located.path;
    // `/` has no row (stat answers it with rootStat), but it exists: mkdir of
    // it is EEXIST, as mkdir(2) says, before any permission check on its
    // (nonexistent) parent. `mkdir -p` walks through it on every absolute path.
    // A recursive mkdir then stats the name, following links, as coreutils and
    // Node do after EEXIST: a link to a directory is already there.
    if (p === '' || this.vfs.exists(p)) {
      if (options.recursive && this.stat(path)?.type === 'directory') return;
      throw fsError('EEXIST', 'mkdir', path);
    }
    this.vfs.mkdir(p, { recursive: !!options.recursive, mode: options.mode });
  }

  unlink(path: RuntimeFsPath): void {
    const located = this.locateMutation(path, false, 'unlink');
    if (located.mount) { located.mount.unlink(located.path); return; }
    const p = located.path;
    const key = this.legacyKey(p);
    if (this.vfs.exists(p)) {
      const staleLegacy = this.legacySymlinks.isSymlink(key);
      if (staleLegacy) this.legacySymlinks.assertMutable(key);
      this.vfs.unlink(p);
      if (staleLegacy) this.legacySymlinks.delete(key);
      return;
    }
    // A registry-only symlink has no inode of its own; the name still exists.
    if (!this.legacySymlinks.isSymlink(key)) throw fsError('ENOENT', 'unlink', path);
    this.legacySymlinks.delete(key);
  }

  rmdir(path: RuntimeFsPath): void {
    const located = this.locateMutation(path, false, 'rmdir');
    if (located.mount) { mountOp(located.mount.rmdir, 'rmdir', path)(located.path); return; }
    const p = located.path;
    // rmdir(2): a missing path is ENOENT, anything but a directory (a file, a link) ENOTDIR.
    if (!this.vfs.exists(p) && !this.legacySymlinks.isSymlink(this.legacyKey(p))) throw fsError('ENOENT', 'rmdir', path);
    if (!this.vfs.isDirectory(p)) throw fsError('ENOTDIR', 'rmdir', path);
    this.vfs.rmdir(p);
  }

  rename(from: RuntimeFsPath, to: RuntimeFsPath): void {
    // Every refusal names the call's own two paths, whichever lookup met it.
    const call: FsCall = { syscall: 'rename', path: from, dest: to };
    const source = this.locateMutation(from, false, call);
    const target = this.locateMutation(to, false, call);
    // A name on a mount is renamed by the namespace: within one mount by that
    // mount, and otherwise refused in the namespace's order (EBUSY for a
    // mount point, then EXDEV between two filesystems and on a backend with
    // no rename in place).
    if (source.mount || target.mount) {
      const fromPath = source.mount ? source.path : `/${source.path}`;
      const toPath = target.mount ? target.path : `/${target.path}`;
      mountOp((source.mount ?? target.mount)!.rename, call)(fromPath, toPath);
      return;
    }
    const oldPath = source.path;
    const newPath = target.path;
    const oldKey = this.legacyKey(oldPath);
    const newKey = this.legacyKey(newPath);
    if (this.vfs.exists(oldPath)) {
      const staleDestination = this.legacySymlinks.isSymlink(newKey);
      if (staleDestination) this.legacySymlinks.assertMutable(newKey);
      this.assertParentDirectory(newPath, call);
      this.vfs.rename(oldPath, newPath);
      if (staleDestination) this.legacySymlinks.delete(newKey);
      return;
    }
    const linkTarget = this.legacySymlinks.readlink(oldKey);
    if (linkTarget === null) throw callError('ENOENT', call);
    const staleDestination = this.legacySymlinks.isSymlink(newKey);
    this.legacySymlinks.assertMutable(oldKey, ...(staleDestination ? [newKey] : []));
    this.assertParentDirectory(newPath, call);
    if (this.vfs.exists(newPath)) {
      if (this.vfs.isDirectory(newPath)) throw callError('EISDIR', call);
      this.vfs.unlink(newPath);
    }
    this.vfs.symlink(linkTarget, newPath);
    this.legacySymlinks.delete(oldKey);
    if (staleDestination) this.legacySymlinks.delete(newKey);
  }

  readlink(path: RuntimeFsPath): string | null {
    const located = this.locate(path, false);
    if (located === null) return null;
    if (located.mount) return mountOp(located.mount.readlink, 'readlink', path)(located.path);
    const p = located.path;
    if (this.vfs.isSymlink(p)) return this.vfs.readlink(p);
    return this.legacySymlinks.readlink(this.legacyKey(p));
  }

  symlink(target: string, path: RuntimeFsPath): void {
    // Node names the target, then the link.
    const call: FsCall = { syscall: 'symlink', path: target, dest: path };
    const located = this.locateMutation(path, false, call);
    if (located.mount) { mountOp(located.mount.symlink, call)(target, located.path); return; }
    const p = located.path;
    if (this.vfs.exists(p) || this.legacySymlinks.isSymlink(this.legacyKey(p))) throw callError('EEXIST', call);
    this.vfs.symlink(target, p);
  }

  fsync(handleId?: number): void {
    // SqliteVFS writes are synchronously durable before their calls return; a
    // buffered mount handle flushes.
    if (handleId !== undefined) this.description(handleId).node.flush?.();
  }

  /**
   * Every per-path revision here is the caller's: `p` is its own name for a
   * path, and a confined caller's /tmp/x is its private file, whose revision
   * is not the shared tmp/x's. The global clock is everyone's.
   */
  revision(path?: RuntimeFsPath): number {
    if (path === undefined) return this.rawVfs.revision();
    const located = this.locate(path, true);
    if (located === null) throw fsError('ELOOP', 'revision', path);
    return located.mount ? 0 : this.vfs.revision(located.path);
  }

  acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult {
    return this.vfs.acquire(epoch, cursor, options);
  }

  list(after?: string | null, limit?: number): VfsListPage {
    return this.vfs.list(after ?? null, limit);
  }

  /** A watch in the caller's view: its files, under its names, only those it could list. */
  subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void {
    return this.vfs.subscribe(path, listener);
  }

  realpath(path: RuntimeFsPath): string {
    const resolved = this.walkOnSqlite(path, true)?.name ?? this.resolveDataPath(path, true);
    if (resolved === null) throw fsError('ELOOP', 'realpath', path);
    if (resolved === '') return '/';
    if (this.namespace?.composes('/' + resolved)) return this.namespace.realpath('/' + resolved);
    this.vfs.stat(resolved);
    return '/' + resolved;
  }

  remove(path: RuntimeFsPath, options: { recursive?: boolean; force?: boolean } = {}): void {
    try {
      if (!options.recursive) { this.unlink(path); return; }
      const located = this.locateMutation(path, false, 'remove');
      if (located.mount) {
        const mount = located.mount;
        if (!mount.removeRecursive) removeTree(mount, located.path);
        else {
          // A walked removal carries on past an entry it cannot remove and
          // reports it; rm -r fails with the first.
          const failed = (mount.removeRecursive(located.path) as VfsRemoval | undefined)?.failures[0];
          if (failed) throw failed.error;
        }
      }
      else this.vfs.removeRecursive(located.path);
    } catch (error) {
      if (!(options.force && hasErrorCode(error, 'ENOENT'))) throw error;
    }
  }

  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void {
    const call: FsCall = { syscall: 'copyfile', path: from, dest: to };
    const source = this.locate(from, true);
    if (source === null) throw callError('ELOOP', call);
    const target = this.locateMutation(to, true, call);
    if (!source.mount && !target.mount) { this.vfs.copyFile(source.path, target.path); return; }
    const bytes = source.mount ? source.mount.readFile(source.path) : this.vfs.readFile(source.path);
    if (target.mount) target.mount.writeFile(target.path, bytes);
    else this.vfs.writeFile(target.path, bytes);
  }

  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean }): Promise<number> {
    const call: FsCall = { syscall: 'cp', path: from, dest: to };
    const source = this.locate(from, false);
    if (source === null) throw callError('ELOOP', call);
    const target = this.locateMutation(to, false, call);
    if (source.mount || target.mount) throw callError('EXDEV', call);
    return this.vfs.copyTreeAsync(source.path, target.path, options);
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
    return this.vfs.acquireExclusiveMutation(p, options);
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
    if (typeof path !== 'string' && path.beneath) {
      // The root is found by name, so every directory above it must grant
      // search (VFS-COMP-006) before anything is looked up beneath it.
      const root = normalizeVfsPath('root' in path ? path.root : this.description(path.directory).node.path());
      const walk = walkBeneath(root, path, followSymlinks, this.vfs.cred);
      for (let step = walk.next(); ; ) {
        if (step.done) return step.value;
        const lookup = step.value;
        step = walk.next('readlink' in lookup
          ? this.readlink(lookup.readlink) ?? ''
          : lookup.stat === '/' ? this.rootStat() : this.stat(lookup.stat, { followSymlinks: false }));
      }
    }
    const pending = this.pathArgument(path).split('/').filter(Boolean);
    const resolved: string[] = [];
    let hops = 0;

    while (pending.length > 0) {
      const segment = pending.shift();
      if (segment === undefined) break;
      if (segment === '.') continue;
      if (segment === '..') {
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, segment].join('/');
      const isFinal = pending.length === 0;
      if (!followSymlinks && isFinal) {
        resolved.push(segment);
        continue;
      }
      // On a mount, or a directory above one, the namespace answers whether
      // this component is a link (the SQLite rows it covers, links among
      // them, are never followed). The walk itself stays here.
      if (this.namespace?.composes('/' + candidate)) {
        const link = this.mountedLink('/' + candidate);
        if (link === null) {
          resolved.push(segment);
          continue;
        }
        if (++hops > MAX_LINK_HOPS) return null;
        if (link.startsWith('/')) resolved.length = 0;
        pending.unshift(...link.split('/').filter(Boolean));
        continue;
      }
      if (!followSymlinks && isFinal) {
        resolved.push(segment);
        continue;
      }

      // One lookup answers whether the component is a link, and when it is
      // absent, whether the legacy registry may hold one there.
      const kind = this.vfs.kind(candidate);
      if (kind !== 'symlink') {
        const legacyTarget = kind !== null ? null : this.legacySymlinks.readlink(this.legacyKey(candidate));
        if (legacyTarget === null) {
          resolved.push(segment);
          continue;
        }
        // Its components are walked as they are, `..` after any link before it.
        if (++hops > MAX_LINK_HOPS) return null;
        if (legacyTarget.startsWith('/')) resolved.length = 0;
        pending.unshift(...legacyTarget.split('/').filter(Boolean));
        continue;
      }
      const target = this.vfs.resolveSymlink(candidate);
      if (target === null) return null;
      // Hops are counted, as Linux does (40): a link met again on a longer
      // path is one more hop, not a cycle.
      if (++hops > MAX_LINK_HOPS) return null;
      pending.unshift(...target.split('/').filter(Boolean));
      resolved.length = 0;
    }

    return resolved.join('/');
  }

  /** A mounted (or composed) entry's link target, or null when it is not a link or not there. */
  private mountedLink(path: string): string | null {
    let stat;
    try {
      stat = this.mounted!.stat(path, { follow: false });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
    if (stat === null || stat.type !== 'symlink' || typeof this.mounted!.readlink !== 'function') return null;
    return this.mounted!.readlink(path);
  }

  /** `call`: the syscall a refusal names, or the whole call when it names two paths. */
  private locateMutation(path: RuntimeFsPath, followSymlinks: boolean, call: string | FsCall): Located {
    // A lease on a directory also covers names inside it that resolve
    // elsewhere through a symlink, so the literal path is checked as well.
    // Leases are held on storage keys: a confined caller's /tmp/x is its
    // private file, not the shared tmp/x.
    this.rawVfs.assertMutationAllowed(this.vfs.storageKey(normalizeVfsPath(this.pathArgument(path))));
    const located = this.locate(path, followSymlinks);
    if (located === null) throw callError('ELOOP', typeof call === 'string' ? { syscall: call, path } : call);
    // And the name it reaches, on a mount as on SQLite.
    this.rawVfs.assertMutationAllowed(this.vfs.storageKey(located.mount ? normalizeVfsPath(located.path) : located.path));
    return located;
  }

  /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
  private sqlitePath(path: RuntimeFsPath, followSymlinks: boolean, call: string | FsCall): string {
    const located = this.locateMutation(path, followSymlinks, call);
    if (located.mount) throw callError('EXDEV', typeof call === 'string' ? { syscall: call, path } : call);
    return located.path;
  }

  private openRoot(path: RuntimeFsPath, flags: RuntimeFileHandle['flags']): RuntimeFileHandle {
    if (flags.truncate || flags.append) throw fsError('EISDIR', 'open', path);
    const deny = (): never => { throw fsError('EPERM', 'fd', ''); };
    const node: VfsOpenDescription = {
      ino: ROOT_INODE, path: () => '', stat: () => this.rootStat(),
      read: deny, write: deny, truncate: deny, readdir: () => this.readdir(''),
      chmod: deny, chown: deny, utimes: deny, close: () => {},
    };
    const handle: RuntimeFileHandle = { id: this.scope.nextId++, path: '', flags: Object.freeze(flags), position: 0, closed: false };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
  }

  private openMount(mount: SyncVFS, name: string, path: RuntimeFsPath, flags: RuntimeFileHandle['flags']): RuntimeFileHandle {
    const exists = mount.stat(name) !== null;
    if (flags.exclusive && flags.create && exists) throw fsError('EEXIST', 'open', path);
    if (!exists && !flags.create) throw fsError('ENOENT', 'open', path);
    if (!exists) mount.writeFile(name, new Uint8Array(0));
    const stat = this.virtualStat(mount, name);
    if (flags.directory && stat.type !== 'directory') throw fsError('ENOTDIR', 'open', path);
    if (stat.type === 'directory' && (flags.truncate || flags.append)) throw fsError('EISDIR', 'open', path);
    if (!modeAllows(stat, (flags.read ? 4 : 0) | (flags.write && stat.type !== 'directory' ? 2 : 0), this.vfs.cred)) {
      throw fsError('EACCES', 'open', path);
    }
    if (flags.truncate) mountOp(mount.truncate, 'open', path)(name, 0);
    const node: VfsOpenDescription = {
      ino: stat.ino, path: () => name, stat: () => this.virtualStat(mount, name),
      read: (offset, length) => (mount.readRange ? mount.readRange(name, offset, length) : mount.readFile(name).slice(offset, offset + length)),
      write: (offset, bytes) => { mountOp(mount.writeRange, 'write', path)(name, offset, bytes); return bytes.length; },
      truncate: size => mountOp(mount.truncate, 'ftruncate', path)(name, size),
      readdir: () => mount.readdir(name).map((entry) => ({ name: entry.name, type: entry.type })),
      chmod: mode => mountOp(mount.chmod, 'fchmod', path)(name, mode),
      chown: (uid, gid) => mountOp(mount.chown, 'fchown', path)(name, uid, gid),
      utimes: (atime, mtime) => mountOp(mount.utimes, 'futimes', path)(name, atime, mtime), close: () => {},
    };
    if (stat.type === 'file' && !this.namespace!.writesInPlace(name)) this.buffer(node, mount, name, path);
    const handle: RuntimeFileHandle = {
      id: this.scope.nextId++, path: name, flags: Object.freeze(flags),
      position: flags.append ? stat.size : 0, closed: false,
    };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
  }

  /**
   * A mount that cannot write in place (no writeRange): the handle buffers
   * its writes, at most `bufferedWriteBytes` (EFBIG past it, nothing
   * buffered), and a flush (fsync, the last close, the process's release)
   * reads the file, applies them in order and writes it back.
   */
  private buffer(node: VfsOpenDescription, mount: SyncVFS, name: string, path: RuntimeFsPath): void {
    const pending: { offset: number | null; bytes: Uint8Array }[] = [];
    let held = 0;
    const take = (offset: number | null, bytes: Uint8Array): number => {
      if (held + bytes.byteLength > this.bufferedWriteBytes) throw fsError('EFBIG', 'write', path);
      pending.push({ offset, bytes: bytes.slice() });
      held += bytes.byteLength;
      return bytes.byteLength;
    };
    // `file` with the pending writes applied in order (an append at the end
    // as it then is): what a flush writes, and what this process reads.
    const applyPending = (base: Uint8Array): Uint8Array => {
      // A copy: a backend may hand out its own buffer, which must not change before the flush.
      let file = base.slice();
      for (const write of pending) {
        const at = write.offset ?? file.byteLength;
        if (at + write.bytes.byteLength > file.byteLength) {
          const grown = new Uint8Array(at + write.bytes.byteLength);
          grown.set(file);
          file = grown;
        }
        file.set(write.bytes, at);
      }
      return file;
    };
    const flush = (): void => {
      if (pending.length === 0) return;
      const file = applyPending(mount.stat(name) === null ? new Uint8Array(0) : mount.readFile(name));
      pending.length = 0;
      held = 0;
      mount.writeFile(name, file);
    };
    // A read or fstat on the descriptor is this process's view of the file.
    const mountedRead = node.read;
    const mountedStat = node.stat;
    node.read = (offset, length) => {
      const viewed = this.processView(mount, name);
      return viewed ? viewed.slice(offset, offset + length) : mountedRead(offset, length);
    };
    node.stat = () => {
      const viewed = this.processView(mount, name);
      return viewed ? { ...mountedStat(), size: viewed.byteLength } : mountedStat();
    };
    node.applyPending = applyPending;
    node.write = take;
    node.writeAppend = (bytes) => take(null, bytes);
    node.flush = flush;
    node.pendingBytes = () => held;
    node.close = flush;
  }

  private ensureParent(path: string): void {
    const parent = parentVfsPath(path);
    if (parent && !this.vfs.exists(parent)) this.vfs.mkdir(parent, { recursive: true });
  }

  /** ENOENT or ENOTDIR for `call` when `path`'s parent is missing or not a directory. */
  private assertParentDirectory(path: string, call: FsCall): void {
    const parent = parentVfsPath(path);
    if (!parent) return;
    if (!this.vfs.exists(parent)) throw callError('ENOENT', call);
    if (!this.vfs.isDirectory(parent)) throw callError('ENOTDIR', call);
  }

  /**
   * Run one mutation of path `p` and report its revision on either side,
   * both read in the mutation's own synchronous turn: across an await either
   * would report a peer's clock as ours.
   */
  private receipted(p: string, mutate: () => void): VfsMutationReceipt {
    const before = this.vfs.revision(p);
    mutate();
    return { before, after: this.rawVfs.revision() };
  }

  /** A mount never moves the raw clock, and ACQUIRE never lists its paths. */
  private mountReceipt(): VfsMutationReceipt {
    const r = this.rawVfs.revision();
    return { before: r, after: r };
  }

  private assertExpectedRevision(path: string, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return;
    if (expectedRevision !== this.vfs.revision(path)) {
      throw fsError('ESTALE', 'write', `revision ${expectedRevision}`);
    }
  }

  private description(handleId: number): OpenDescription {
    const description = this.scope.handles.get(handleId);
    if (!description || this.scope.closed) throw fsError('EBADF', 'fd', String(handleId));
    return description;
  }

  private getHandle(handleId: number): RuntimeFileHandle { return this.description(handleId).handle; }

  /** The absolute path a descriptor was opened at. */
  descriptorPath(handleId: number): string { return '/' + normalizeVfsPath(this.description(handleId).node.path()); }

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

/** Links followed before ELOOP (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

/** A `..` component in a path's spelling. */
const DOT_DOT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

/** One lookup a walk beneath a root asks of its filesystem: a stat that does not follow a link (null when absent), or a link's target. */
export type BeneathLookup = { readonly stat: string } | { readonly readlink: string };
type BeneathAnswer = { type: string; mode?: number; uid?: number; gid?: number } | string | null;

/**
 * A lookup beneath `root` (RESOLVE_BENEATH, a WASI preopen), as the
 * namespace walk does it (VFS-COMP-006): the root must be reachable (every
 * directory above it searchable); an absolute path, `..` at the root, and any
 * absolute link are ENOTCAPABLE; each component needs the directory it leaves
 * to be a searchable directory; a missing component is ENOENT unless it is
 * the last. Links resolve (the last only when `follow`), 40 hops, then null
 * (ELOOP). The one walk for every face: it yields its lookups, which the
 * synchronous bridge answers at once and a face over asynchronous mounts
 * awaits. `root` is normalized; the answer is the resolved path, normalized.
 */
export function* walkBeneath(root: string, path: RuntimeFsPath, follow: boolean, cred: { uid: number; gid: number; groups: readonly number[] }): Generator<BeneathLookup, string | null, BeneathAnswer> {
  const name = typeof path === 'string' ? path : path.path;
  if (root !== '') yield { stat: '/' + root };
  if (name.startsWith('/')) throw fsError('ENOTCAPABLE', 'path', path);
  const pending = name.split('/').filter(Boolean);
  const resolved = root === '' ? [] : root.split('/');
  const depth = resolved.length;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift()!;
    const dir = resolved.join('/');
    const searched = (yield { stat: '/' + dir }) as Exclude<BeneathAnswer, string>;
    if (searched === null) throw fsError('ENOENT', 'path', path);
    if (searched.type !== 'directory') throw fsError('ENOTDIR', 'path', path);
    if (!modeAllows(searched, 1, cred)) throw fsError('EACCES', 'path', path);
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === depth) throw fsError('ENOTCAPABLE', 'path', path);
      resolved.pop();
      continue;
    }
    // Every component already walked is a directory, not a link, so a
    // lookup by its literal name is the walk's own.
    const candidate = dir === '' ? segment : `${dir}/${segment}`;
    const isFinal = pending.length === 0;
    const stat = (yield { stat: '/' + candidate }) as Exclude<BeneathAnswer, string>;
    if (stat === null && !isFinal) throw fsError('ENOENT', 'path', path);
    if (stat === null || stat.type !== 'symlink' || (isFinal && !follow)) {
      resolved.push(segment);
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    const target = (yield { readlink: '/' + candidate }) as string;
    if (target.startsWith('/')) throw fsError('ENOTCAPABLE', 'path', path);
    pending.unshift(...target.split('/').filter(Boolean));
  }
  return resolved.join('/');
}

/** A confined path, and whether a mount other than the SQLite root owns it. */
type Located =
  | { mount: SyncVFS; path: string; absent?: undefined }
  /** `absent`: the one walk on SQLite ended at an absent name (walkOnSqlite). */
  | { mount?: undefined; path: string; absent?: true };

/** What one buffered mount handle holds before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;

/** A mounted backend's optional operation, or ENOTSUP when it has none. */
function mountOp<F extends (...args: never[]) => unknown>(fn: F | undefined, ...args: [call: string, path: RuntimeFsPath] | [call: FsCall]): F {
  if (typeof fn !== 'function') throw callError('ENOTSUP', args.length === 2 ? { syscall: args[0], path: args[1] } : args[0]);
  return fn;
}

/** Depth-first removal with base operations, for a backend without its own. */
function removeTree(mount: SyncVFS, path: string): void {
  const stat = mount.stat(path, { follow: false });
  if (stat === null) throw fsError('ENOENT', 'rm', path);
  if (stat.type === 'directory') {
    for (const entry of mount.readdir(path)) removeTree(mount, `${path === '/' ? '' : path}/${entry.name}`);
    mountOp(mount.rmdir, 'rmdir', path)(path);
  } else {
    mount.unlink(path);
  }
}

/** POSIX rwx for `cred` on a stat: root reads and writes anything and executes what anyone may. */
export function modeAllows(stat: { mode?: number; uid?: number; gid?: number }, want: number, cred: { uid: number; gid: number; groups: readonly number[] }): boolean {
  const requested = want & 7;
  if (requested === 0 || stat.mode === undefined) return true;
  const perms = stat.mode & 0o777;
  if (cred.uid === 0) return (requested & 1) === 0 || (perms & 0o111) !== 0;
  const shift = cred.uid === stat.uid ? 6 : cred.gid === stat.gid || cred.groups.includes(stat.gid ?? -1) ? 3 : 0;
  return ((perms >> shift) & requested) === requested;
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

/** One call as Node names it in its errors: the syscall, its path, and the second path of a call naming two. */
interface FsCall {
  syscall: string;
  path: RuntimeFsPath;
  dest?: RuntimeFsPath;
}

/** An error carrying the fields Node's `fs` puts on a failed syscall. */
interface FsError extends Error {
  code: string;
  syscall: string;
  path: string;
  /** The second path of a call that names two (rename, symlink's link). */
  dest?: string;
}

/** mkdir -p of a mounted path's parent. */
function mountParents(mount: SyncVFS, path: string): void {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent !== '') mount.mkdir(parent, { recursive: true });
}

/**
 * Node's error for `syscall` failing on `path`: `ENOENT: no such file or
 * directory, open 'x'`, and `rename 'a' -> 'b'` for a call naming `dest` too.
 */
export function fsError(code: string, syscall: string, path: RuntimeFsPath, dest?: RuntimeFsPath): FsError {
  const name = typeof path === 'string' ? path : path.path;
  const second = dest === undefined ? undefined : typeof dest === 'string' ? dest : dest.path;
  const description = errnoDescription(code);
  const message = `${code}: ${description === undefined ? '' : `${description}, `}${syscall} '${name}'${second === undefined ? '' : ` -> '${second}'`}`;
  return Object.assign(new Error(message), { code, syscall, path: name, ...(second === undefined ? {} : { dest: second }) });
}

/** Node's error for `call` failing with `code`, built from the call's own arguments. */
function callError(code: string, call: FsCall): FsError {
  return fsError(code, call.syscall, call.path, call.dest);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
