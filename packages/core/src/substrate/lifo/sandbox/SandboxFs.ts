import type { ProcessView } from '../../../runtime/process-files.js';
import type { SandboxFs as ISandboxFs, UserStoreStats } from './types.js';
import type { SqliteVFS } from '../../../vfs/sqlite-vfs.js';
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
    /** The SQLite filesystem the namespace is rooted at, for storeStats. */
    private store: SqliteVFS,
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

  /** How the session's content store is doing (its diagnostic; nothing in it is per-user). */
  async storeStats(): Promise<UserStoreStats> {
    const { ledger, ...store } = this.store.storeStats();
    return { ...store, ledger: { used: ledger.used, limit: ledger.limit, available: Math.max(0, ledger.limit - ledger.used) } };
  }
}
