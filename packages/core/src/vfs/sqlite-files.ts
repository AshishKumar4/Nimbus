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
import type { SyncVFS, VFS, VfsCasResult, VfsChanges, VfsCred, VfsDirent, VfsRevision, VfsStat } from './vfs.js';
import { toVfsError, VfsError, VFS_ERRNO, type VfsErrorCode } from './vfs-error.js';

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
  readonly sync: SyncVFS = this as unknown as SyncVFS;
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

  /** The engine's credentialed view this speaks for (for the engine's own callers). */
  get credentialed(): CredentialedVfs {
    return this.view;
  }

  as(cred: VfsCred): SqliteFiles {
    return new SqliteFiles(this.engine, this.engine.as(cred));
  }

  private run<T>(path: string, op: () => T): T {
    try {
      return op();
    } catch (error) {
      throw toVfsError(error, path);
    }
  }

  stat(path: string, options?: { follow?: boolean }): VfsStat | null {
    // The root has no row: it is 0755 root:root by definition.
    if (path.replace(/\/+/g, '') === '') {
      return { dev: this.engine.deviceId, ino: ROOT_INODE, type: 'directory', size: 0, mtimeMs: 0, mode: ROOT_DIRECTORY_MODE, uid: 0, gid: 0, revision: `${this.view.epoch}:0` };
    }
    try {
      return statOf(options?.follow === false ? this.view.lstat(path) : this.view.stat(path), this.view.epoch);
    } catch (error) {
      const converted = toVfsError(error, path);
      if (converted instanceof VfsError && converted.code === 'ENOENT') return null;
      throw converted;
    }
  }

  readFile(path: string): Uint8Array {
    return this.run(path, () => this.view.readFile(path));
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.run(path, () => this.view.readRange(path, offset, length));
  }

  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): void {
    this.run(path, () => this.view.writeFile(path, data, options));
  }

  writeRange(path: string, offset: number, bytes: Uint8Array): void {
    this.run(path, () => this.view.writeRange(path, offset, bytes));
  }

  truncate(path: string, size: number): void {
    this.run(path, () => this.view.truncate(path, size));
  }

  readdir(path: string): VfsDirent[] {
    return this.run(path, () => this.view.readdir(path).map((entry) => ({ name: entry.name, type: entry.type })));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.run(path, () => {
      // mkdir(2): an existing name is EEXIST (the engine's own mkdir is idempotent).
      if (!options?.recursive && this.view.exists(path)) throw new VfsError('EEXIST', 'file exists', path);
      this.view.mkdir(path, options);
    });
  }

  unlink(path: string): void {
    this.run(path, () => this.view.unlink(path));
  }

  rmdir(path: string): void {
    this.run(path, () => this.view.rmdir(path));
  }

  rename(from: string, to: string): void {
    this.run(from, () => this.view.rename(from, to));
  }

  removeRecursive(path: string): void {
    this.run(path, () => { this.view.removeRecursive(path); });
  }

  symlink(target: string, path: string): void {
    this.run(path, () => this.view.symlink(target, path));
  }

  readlink(path: string): string {
    return this.run(path, () => this.view.readlink(path));
  }

  chmod(path: string, mode: number): void {
    this.run(path, () => this.view.chmod(path, mode));
  }

  chown(path: string, uid: number, gid: number): void {
    this.run(path, () => this.view.chown(path, uid, gid));
  }

  utimes(path: string, atimeMs: number, mtimeMs: number): void {
    this.run(path, () => this.view.utimes(path, atimeMs, mtimeMs));
  }

  /** Copy inside the database: rows, not bytes. */
  copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): number {
    return this.run(from, () => {
      if (!options?.recursive) {
        this.view.copyFile(from, to);
        return 1;
      }
      return this.view.copyTree(from, to, { preserve: options.preserve });
    });
  }

  /**
   * Compare-and-write against the row's revision, in one synchronous step:
   * nothing can commit between the check and the write, because both run in
   * this isolate's turn on the same database.
   */
  writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): VfsCasResult {
    return this.run(path, () => {
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
