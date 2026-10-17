import { ROOT_DIRECTORY_MODE, ROOT_INODE, type CredentialedVfs, type DelegationTerms, type SqliteVFS, type VfsNameResolution, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { BUFFERED_WRITE_BYTES, describeMounted, flagsRefusal, openAccess, openFollows, openMounted, reopenMounted } from '../vfs/mounted-description.js';
import { closeDescriptions, closeScopeSignal, createDescriptorScope, Descriptors, openFlags, processView, reportLost, scopeAccess, settleHeldAt, type Authority, type Description } from './descriptors.js';
import type { WaveDescriptions, WriteStreamOptions } from './wave-contracts.js';
import { WaveIngest } from './wave-ingest.js';
import { runtimeStatOf, type CompositeVFS } from '../vfs/composite.js';
import { abandon, andThen, isCharacterDevice, isPromise, readDeclaredSource, readRangeOrWhole, syncValue, type Awaitable, type SyncVFS, type VfsRemoval } from '../vfs/vfs.js';
import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { fsError, MAX_LINK_HOPS, walkBeneath, type FsError } from './beneath-walk.js';
import { modeAllows } from '../vfs/posix-access.js';

export { fsError, walkBeneath, type BeneathLookup } from './beneath-walk.js';
import type {
  RuntimeFileHandle,
  RuntimeOpenedFile,
  RuntimeFsPath,
  RuntimeReadFileOptions,
  RuntimeReadOptions,
  RuntimeSynchronousFs,
  RuntimeFsBridge,
  RuntimeOpenFlags,
  RuntimeReopenTarget,
  RuntimeVfsDirEntry,
  RuntimeVfsStat,
  VfsAcquireOptions,
  VfsAcquireResult,
  VfsListPage,
  VfsMutationReceipt,
  RuntimeMutationOwner,
  ExclusiveMutationGrant,
  ExclusiveMutationRequest,
  FsTime,
} from './os-contracts.js';

export class SqliteRuntimeFsBridge implements RuntimeFsBridge {
  readonly synchronous: RuntimeSynchronousFs = this;
  private readonly vfs: CredentialedVfs;

  /** The namespace as this caller sees it: what a path off the SQLite root reaches. */
  private readonly mounted: CompositeVFS['sync'] | undefined;

  private readonly descriptors: Descriptors;

  constructor(
    vfs: CredentialedVfs,
    private readonly rawVfs: SqliteVFS,
    private readonly scope = createDescriptorScope(),
    private readonly namespace?: CompositeVFS,
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    private readonly bufferedWriteBytes: number = BUFFERED_WRITE_BYTES,
    /** The namespace's wave ingestion (ProcessFiles.waves); without a namespace, none places anything elsewhere. */
    private readonly waves: WaveIngest = new WaveIngest(null),
    /** Its binding's Authority, its standing (Descriptors' `owned`), and its caller's abort; else its scope alone. */
    private readonly binding: { authority: Authority; owned: Authority; signal?: AbortSignal } = scopeAccess(scope),
  ) {
    this.vfs = vfs;
    this.mounted = namespace?.sync;
    this.descriptors = new Descriptors(scope, () => rawVfs.revision(), binding.authority, binding.owned, true);
  }

  dispose(): Awaitable<void> {
    const lost = closeDescriptions(this.scope);
    closeScopeSignal(this.scope);
    return andThen(lost, reportLost);
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
    return { mount: mounted, namespace: this.namespace!, path: '/' + resolved };
  }

  /**
   * The path resolved in one walk on SQLite (SqliteVFS.resolveName), or null
   * for the walk component by component (resolveDataPath): for a walk
   * beneath a root, for a spelling with `..` (that walk takes `..`
   * physically, after the link before it, where the engine's names take it
   * lexically), and where the namespace lays a mount or a directory above
   * one.
   */
  private walkOnSqlite(path: RuntimeFsPath, followSymlinks: boolean): VfsNameResolution | null {
    if (typeof path !== 'string' && path.beneath) return null;
    const spelled = this.pathArgument(path);
    if (DOT_DOT_SEGMENT.test(spelled)) return null;
    const namespace = this.namespace;
    return this.vfs.resolveName(spelled, followSymlinks, namespace && ((name) => namespace.composes('/' + name)));
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
    return called({ syscall: options.followSymlinks === false ? 'lstat' : 'stat', path }, () => {
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
        const viewed = stat !== null && stat.type === 'file' ? this.processView(located, followSymlinks) : undefined;
        if (viewed) return { ...runtimeStatOf(stat!), size: viewed.byteLength };
        return stat === null ? null : runtimeStatOf(stat);
      }
      const p = located.path;
      // The walk met the absent name itself; the engine would only say ENOENT.
      if (located.absent) return null;
      if (p === '') return this.rootStat();
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
        // lstat answers a name below a non-directory as not there.
        if (hasErrorCode(error, 'ENOENT') || (!followSymlinks && hasErrorCode(error, 'ENOTDIR'))) return null;
        throw error;
      }
    });
  }

  readFile(path: RuntimeFsPath, options: RuntimeReadFileOptions = {}): Uint8Array | null {
    return called({ syscall: 'open', path }, () => {
      const located = this.locate(path, options.followSymlinks !== false);
      if (located === null || located.absent) return null;
      try {
        if (options.maxBytes !== undefined) {
          // A bounded whole read is SQLite's alone, where the size check and
          // the read are one turn: a mount's stat and read are two calls, and
          // its read is of the whole file, whatever it has grown to.
          if (located.mount) throw fsError('EFBIG', 'read', path);
          if (!fitsWholeRead(this.vfs.stat(located.path), options.maxBytes)) throw fsError('EFBIG', 'read', path);
        }
        // cached === false reads straight from SQL, neither consulting nor
        // populating the LRU: a whole runtime image is read once for a
        // facet's module map, never re-read from this isolate. Mount
        // backends have no LRU, so their readFile is already uncached.
        if (!located.mount) {
          return options.cached === false
            ? this.vfs.readFileUncached(located.path)
            : this.vfs.readFile(located.path);
        }
        const bytes = this.processView(located, options.followSymlinks !== false) ?? located.mount.readFile(located.path);
        // An uncached read hands back bytes of its own, as SQLite's does: a
        // mount's may be the very bytes it keeps.
        return options.cached === false && bytes !== null ? bytes.slice() : bytes;
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
      }
    });
  }

  /** Before a cut of a mounted file (a truncate, a whole-file write): the writes this process holds on it, written (settleHeldAt). */
  private settleAt(located: { namespace: CompositeVFS; path: string }): void {
    syncValue(settleHeldAt(this.scope, () => located.namespace.pin(located.path, { follow: true, sync: true })));
  }

  /** A mounted file as this process sees it, its pending writes applied (processView); undefined when it holds none. */
  private processView(located: { namespace: CompositeVFS; path: string }, follow: boolean): Uint8Array | undefined {
    // The synchronous face pins through synchronous faces only: every answer is a value.
    return syncValue(processView(this.scope, () => located.namespace.pin(located.path, { follow, sync: true })));
  }

  writeFile(
    path: RuntimeFsPath,
    bytes: string | Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number; umask?: number } = {},
  ): number {
    return called({ syscall: 'write', path }, () => {
      const located = this.locateMutation(path, true, 'write');
      if (located.mount) {
        if (options.expectedRevision !== undefined) throw fsError('ESTALE', 'write', path);
        if (options.createParents === true) mountParents(located.mount, located.path);
        this.settleAt(located);
        located.mount.writeFile(located.path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
        return this.rawVfs.revision();
      }
      const p = located.path;
      this.assertExpectedRevision(p, options.expectedRevision);
      if (options.createParents === true) this.ensureParent(p);
      this.vfs.writeFile(p, bytes, { umask: options.umask });
      // Read back in the same synchronous turn as the mutation, so nothing can
      // interleave: this is exactly the revision this write produced. Asking
      // again after an await would report a peer's clock as our own.
      return this.rawVfs.revision();
    });
  }

  async writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number> {
    try {
      return await this.writeFileFromSource(path, size, source);
    } catch (error) {
      throw failure(error, { syscall: 'write', path });
    }
  }

  private async writeFileFromSource(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number> {
    const located = this.locateMutation(path, true, 'write');
    if (!located.mount) return await this.vfs.writeFileFrom(located.path, size, source);
    // A mounted filesystem has no staging to publish from, so it takes the
    // whole file in one write: nothing reaches it until the source is read,
    // and a source that fails changes nothing.
    const data = await readDeclaredSource(source, size, () => fsError('EINVAL', 'write', path));
    this.settleAt(located);
    located.mount.writeFile(located.path, data);
    return this.rawVfs.revision();
  }

  readRange(
    path: RuntimeFsPath,
    offset: number,
    length: number,
    options: RuntimeReadOptions = {},
  ): Uint8Array | null {
    return called({ syscall: 'read', path }, () => {
      if ((options.expectedEpoch === undefined) !== (options.expectedRevision === undefined)) {
        throw fsError('EINVAL', 'read', path);
      }
      const located = this.locate(path, options.followSymlinks !== false);
      if (located === null) return null;
      if (located.mount) {
        if (options.expectedEpoch !== undefined) throw fsError('ESTALE', 'read', path);
        const mount = located.mount;
        const viewed = this.processView(located, options.followSymlinks !== false);
        if (viewed) return viewed.slice(offset, offset + length);
        return readRangeOrWhole(mount, located.path, offset, length);
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
    });
  }

  writeRange(
    path: RuntimeFsPath,
    offset: number,
    bytes: Uint8Array,
    options: { createParents?: boolean; expectedRevision?: number } & RuntimeMutationOwner = {},
  ): VfsMutationReceipt {
    return called({ syscall: 'write', path }, () => {
      const located = this.locateMutation(path, true, 'write', options.mutationOwner);
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
      return this.receipted(p, () => this.owned(options.mutationOwner).writeRange(p, offset, bytes));
    });
  }

  /** This caller's view, presenting `owner`'s exclusive mutation lease when it names one. */
  private owned(owner: string | undefined): CredentialedVfs {
    return owner === undefined ? this.vfs : this.rawVfs.as(this.vfs.cred, { mutationOwner: owner, actor: this.vfs.principal.actor, holds: this.vfs.holds });
  }

  truncate(
    path: RuntimeFsPath,
    size: number,
    options: { followSymlinks?: boolean } & RuntimeMutationOwner = {},
  ): VfsMutationReceipt {
    return called({ syscall: 'truncate', path }, () => {
      const located = this.locateMutation(path, options.followSymlinks !== false, 'truncate', options.mutationOwner);
      if (located.mount) {
        this.settleAt(located);
        mountOp(located.mount.truncate, 'truncate', path)(located.path, size);
        return this.mountReceipt();
      }
      const p = located.path;
      if (!this.vfs.exists(p)) throw fsError('ENOENT', 'truncate', path);
      if (this.vfs.isDirectory(p)) throw fsError('EISDIR', 'truncate', path);
      return this.receipted(p, () => this.owned(options.mutationOwner).truncate(p, size));
    });
  }

  utimes(path: RuntimeFsPath, atime: FsTime, mtime: FsTime, options: { followSymlinks?: boolean } = {}): VfsMutationReceipt {
    return called({ syscall: 'utimes', path }, () => {
      const follow = options.followSymlinks !== false;
      const located = this.locateMutation(path, follow, 'utimes');
      if (located.mount) {
        mountOp(located.mount.utimes, 'utimes', path)(located.path, atime, mtime);
        return this.mountReceipt();
      }
      const p = located.path;
      if (!(follow ? this.vfs.exists(p) : this.vfs.isSymlink(p) || this.vfs.exists(p))) throw fsError('ENOENT', 'utimes', path);
      return this.receipted(p, () => this.vfs.utimes(p, atime, mtime, { followSymlinks: follow }));
    });
  }

  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt {
    return called({ syscall: 'chmod', path }, () => {
      const located = this.locateMutation(path, true, 'chmod');
      if (located.mount) { mountOp(located.mount.chmod, 'chmod', path)(located.path, mode); return this.mountReceipt(); }
      const p = located.path;
      if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chmod', path);
      return this.receipted(p, () => this.vfs.chmod(p, mode));
    });
  }

  access(path: RuntimeFsPath, mode: number): void {
    return called({ syscall: 'access', path }, () => {
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
    });
  }

  chown(
    path: RuntimeFsPath,
    uid: number | null,
    gid: number | null,
    options: { followSymlinks?: boolean } = {},
  ): VfsMutationReceipt {
    return called({ syscall: 'chown', path }, () => {
      const followSymlinks = options.followSymlinks !== false;
      const located = this.locateMutation(path, followSymlinks, 'chown');
      if (located.mount) { mountOp(located.mount.chown, 'chown', path)(located.path, uid, gid); return this.mountReceipt(); }
      const p = located.path;
      if (!this.vfs.exists(p)) throw fsError('ENOENT', 'chown', path);
      return this.receipted(p, () => this.vfs.chown(p, uid, gid, { followSymlinks }));
    });
  }

  /** `options.mutationOwner`: the exclusive-mutation lease an open for writing presents (a read-only open presents none). */
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags, options: RuntimeMutationOwner = {}): RuntimeOpenedFile {
    return called({ syscall: 'open', path }, () => {
      const normalizedFlags = openFlags(flags);
      const flagged = flagsRefusal(normalizedFlags);
      if (flagged !== null) throw fsError(flagged, 'open', path);
      const mutates = normalizedFlags.write || normalizedFlags.create ||
        normalizedFlags.truncate || normalizedFlags.append;
      const owner = mutates ? options.mutationOwner : undefined;
      // The name is looked up as the open decides it (openFollows): O_CREAT|O_EXCL answers for the name itself.
      const follows = openFollows(normalizedFlags);
      const located = mutates
        ? this.locateMutation(path, follows, 'open', owner)
        : this.locate(path, follows);
      if (located === null) throw fsError('ELOOP', 'open', path);
      if (located.mount) {
        const namespace = located.namespace;
        // The synchronous face looks up through synchronous faces only (an asynchronous mount refused above): its answer is a value.
        return syncValue(this.descriptors.open(syncValue(openMounted({
          name: located.path, flags: normalizedFlags, mode: flags.mode,
          refuse: (code, syscall) => fsError(code, syscall, path), scope: this.scope, pin: (name, follow) => namespace.pin(name, { follow, sync: true }),
          sync: flags.sync === true, bufferedWriteBytes: this.bufferedWriteBytes, ...(this.binding.signal === undefined ? {} : { signal: this.binding.signal }),
        })), normalizedFlags));
      }
      const p = located.path;
      if (p === '') return this.openRoot(path, normalizedFlags);
      if (flags.path === true) {
        // There is no descriptor on the link itself, as open's below.
        if (!normalizedFlags.followSymlinks && this.vfs.isSymlink(p)) throw fsError(normalizedFlags.directory ? 'ENOTDIR' : 'ELOOP', 'open', path);
        const held = this.rawVfs.holdInode(p, this.vfs.cred, this.vfs.principal, this.vfs.holds);
        if (normalizedFlags.directory && held.stat().type !== 'directory') { held.close(); throw fsError('ENOTDIR', 'open', path); }
        return syncValue(this.descriptors.open(held, normalizedFlags, p, held.revision()));
      }
      // open(2)'s rule, in Linux's order, as a mount's open decides it (openOnMount).
      if (normalizedFlags.exclusive && normalizedFlags.create && (this.vfs.isSymlink(p) || this.vfs.exists(p))) throw fsError('EEXIST', 'open', path);
      // There is no descriptor to open on the link itself: what it points at is exactly what the caller declined to open.
      if (!normalizedFlags.followSymlinks && this.vfs.isSymlink(p)) throw fsError(normalizedFlags.directory ? 'ENOTDIR' : 'ELOOP', 'open', path);
      this.assertExpectedRevision(p, normalizedFlags.expectedRevision);

      const exists = this.vfs.exists(p);
      if (!exists && !normalizedFlags.create) throw fsError('ENOENT', 'open', path);
      const directory = exists && this.vfs.isDirectory(p);
      if (directory && normalizedFlags.create) throw fsError('EISDIR', 'open', path);
      if (normalizedFlags.directory && !directory) throw fsError('ENOTDIR', 'open', path);
      // A directory opens whatever rights were asked for: a WASI guest
      // requests a capability set, not an access mode, and a directory simply
      // never grants fd_write (the write itself answers EISDIR). What refuses
      // here is content the open would change.
      if (directory && (normalizedFlags.truncate || normalizedFlags.append)) throw fsError('EISDIR', 'open', path);
      if (exists) this.vfs.access(p, openAccess(normalizedFlags, directory));
      if (!exists) {
        this.owned(owner).writeFile(p, new Uint8Array(0), { mode: flags.mode, umask: flags.umask });
      } else if (normalizedFlags.truncate) {
        this.owned(owner).truncate(p, 0);
      }

      const node = this.rawVfs.openDescription(p, this.vfs.cred, { ...normalizedFlags, sync: flags.sync === true }, this.vfs.principal, this.vfs.holds, owner);
      // Its revision is its name's, read off the description, not looked up again.
      return syncValue(this.descriptors.open(node, normalizedFlags, p, node.revision()));
    });
  }

  // A description on an asynchronous mount refuses this synchronous face's
  // operations, as its mount does (Descriptors' synchronous); every other
  // answers in the caller's turn, so their answers are values.
  read(handleId: number, offset: number | null, length: number): Uint8Array {
    return syncValue(this.descriptors.read(handleId, offset, length));
  }

  write(handleId: number, offset: number | null, bytes: Uint8Array): number {
    return syncValue(this.descriptors.write(handleId, offset, bytes));
  }

  /** A description that awaits, closed by a caller that cannot wait: its backend's close answers no one (it holds no writes: each landed as made). */
  close(handleId: number): void {
    const closed = this.descriptors.close(handleId);
    if (isPromise(closed)) closed.catch(() => {});
  }

  readdir(path: RuntimeFsPath, options: { followSymlinks?: boolean } = {}): RuntimeVfsDirEntry[] {
    return called({ syscall: 'scandir', path }, () => {
      const located = this.locate(path, options.followSymlinks !== false);
      if (located === null) return [];
      if (located.mount) return located.mount.readdir(located.path).map((entry) => ({ name: entry.name, type: entry.type }));
      const p = located.path;
      const entries = new Map<string, RuntimeVfsDirEntry>();
      // What the namespace itself puts in `/` (proc, dev, an embedder's mounts) is listed with it.
      if (p === '' && this.namespace) {
        for (const entry of this.namespace.mountedNames('/')) entries.set(entry.name, { name: entry.name, type: entry.type });
      }
      for (const entry of this.vfs.readdir(p)) entries.set(entry.name, { name: entry.name, type: entry.type });
      return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  mkdir(path: RuntimeFsPath, options: { recursive?: boolean; mode?: number; umask?: number } & RuntimeMutationOwner = {}): void {
    return called({ syscall: 'mkdir', path }, () => {
      const owner = options.mutationOwner;
      let located: Located;
      if (options.recursive) {
        const found = this.locate(path, false);
        if (found === null) {
          this.leaseAllows(this.pathArgument(path), owner);
          throw callError('ELOOP', { syscall: 'mkdir', path });
        }
        // A recursive mkdir of a directory already there changes nothing, so
        // it meets no lease: a sibling's write makes its parents while another
        // owner holds a subtree beside it. It stats the name, following links,
        // as coreutils and Node do after EEXIST: a link to a directory is
        // already there.
        if (this.mayExist(found) && this.stat(path)?.type === 'directory') return;
        // A lease on a directory also covers names inside it that resolve
        // elsewhere through a symlink, so the literal path is checked as well.
        this.leaseAllows(this.pathArgument(path), owner);
        located = this.reached(found, owner);
      } else {
        located = this.locateMutation(path, false, 'mkdir', owner);
      }
      if (located.mount) { located.mount.mkdir(located.path, { recursive: !!options.recursive, mode: options.mode }); return; }
      // mkdir of what is there is EEXIST, as mkdir(2) says, before any
      // permission check on its parent (`/` has none).
      if (this.mayExist(located)) throw fsError('EEXIST', 'mkdir', path);
      this.owned(owner).mkdir(located.path, { recursive: !!options.recursive, mode: options.mode, umask: options.umask });
    });
  }

  /**
   * Whether anything may be at `located`: a mounted name (its mount
   * answers), `/` (which has no row), or a row. A walk that met the name
   * absent has looked at all of them.
   */
  private mayExist(located: Located): boolean {
    if (located.mount) return true;
    if (located.absent) return false;
    const p = located.path;
    return p === '' || this.vfs.exists(p);
  }

  unlink(path: RuntimeFsPath, options: RuntimeMutationOwner = {}): void {
    return called({ syscall: 'unlink', path }, () => {
      const located = this.locateMutation(path, false, 'unlink', options.mutationOwner);
      if (located.mount) { located.mount.unlink(located.path); return; }
      const p = located.path;
      if (!this.vfs.exists(p)) throw fsError('ENOENT', 'unlink', path);
      this.owned(options.mutationOwner).unlink(p);
    });
  }

  rmdir(path: RuntimeFsPath, options: RuntimeMutationOwner = {}): void {
    return called({ syscall: 'rmdir', path }, () => {
      const located = this.locateMutation(path, false, 'rmdir', options.mutationOwner);
      if (located.mount) { mountOp(located.mount.rmdir, 'rmdir', path)(located.path); return; }
      const p = located.path;
      // rmdir(2): a missing path is ENOENT, anything but a directory (a file, a link) ENOTDIR.
      if (!this.vfs.exists(p)) throw fsError('ENOENT', 'rmdir', path);
      if (!this.vfs.isDirectory(p)) throw fsError('ENOTDIR', 'rmdir', path);
      this.owned(options.mutationOwner).rmdir(p);
    });
  }

  rename(from: RuntimeFsPath, to: RuntimeFsPath, options: RuntimeMutationOwner = {}): void {
    // Every refusal names the call's own two paths, whichever lookup met it.
    const call: FsCall = { syscall: 'rename', path: from, dest: to };
    return called(call, () => {
      const source = this.locateMutation(from, false, call, options.mutationOwner);
      const target = this.locateMutation(to, false, call, options.mutationOwner);
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
      if (!this.vfs.exists(oldPath)) throw callError('ENOENT', call);
      this.assertParentDirectory(newPath, call);
      this.owned(options.mutationOwner).rename(oldPath, newPath);
    });
  }

  readlink(path: RuntimeFsPath): string | null {
    return called({ syscall: 'readlink', path }, () => {
      const located = this.locate(path, false);
      if (located === null) return null;
      if (located.mount) return mountOp(located.mount.readlink, 'readlink', path)(located.path);
      const p = located.path;
      return this.vfs.isSymlink(p) ? this.vfs.readlink(p) : null;
    });
  }

  symlink(target: string, path: RuntimeFsPath): void {
    // Node names the target, then the link.
    const call: FsCall = { syscall: 'symlink', path: target, dest: path };
    return called(call, () => {
      const located = this.locateMutation(path, false, call);
      if (located.mount) { mountOp(located.mount.symlink, call)(target, located.path); return; }
      const p = located.path;
      if (this.vfs.exists(p)) throw callError('EEXIST', call);
      this.vfs.symlink(target, p);
    });
  }

  fsync(handleId?: number): void {
    if (handleId !== undefined) syncValue(this.descriptors.fsync(handleId));
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

  realpath(path: RuntimeFsPath): string {
    return called({ syscall: 'realpath', path }, () => {
      const resolved = this.walkOnSqlite(path, true)?.name ?? this.resolveDataPath(path, true);
      if (resolved === null) throw fsError('ELOOP', 'realpath', path);
      if (resolved === '') return '/';
      if (this.namespace?.composes('/' + resolved)) return this.namespace.realpath('/' + resolved);
      this.vfs.stat(resolved);
      return '/' + resolved;
    });
  }

  remove(path: RuntimeFsPath, options: { recursive?: boolean; force?: boolean; report?: boolean; keepVanishedAncestors?: boolean } = {}): void | VfsRemoval {
    return called({ syscall: 'remove', path }, () => {
      try {
        if (!options.recursive) { this.unlink(path); return; }
        const located = this.locateMutation(path, false, options.report ? 'rm' : 'remove');
        const policy = { keepVanishedAncestors: options.keepVanishedAncestors };
        // A tree in the store, its report not asked for, goes without the namespace's routing.
        const report = located.mount ? located.mount.removeRecursive(located.path, policy)
          : options.report && this.namespace !== undefined ? this.namespace.sync.removeRecursive('/' + located.path, policy)
            : this.vfs.removeRecursive('/' + located.path, policy);
        if (options.report) return report;
        const failed = report.failures[0];
        if (failed) throw failed.error;
      } catch (error) {
        if (!(options.force && hasErrorCode(error, 'ENOENT'))) throw error;
      }
    });
  }

  copyFile(from: RuntimeFsPath, to: RuntimeFsPath, options?: { keepMode?: boolean; preserve?: boolean }): void {
    const call: FsCall = { syscall: 'copyfile', path: from, dest: to };
    return called(call, () => {
      const source = this.locate(from, true);
      if (source === null) throw callError('ELOOP', call);
      const target = this.locateMutation(to, true, call);
      if (!source.mount && !target.mount) { this.vfs.copyFile(source.path, target.path, { keepMode: options?.keepMode, preserve: options?.preserve }); return; }
      // Across filesystems, the namespace's copy, from the file the source leads to (a backend that resolves its own paths follows it there).
      this.mounted!.copy(source.mount ? source.path : '/' + source.path, target.mount ? target.path : '/' + target.path, { follow: true, keepMode: options?.keepMode, preserve: options?.preserve });
    });
  }

  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean; follow?: boolean }): Promise<number> {
    const call: FsCall = { syscall: 'cp', path: from, dest: to };
    return called(call, () => {
      const source = this.locate(from, options?.follow === true);
      if (source === null) throw callError('ELOOP', call);
      const target = this.locateMutation(to, false, call);
      if (source.mount || target.mount) throw callError('EXDEV', call);
      return this.vfs.copyTreeAsync(source.path, target.path, { preserve: options?.preserve });
    }).catch((error: unknown) => { throw failure(error, call); });
  }

  /** Where the namespace places it: atomic on SQLite, a routed wave when a record lands on a mount. */
  writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0], options?: { signal?: AbortSignal }) {
    return this.waves.writeBatch(this.vfs, payload, options);
  }

  writeStream(stream: ReadableStream<Uint8Array>, options?: WriteStreamOptions) {
    return this.waves.writeStream(this.vfs, stream, { ...options, descriptions: this.waveDescriptions });
  }

  /**
   * The open descriptions a process's waves name (WaveDescriptions): each one
   * this binding's descriptor, so the process reads, stats and closes it as
   * any of its own; its access decided at its open (SqliteVFS.describeInode),
   * and its file alive until its close.
   */
  private readonly waveDescriptions: WaveDescriptions = {
    adopt: (id, ino, rights, path, cred) => {
      const node = this.rawVfs.describeInode(ino, path, cred, rights, this.vfs.principal, this.vfs.holds);
      return node === null ? null : this.keepWaveDescription(id, node, rights);
    },
    // Each write of a wave's description is in its mount before the wave is answered (sync).
    describe: (id, file, ino, rights) => andThen(file.hold(rights, ino), (held) => {
      // Released while its file was found: nothing would close it.
      if (this.scope.closed) {
        abandon(held);
        throw fsError('EBADF', 'open', file.name);
      }
      return this.keepWaveDescription(id, describeMounted({
        scope: this.scope, refuse: (code, syscall) => fsError(code, syscall, file.name), sync: true, bufferedWriteBytes: this.bufferedWriteBytes,
      }, held, ino), rights);
    }),
    node: (id) => {
      const node = this.waveDescription(id);
      // The engine's, on this filesystem: a mount's is the binding's alone (mounted).
      return node?.mounted ? undefined : node;
    },
    mounted: (id) => {
      const node = this.waveDescription(id);
      return node?.mounted ? node : undefined;
    },
    handle: (id) => {
      const handleId = this.scope.waveDescriptions.get(id);
      return handleId !== undefined && this.scope.handles.has(handleId) ? handleId : undefined;
    },
    close: (id) => {
      const handleId = this.scope.waveDescriptions.get(id);
      if (handleId === undefined) return;
      this.scope.waveDescriptions.delete(id);
      if (this.scope.handles.has(handleId)) return this.descriptors.close(handleId);
    },
  };

  private waveDescription(id: string): Description | undefined {
    const handleId = this.scope.waveDescriptions.get(id);
    return handleId === undefined ? undefined : this.scope.handles.get(handleId)?.node;
  }

  /** `node`, the description a wave's open of `id` made: the session's descriptor of it. */
  private keepWaveDescription(id: string, node: Description, rights: { read: boolean; write: boolean }): number {
    const handle = this.descriptors.issue(node, openFlags({ read: rights.read, write: rights.write }));
    // The same id opened again (an open re-sent after its answer was lost is answered, not applied): the newer is it.
    const prior = this.scope.waveDescriptions.get(id);
    if (prior !== undefined && this.scope.handles.has(prior)) this.close(prior);
    this.scope.waveDescriptions.set(id, handle.id);
    return handle.id;
  }

  /**
   * A lease; with `held`, a process's own (ProcessFiles' bridge), which ends
   * with the process; with its `terms`, a delegation, whose recalls that
   * bridge answers. This bridge serves no process, so it delegates nothing
   * itself (`delegate`: EINVAL).
   */
  acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest, held?: { terms?: DelegationTerms }): ExclusiveMutationGrant {
    return called({ syscall: 'acquireExclusiveMutation', path }, () => {
      const terms = held?.terms;
      if (options?.delegate !== undefined && terms === undefined) throw fsError('EINVAL', 'acquireExclusiveMutation', path);
      const p = this.sqlitePath(path, false, 'acquireExclusiveMutation');
      const parent = parentVfsPath(p);
      if (parent && !(options?.includeMissingAncestors && !this.vfs.exists(parent))) this.vfs.access(parent, 0o3);
      const lease = this.vfs.acquireExclusiveMutation(p, {
        includeMissingAncestors: options?.includeMissingAncestors, delegation: terms, stoppable: held !== undefined,
      });
      return terms === undefined ? lease : { ...lease, umask: this.vfs.cred.umask };
    });
  }

  releaseExclusiveMutation(owner: string): void { this.rawVfs.releaseExclusiveMutation(owner); }

  acquireReadLease(terms: DelegationTerms, at: { readonly epoch: string; readonly cursor: number }): { readonly owner: string } {
    return this.rawVfs.acquireReadLease(terms, at);
  }

  /** No process, so no delegation: whatever `owner` names is not one of this bridge's (ESTALE). */
  awaitRecall(owner: string): never {
    throw fsError('ESTALE', 'awaitRecall', owner, undefined, { detail: 'no delegation of this process under that lease' });
  }

  recalled(owner: string): never {
    throw fsError('ESTALE', 'recalled', owner, undefined, { detail: 'no delegation of this process under that lease' });
  }

  /** No process: its writes wait for their publication, so none is held. */
  published(): void {}

  private pathArgument(path: RuntimeFsPath): string {
    if (typeof path === 'string') return path;
    if ('root' in path) return path.root + '/' + path.path;
    const directory = path.directory;
    if (syncValue(this.descriptors.description(directory).stat()).type !== 'directory') throw fsError('ENOTDIR', 'path', path.path);
    if (path.path.startsWith('/')) return path.path;
    return this.descriptors.path(directory) + '/' + path.path;
  }

  private resolveDataPath(path: RuntimeFsPath, followSymlinks: boolean): string | null {
    if (typeof path !== 'string' && path.beneath) {
      // The root is found by name, so every directory above it must grant
      // search (VFS-COMP-006) before anything is looked up beneath it.
      const root = normalizeVfsPath('root' in path ? path.root : this.descriptors.path(path.directory));
      const walk = walkBeneath(root, path, followSymlinks, this.vfs.cred, (name, to) => this.namespace?.resolvedByBackend(name, '/' + root, to) === true);
      for (let step = walk.next(); ; ) {
        if (step.done) return step.value;
        const lookup = step.value;
        step = walk.next('readlink' in lookup
          ? this.linkLeadsTo(lookup.readlink, this.readlink(lookup.readlink) ?? '')
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
      // them, are never followed). The walk itself stays here, except on a
      // mount whose backend resolves its own paths: its links are its own.
      if (this.namespace?.composes('/' + candidate)) {
        const to = '/' + [...resolved, segment, ...pending].join('/');
        const link = this.namespace.resolvedByBackend('/' + candidate, '/', to) ? null : this.mountedLink('/' + candidate);
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

      if (this.vfs.kind(candidate) !== 'symlink') {
        resolved.push(segment);
        continue;
      }
      // The link's own target, walked here component by component as the
      // rest of the path is: it may lead onto a mount, which SQLite cannot
      // resolve inside itself (a link to /m/dir/x answered ENOENT at m).
      // Hops are counted, as Linux does (40): a link met again on a longer
      // path is one more hop, not a cycle.
      if (++hops > MAX_LINK_HOPS) return null;
      const target = this.vfs.readlink(candidate);
      // A relative target is taken from the link's directory under the
      // name the engine gives it: a confined caller may spell its own /tmp
      // by its storage name, and the engine names it /tmp.
      const from = target.startsWith('/') ? '' : this.vfs.resolveName(resolved.join('/'), false)?.name ?? resolved.join('/');
      resolved.length = 0;
      resolved.push(...from.split('/').filter(Boolean));
      pending.unshift(...target.split('/').filter(Boolean));
    }

    return resolved.join('/');
  }

  /**
   * A mounted (or composed) entry's link target, or null when it is not a
   * link or not there, or when the namespace has no name for where it leads
   * (linkLeadsTo): then the walk keeps the link's own name, and the
   * namespace hands it to the backend that follows it.
   */
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
    return this.linkLeadsTo(path, this.mounted!.readlink(path));
  }

  /** Where the link at `path`, reading `link`, leads: the namespace's link-root rule (CompositeVFS.linkLeadsTo); SQLite alone, its text. */
  linkLeadsTo(path: string, link: string): string | null {
    return this.namespace === undefined ? link : this.namespace.linkLeadsTo(path, link);
  }

  /** `call`: the syscall a refusal names, or the whole call when it names two paths. */
  private locateMutation(path: RuntimeFsPath, followSymlinks: boolean, call: string | FsCall, owner?: string): Located {
    // A lease on a directory also covers names inside it that resolve
    // elsewhere through a symlink, so the literal path is checked as well.
    this.leaseAllows(this.pathArgument(path), owner);
    const located = this.locate(path, followSymlinks);
    if (located === null) throw callError('ELOOP', typeof call === 'string' ? { syscall: call, path } : call);
    return this.reached(located, owner);
  }

  /** The name a mutation by `owner` reaches, checked against the leases on a mount as on SQLite. */
  private reached(located: Located, owner?: string): Located {
    this.leaseAllows(located.path, owner);
    // The namespace's own guard, which each mount call meets, is presented the lease too.
    if (located.mount && owner !== undefined) {
      const namespace = this.namespace!.scoped(() => {}, owner);
      return { ...located, mount: namespace.sync, namespace };
    }
    return located;
  }

  /**
   * Refuses a mutation at the namespace path `path` that another owner's
   * exclusive-mutation lease covers (EBUSY), or that lies outside the
   * caller's own lease root (EPERM). Leases are held on storage keys: a
   * confined caller's /tmp/x is its private file, not the shared tmp/x.
   */
  private leaseAllows(path: string, owner?: string): void {
    this.rawVfs.assertMutationAllowed(path, owner, this.vfs.holds, this.vfs.cred);
  }


  /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
  private sqlitePath(path: RuntimeFsPath, followSymlinks: boolean, call: string | FsCall): string {
    const located = this.locateMutation(path, followSymlinks, call);
    if (located.mount) throw callError('EXDEV', typeof call === 'string' ? { syscall: call, path } : call);
    return located.path;
  }

  reopen(target: RuntimeReopenTarget, flags: RuntimeOpenFlags, options: RuntimeMutationOwner = {}): RuntimeOpenedFile {
    const named = this.descriptors.openedAs(target.handle);
    return called({ syscall: 'open', path: named }, () => {
      const normalizedFlags = openFlags(flags);
      const flagged = flagsRefusal(normalizedFlags);
      if (flagged !== null) throw fsError(flagged, 'open', named);
      // The file is there: O_CREAT|O_EXCL names one that exists.
      if (normalizedFlags.create && normalizedFlags.exclusive) throw fsError('EEXIST', 'open', named);
      const mutates = normalizedFlags.write || normalizedFlags.truncate || normalizedFlags.append;
      const owner = mutates ? options.mutationOwner : undefined;
      const held = this.descriptors.description(target.handle);
      if (held.mounted) {
        const namespace = owner === undefined ? this.namespace! : this.namespace!.scoped(() => {}, owner);
        return syncValue(this.descriptors.open(syncValue(reopenMounted(held, {
          flags: normalizedFlags, mode: flags.mode, refuse: (code, syscall) => fsError(code, syscall, named), scope: this.scope,
          pin: (name, follow) => namespace.pin(name, { follow, sync: true }), sync: flags.sync === true, bufferedWriteBytes: this.bufferedWriteBytes,
          ...(this.binding.signal === undefined ? {} : { signal: this.binding.signal }),
        })), normalizedFlags));
      }
      if (held.ino === ROOT_INODE) return this.openRoot(named, normalizedFlags);
      const node = this.rawVfs.reopenInode(held.ino, named, this.vfs.cred, { read: normalizedFlags.read, write: normalizedFlags.write || normalizedFlags.truncate, sync: flags.sync === true }, this.vfs.principal, this.vfs.holds, owner);
      const kind = node.stat().type;
      if (normalizedFlags.directory && kind !== 'directory') { node.close(); throw fsError('ENOTDIR', 'open', named); }
      if (kind === 'directory' && (normalizedFlags.write || normalizedFlags.truncate || normalizedFlags.append)) { node.close(); throw fsError('EISDIR', 'open', named); }
      if (normalizedFlags.truncate) node.truncate(0);
      // Named as the descriptor it reopens was: an unlinked file has no name of its own.
      return syncValue(this.descriptors.open(node, normalizedFlags, named, node.revision()));
    });
  }

  private openRoot(path: RuntimeFsPath, flags: RuntimeFileHandle['flags']): RuntimeOpenedFile {
    if (flags.create && flags.exclusive) throw fsError('EEXIST', 'open', path);
    if (flags.create || flags.truncate || flags.append) throw fsError('EISDIR', 'open', path);
    const deny = (): never => { throw fsError('EPERM', 'fd', ''); };
    const node: VfsOpenDescription = {
      ino: ROOT_INODE, path: () => '', stat: () => this.rootStat(), revision: () => this.rawVfs.revision(),
      read: deny, write: deny, truncate: deny, readdir: () => this.readdir(''),
      chmod: deny, chown: deny, utimes: deny, close: () => {},
    };
    return syncValue(this.descriptors.open(node, flags));
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

  /** The absolute path a descriptor was opened at. */
  descriptorPath(handleId: number): string { return '/' + normalizeVfsPath(this.descriptors.path(handleId)); }

  fstat(handleId: number): RuntimeVfsStat { return syncValue(this.descriptors.fstat(handleId)); }
  dup(handleId: number): RuntimeFileHandle { return this.descriptors.dup(handleId); }
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number { return syncValue(this.descriptors.seek(handleId, offset, whence)); }
  setStatus(handleId: number, status: { append?: boolean }): void { this.descriptors.setStatus(handleId, status); }
  readdirHandle(handleId: number): RuntimeVfsDirEntry[] { return syncValue(this.descriptors.readdir(handleId)); }
  ftruncate(handleId: number, size: number): void { syncValue(this.descriptors.ftruncate(handleId, size)); }
  fchmod(handleId: number, mode: number): void { syncValue(this.descriptors.fchmod(handleId, mode)); }
  fchown(handleId: number, uid: number | null, gid: number | null): void { syncValue(this.descriptors.fchown(handleId, uid, gid)); }
  futimes(handleId: number, atime: FsTime, mtime: FsTime): void { syncValue(this.descriptors.futimes(handleId, atime, mtime)); }
}

/** A `..` component in a path's spelling. */
const DOT_DOT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

/** A confined path, and whether a mount other than the SQLite root owns it. */
type Located =
  /** `namespace`: the view `mount` is the synchronous face of (the lease it presents included). */
  | { mount: CompositeVFS['sync']; namespace: CompositeVFS; path: string; absent?: undefined }
  /** `absent`: the one walk on SQLite ended at an absent name (walkOnSqlite). */
  | { mount?: undefined; path: string; absent?: true };

/** A mounted backend's optional operation, or ENOTSUP when it has none. */
function mountOp<F extends (...args: never[]) => unknown>(fn: F | undefined, ...args: [call: string, path: RuntimeFsPath] | [call: FsCall]): F {
  if (typeof fn !== 'function') throw callError('ENOTSUP', args.length === 2 ? { syscall: args[0], path: args[1] } : args[0]);
  return fn;
}

/** One call as Node names it in its errors: the syscall, its path, and the second path of a call naming two. */
interface FsCall {
  syscall: string;
  path: RuntimeFsPath;
  dest?: RuntimeFsPath;
}


/** mkdir -p of a mounted path's parent. */
function mountParents(mount: SyncVFS, path: string): void {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent !== '') mount.mkdir(parent, { recursive: true });
}


/** Node's error for `call` failing with `code`, built from the call's own arguments. */
function callError(code: string, call: FsCall, options?: { detail?: string; cause?: unknown }): FsError {
  return fsError(code, call.syscall, call.path, call.dest, options);
}

/**
 * The error a failed call leaves the bridge with, as Node's for `call`. The
 * engine's own errors carry a code and name neither a call nor a path (their
 * message names a storage key): each is named for the call's syscall and the
 * caller's paths, keeps its reason (`detail`) and its own marks, and is the
 * cause. An error naming a call or a path (the bridge's own refusals, a
 * mount's, a pending import's) or carrying no code leaves as it is.
 */
function failure(error: unknown, call: FsCall): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return error;
  const named = ('syscall' in error && typeof error.syscall === 'string') || ('path' in error && typeof error.path === 'string');
  if (named) return error;
  const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : undefined;
  const marks = Object.fromEntries(Object.entries(error).filter(([key]) => !NAMING_FIELDS.has(key)));
  return Object.assign(callError(error.code, call, { detail, cause: error }), marks);
}

/** What `failure` names afresh; any other property an engine error carries is one of its marks, and stays. */
const NAMING_FIELDS: ReadonlySet<string> = new Set(['code', 'errno', 'syscall', 'path', 'dest', 'detail']);

/** `run`, as the bridge's public call `call`: whatever it fails with leaves as `failure` names it. */
function called<T>(call: FsCall, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw failure(error, call);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** A whole read's `maxBytes` (RuntimeReadFileOptions): a regular file of at most `maxBytes` bytes is read whole; a directory answers as a read does. */
export function fitsWholeRead(stat: { readonly type: string; readonly size: number; readonly mode?: number }, maxBytes: number): boolean {
  return stat.type === 'directory' || (stat.type === 'file' && !isCharacterDevice(stat.mode) && stat.size <= maxBytes);
}
