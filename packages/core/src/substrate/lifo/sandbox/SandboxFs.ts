import type { ProcessView } from '../../../runtime/process-files.js';
import type { SandboxFs as ISandboxFs, SandboxFsReader } from './types.js';
import { W_OK, X_OK } from '../../../runtime/process-files.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { SnapshotInfo, SqliteVFS, VfsExportChunk, VfsExportPage } from '../../../vfs/sqlite-vfs.js';
import { isVfsError, VfsError } from '../../../vfs/vfs-error.js';
import type { VfsFileType as FileType } from '../../../vfs/vfs.js';
import { resolve, dirname } from '../utils/path.js';
import { exists } from '../../../vfs/vfs.js';
import { statOrThrow } from '../../../vfs/vfs.js';

/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl implements ISandboxFs {
  constructor(
    private vfs: ProcessView,
    private getCwd: () => string,
    /** The SQLite filesystem the namespace is rooted at: what snapshots pin. */
    private store: SqliteVFS,
    /** Who this handle acts as (a snapshot view and restore's check use it). */
    private cred: VfsCred,
  ) {}

  private resolvePath(path: string): string {
    return resolve(this.getCwd(), path);
  }

  readFile(path: string): Promise<string>;
  readFile(path: string, encoding: null): Promise<Uint8Array>;
  async readFile(path: string, encoding?: null): Promise<string | Uint8Array> {
    const abs = this.resolvePath(path);
    if (encoding === null) {
      return Promise.resolve((await this.vfs.readFile(abs)));
    }
    return Promise.resolve((await this.vfs.readFileString(abs)));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const abs = this.resolvePath(path);
    (await this.vfs.writeFile(abs, content));
  }

  async readdir(path: string): Promise<Array<{ name: string; type: FileType }>> {
    const abs = this.resolvePath(path);
    return (await this.vfs.readdir(abs));
  }

  async stat(path: string): Promise<{ type: FileType; size: number; mtime: number }> {
    const abs = this.resolvePath(path);
    const s = await statOrThrow(this.vfs, abs);
    return { type: s.type, size: s.size, mtime: s.mtimeMs };
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    (await this.vfs.mkdir(abs, options));
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    const s = await statOrThrow(this.vfs, abs);
    if (s.type === 'directory') {
      if (options?.recursive) {
        (await this.vfs.remove(abs, { recursive: true }));
      } else {
        (await this.vfs.rmdir(abs));
      }
    } else {
      (await this.vfs.unlink(abs));
    }
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.resolvePath(path);
    return (await this.vfs.exists(abs));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = this.resolvePath(oldPath);
    const absNew = this.resolvePath(newPath);
    (await this.vfs.rename(absOld, absNew));
  }

  async cp(src: string, dest: string): Promise<void> {
    const absSrc = this.resolvePath(src);
    const absDest = this.resolvePath(dest);
    (await this.vfs.copy(absSrc, absDest));
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void> {
    for (const { path, content } of files) {
      await this.writeFile(path, content);
    }
  }

  // ── The content store ──

  async snapshot(name: string, options: { quiesce?: boolean } = {}): Promise<SnapshotInfo> {
    return options.quiesce ? await this.store.snapshot(name, { quiesce: true }) : this.store.snapshot(name);
  }

  async snapshots(): Promise<SnapshotInfo[]> { return this.store.snapshots(); }

  async dropSnapshot(name: string): Promise<{ dropped: number }> { return this.store.dropSnapshot(name); }

  async diff(from: string | null, to: string | null, options?: { after?: string; limit?: number }) {
    return this.store.diff(from, to, options);
  }

  at(name: string): SandboxFsReader {
    const view = this.store.at(name, this.cred);
    const key = (path: string): string => this.resolvePath(path).replace(/^\/+/, '');
    const reader = {
      async readFile(path: string, encoding?: null): Promise<string | Uint8Array> {
        return encoding === null ? view.readFile(key(path)) : view.readFileString(key(path));
      },
      async readdir(path: string) { return view.readdir(key(path)); },
      async stat(path: string) { const s = view.stat(key(path)); return { type: s.type, size: s.size, mtime: s.mtime }; },
      async exists(path: string) { return view.exists(key(path)); },
      async writeFile(path: string): Promise<never> { throw new VfsError('EROFS', 'a snapshot is read-only', path); },
    };
    return reader as SandboxFsReader;
  }

  async restore(name: string, options: { subtree?: string } = {}): Promise<{ restored: number }> {
    const subtree = options.subtree === undefined ? undefined : this.resolvePath(options.subtree);
    await this.assertRestorable(name, subtree);
    return await this.store.restoreAsync(name, subtree === undefined ? {} : { subtree });
  }

  /**
   * Whether the session user may write every path `restore(name)` would
   * change: the file itself for a rewrite, its parent for a name that
   * appears or goes. The first it may not is EACCES, before any change.
   */
  private async assertRestorable(name: string, subtree: string | undefined): Promise<void> {
    const within = subtree === undefined ? null : subtree.replace(/^\/+/, '');
    for (let after: string | undefined; ;) {
      const page = this.store.diff(name, null, { after });
      for (const entry of page.entries) {
        if (within !== null && within !== '' && entry.path !== within && !entry.path.startsWith(`${within}/`)) continue;
        const path = `/${entry.path}`;
        const target = entry.change === 'modified' ? path : dirname(path);
        try {
          await this.vfs.access(target, entry.change === 'modified' ? W_OK : W_OK | X_OK);
        } catch (error) {
          if (isVfsError(error, 'ENOENT') && entry.change !== 'modified') continue;
          throw new VfsError('EACCES', 'restore would change a path the session user cannot write', path);
        }
      }
      if (page.next === null) return;
      after = page.next;
    }
  }

  async exportPage(options: { at: string; root?: string; after?: string | null; limit?: number }): Promise<VfsExportPage> {
    return this.store.exportPage({ ...options, root: options.root === undefined ? undefined : this.resolvePath(options.root) });
  }

  async exportChunks(hashes: readonly string[]) { return this.store.exportChunks(hashes); }

  async importPage(dst: string, page: VfsExportPage, chunks?: Iterable<VfsExportChunk>) {
    const target = this.resolvePath(dst);
    // The session user makes `dst` (or writes into it): its parent must be theirs to write.
    if (await this.vfs.exists(target)) await this.vfs.access(target, W_OK | X_OK);
    else await this.vfs.access(dirname(target), W_OK | X_OK);
    return this.store.importPage(target, page, chunks);
  }

  async pageDigest(options: { at: string; root?: string; after?: string | null; limit?: number }) {
    return this.store.pageDigest({ ...options, root: options.root === undefined ? undefined : this.resolvePath(options.root) });
  }

  async storeStats() { return this.store.storeStats(); }
}
