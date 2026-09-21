import type { ExecutionFs } from "../../../shell/execution-fs.js";
import type { SandboxFs as ISandboxFs } from './types.js';
import type { FileType } from '../kernel/vfs/types.js';
import { resolve, dirname } from '../utils/path.js';
import { createTar, parseTar, compressGzip, decompressGzip } from '../utils/archive.js';
import type { TarEntry } from '../utils/archive.js';

/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl implements ISandboxFs {
  constructor(
    private vfs: ExecutionFs,
    private getCwd: () => string,
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
    const s = (await this.vfs.stat(abs));
    return { type: s.type, size: s.size, mtime: s.mtime };
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    (await this.vfs.mkdir(abs, options));
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    const s = (await this.vfs.stat(abs));
    if (s.type === 'directory') {
      if (options?.recursive) {
        (await this.vfs.rmdirRecursive(abs));
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
    (await this.vfs.copyFile(absSrc, absDest));
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void> {
    for (const { path, content } of files) {
      await this.writeFile(path, content);
    }
  }

  /** Directories to skip during export (virtual providers) */
  private static SKIP_DIRS = new Set(['/proc', '/dev']);

  async exportSnapshot(): Promise<Uint8Array> {
    const entries: TarEntry[] = [];

    const walk = async (absPath: string): Promise<void> => {
      if (SandboxFsImpl.SKIP_DIRS.has(absPath)) return;

      const stat = (await this.vfs.stat(absPath));

      if (stat.type === 'directory') {
        // Add directory entry (skip root itself)
        if (absPath !== '/') {
          entries.push({
            path: absPath,
            data: new Uint8Array(0),
            type: 'directory',
            mode: stat.mode,
            mtime: stat.mtime,
          });
        }

        const children = (await this.vfs.readdir(absPath));
        for (const child of children) {
          const childPath = absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`;
          (await walk(childPath));
        }
      } else {
        entries.push({
          path: absPath,
          data: (await this.vfs.readFile(absPath)),
          type: 'file',
          mode: stat.mode,
          mtime: stat.mtime,
        });
      }
    };

    (await walk('/'));

    const tar = createTar(entries);
    return (await compressGzip(tar));
  }

  async importSnapshot(data: Uint8Array): Promise<void> {
    const tar = await decompressGzip(data);
    const entries = parseTar(tar);

    // Process directories first, then files, to ensure parents exist
    const dirs = entries.filter((e) => e.type === 'directory');
    const files = entries.filter((e) => e.type === 'file');

    for (const entry of dirs) {
      const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
      if (!(await this.vfs.exists(path))) {
        (await this.vfs.mkdir(path, { recursive: true }));
      }
    }

    for (const entry of files) {
      const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
      // Ensure parent directory exists
      const parent = dirname(path);
      if (parent !== '/' && !(await this.vfs.exists(parent))) {
        (await this.vfs.mkdir(parent, { recursive: true }));
      }
      (await this.vfs.writeFile(path, entry.data));
    }
  }
}
