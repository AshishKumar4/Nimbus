/**
 * SqliteVFS as a `VFS`: what a CompositeVFS mounts.
 *
 * The engine keeps its own POSIX surface (CredentialedVfs, keys without a
 * leading slash, stat that throws); this is the same credentialed view
 * speaking the filesystem interface. It is synchronous (its `sync` is
 * itself), credentialed (`as(cred)` is another principal's view of the same
 * database), and revisioned: every stat carries the row's revision, so a
 * cache over it can see a change. Errors become VfsError with the engine's
 * code.
 */
import { ROOT_DIRECTORY_MODE, ROOT_INODE, type CredentialedVfs, type SqliteVFS, type VfsStat as SqliteStat } from './sqlite-vfs.js';
import type { SyncVFS, VFS, VfsCasResult, VfsChanges, VfsCopyOptions, VfsCred, VfsDirent, VfsOpenFile, VfsRemoval, VfsRevision, VfsStat, VfsViewOptions, VfsWriteObserver } from './vfs.js';
import { syscallError, toVfsError, VfsError, VFS_ERRNO, type VfsErrorCode } from './vfs-error.js';
import { projectChange, type VfsEvent } from './events.js';
import { normalizeVfsPath } from './path.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';

function absolute(key: string): string {
  return key.startsWith('/') ? key : `/${key}`;
}

/**
 * A revision is the row's generation qualified by the database's epoch: a
 * restore or reset can reuse generations, and a revision from before it
 * must not match one after.
 */
function revisionOf(epoch: string, gen: number): string {
  return `${epoch}:${gen}`;
}

function statOf(stat: SqliteStat, epoch: string): VfsStat {
  return {
    dev: stat.dev,
    type: stat.type,
    size: stat.size,
    mtimeMs: stat.mtime,
    atimeMs: stat.atime,
    ctimeMs: stat.ctime,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    ino: stat.ino,
    nlink: stat.nlink,
    ...(stat.gen !== undefined ? { revision: revisionOf(epoch, stat.gen) } : {}),
  };
}

export class SqliteFiles implements VFS {
  /** VFS.storesWrites: a regular file holds what it was written. */
  readonly storesWrites = true;
  readonly sync: SyncVFS = this;
  /** The database's change feed, in this principal's view (names it could list). */
  readonly changes: VfsChanges;

  constructor(private readonly engine: SqliteVFS, private readonly view: CredentialedVfs) {
    // The engine names paths by key (no leading slash); this interface's
    // paths are absolute, the feed's included.
    this.changes = {
      get epoch() { return view.epoch; },
      revision: () => view.revision(),
      since: (epoch, cursor, options) => {
        const delta = view.acquire(epoch, cursor, options);
        for (const entry of delta.paths) entry.path = absolute(entry.path);
        return delta;
      },
      list: (after, limit) => {
        const page = view.list(after === null ? null : after.replace(/^\/+/, ''), limit);
        for (const entry of page.entries) entry.path = absolute(entry.path);
        return { ...page, next: page.next === null ? null : absolute(page.next) };
      },
    };
  }

  /** VFS.fileStore: the database, through every principal's view of it. */
  get fileStore(): object {
    return this.engine;
  }

  /** The engine's credentialed view this speaks for (for the engine's own callers). */
  get credentialed(): CredentialedVfs {
    return this.view;
  }

  as(cred: VfsCred, actor?: string, options?: VfsViewOptions): SqliteFiles {
    return new SqliteFiles(this.engine, this.engine.as(cred, {
      ...(actor === undefined ? {} : { actor }),
      ...(options?.holds === undefined ? {} : { holds: options.holds }),
      ...(options?.landed === true ? { landed: true } : {}),
    }));
  }

  /** Every mutation that lands on the database, through any view (SqliteVFS.observeWrites); paths absolute. */
  observeWrites(observer: VfsWriteObserver): () => void {
    return this.engine.observeWrites((event) => observer({
      ...event,
      path: absolute(event.path),
      ...(event.oldPath !== undefined ? { oldPath: absolute(event.oldPath) } : {}),
    }));
  }

  /**
   * Every mutation that lands at `path` or under it, through any view, as
   * the one rule tells a watch (projectChange); paths absolute. The kernel
   * sees everywhere, and its names are the database's: its watch is the
   * engine's own stream, batched as it publishes (SqliteVFS.events). Any
   * other principal's is judged as each change is published, under its names
   * (CredentialedVfs.subscribe).
   */
  watchChanges(path: string, listener: (events: readonly VfsEvent[]) => void): () => void {
    if (this.view.cred.uid !== 0) {
      return this.view.subscribe(path, (event) => {
        listener([event.oldPath === undefined
          ? { type: event.type, path: absolute(event.path), timestamp: event.timestamp }
          : { type: event.type, path: absolute(event.path), oldPath: absolute(event.oldPath), timestamp: event.timestamp }]);
      });
    }
    const tree = normalizeVfsPath(path);
    return this.engine.events.on((batch) => {
      const told: VfsEvent[] = [];
      for (const event of batch) {
        const projected = projectChange(event, tree, absolute);
        if (projected !== null) told.push(projected);
      }
      if (told.length > 0) listener(told);
    });
  }

  /** `op`, its engine errors as Node's for `syscall` on `path` (and `dest`). */
  private run<T>(syscall: string, path: string, op: () => T, dest?: string): T {
    try {
      return op();
    } catch (error) {
      throw toVfsError(error, syscall, path, dest);
    }
  }

  stat(path: string, options?: { follow?: boolean }): VfsStat | null {
    // The root has no row: it is 0755 root:root by definition.
    if (path.replace(/\/+/g, '') === '') {
      return { dev: this.engine.deviceId, ino: ROOT_INODE, type: 'directory', size: 0, mtimeMs: 0, mode: ROOT_DIRECTORY_MODE, uid: 0, gid: 0, revision: `${this.view.epoch}:0` };
    }
    // A name that is not there is an answer: no error is made for it.
    try {
      const stat = this.view.statIfPresent(path, options?.follow !== false);
      return stat === null ? null : statOf(stat, this.view.epoch);
    } catch (error) {
      const converted = toVfsError(error, options?.follow === false ? 'lstat' : 'stat', path);
      if (converted instanceof VfsError && converted.code === 'ENOENT') return null;
      throw converted;
    }
  }

  landedAt(path: string): boolean {
    if (path.replace(/\/+/g, '') === '') return true;
    return this.run('lstat', path, () => this.view.landedAt(path));
  }

  readFile(path: string): Uint8Array {
    return this.run('open', path, () => this.view.readFile(path));
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.run('open', path, () => this.view.readRange(path, offset, length));
  }

  access(path: string, mode: number): void {
    this.run('open', path, () => this.view.access(path, mode));
  }

  /** The engine's own description of the file (its access the open's): its inode, whatever name it has later. */
  openFile(path: string, rights: { read: boolean; write: boolean }): VfsOpenFile {
    const { view } = this;
    const node = this.run('open', path, () => {
      const there = view.statIfPresent(path, true);
      const described = there === null ? null : this.engine.describeInode(there.ino, path.replace(/^\/+/, ''), view.cred, rights, view.principal, view.holds);
      if (described === null) throw syscallError('ENOENT', 'open', path);
      return described;
    });
    return {
      path: () => {
        try {
          return absolute(node.path());
        } catch (error) {
          const converted = toVfsError(error, 'fstat', path);
          if (converted instanceof VfsError && converted.code === 'ENOENT') return null;
          throw converted;
        }
      },
      stat: () => this.run('fstat', path, () => statOf(node.stat(), view.epoch)),
      read: (offset, length) => this.run('read', path, () => node.read(offset, length)),
      write: (offset, bytes) => { this.run('write', path, () => node.write(offset, bytes)); },
      truncate: (size) => this.run('ftruncate', path, () => node.truncate(size)),
      close: () => this.run('close', path, () => node.close()),
    };
  }

  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): void {
    this.run('open', path, () => this.view.writeFile(path, data, options));
  }

  writeRange(path: string, offset: number, bytes: Uint8Array): void {
    this.run('open', path, () => this.view.writeRange(path, offset, bytes));
  }

  truncate(path: string, size: number): void {
    this.run('open', path, () => this.view.truncate(path, size));
  }

  readdir(path: string): VfsDirent[] {
    return this.run('scandir', path, () => this.view.readdir(path).map((entry) => ({ name: entry.name, type: entry.type })));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.run('mkdir', path, () => {
      // mkdir(2): an existing name is EEXIST (the engine's own mkdir is idempotent).
      if (!options?.recursive && this.view.exists(path)) throw syscallError('EEXIST', 'mkdir', path);
      this.view.mkdir(path, options);
    });
  }

  unlink(path: string): void {
    this.run('unlink', path, () => this.view.unlink(path));
  }

  rmdir(path: string): void {
    this.run('rmdir', path, () => this.view.rmdir(path));
  }

  rename(from: string, to: string): void {
    this.run('rename', from, () => this.view.rename(from, to), to);
  }

  /** rm -r, with its report (SqliteVFS's, the walk's own result). */
  removeRecursive(path: string, options?: { keepVanishedAncestors?: boolean }): VfsRemoval {
    return this.run('rm', path, () => this.view.removeRecursive(path, options));
  }

  symlink(target: string, path: string): void {
    this.run('symlink', target, () => this.view.symlink(target, path), path);
  }

  readlink(path: string): string {
    return this.run('readlink', path, () => this.view.readlink(path));
  }

  chmod(path: string, mode: number): void {
    this.run('chmod', path, () => this.view.chmod(path, mode));
  }

  chown(path: string, uid: number | null, gid: number | null): void {
    this.run('chown', path, () => this.view.chown(path, uid, gid));
  }

  utimes(path: string, atime: FsTime, mtime: FsTime): void {
    this.run('utime', path, () => this.view.utimes(path, atime, mtime));
  }

  /** Copy inside the database: rows, not bytes. */
  copy(from: string, to: string, options?: VfsCopyOptions): number {
    return this.run(options?.recursive ? 'cp' : 'copyfile', from, () => {
      if (!options?.recursive) {
        this.view.copyFile(from, to, { keepMode: options?.keepMode });
        return 1;
      }
      return this.view.copyTree(from, to, { preserve: options.preserve, follow: options.follow });
    }, to);
  }

  /**
   * Compare-and-write against the row's revision, in one synchronous step:
   * nothing can commit between the check and the write, because both run in
   * this isolate's turn on the same database.
   */
  writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): VfsCasResult {
    return this.run('open', path, () => {
      // Absent is revision 0; revisions compare as strings, so '0' and 0 agree.
      const current = this.stat(path)?.revision ?? 0;
      if (String(current) !== String(expected)) return { ok: false, revision: current };
      this.view.writeFile(path, data);
      return { ok: true, revision: this.stat(path)?.revision ?? 0 };
    });
  }

  describe() {
    return { source: 'sqlite', type: 'nimbusfs', options: ['rw'] as const };
  }
}

/** The database as `cred` sees it, as a VFS. */
export function sqliteFiles(engine: SqliteVFS, cred: VfsCred): SqliteFiles {
  return new SqliteFiles(engine, engine.as(cred));
}
