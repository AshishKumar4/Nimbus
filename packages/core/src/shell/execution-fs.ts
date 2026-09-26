import type { RuntimeFsBridge, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { VfsError } from '../vfs/vfs-error.js';
import { resolve } from '../substrate/lifo/utils/path.js';

export type ExecutionStat = RuntimeVfsStat;

/**
 * The facet manager's view of a process's bridge (slice N of the cutover
 * moves it to the bridge itself; commands use ProcessFiles' view).
 */
export class ExecutionFs {
  constructor(readonly bridge: RuntimeFsBridge) {}

  async revision(path?: string): Promise<number> { return await this.authority.revision(path); }
  /** Whole-file read that never pins the content in the session LRU. */
  async readFileUncached(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.readArrayBufferUncached(path));
  }
  /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so
   *  a runtime image is held once rather than copied into one. */
  async readArrayBufferUncached(path: string): Promise<ArrayBuffer> {
    const stat = await this.stat(path);
    const buffer = new ArrayBuffer(stat.size);
    const result = new Uint8Array(buffer);
    for (let offset = 0; offset < result.length;) {
      const bytes = await this.authority.readRange(path, offset, Math.min(65536, result.length - offset), { cached: false });
      if (!bytes || bytes.length === 0) throw new VfsError('ESTALE', `${path} changed during read`);
      result.set(bytes, offset); offset += bytes.length;
    }
    return buffer;
  }
  get authority(): RuntimeFsBridge { return this.bridge; }

  private async probe(path: string, followSymlinks: boolean): Promise<ExecutionStat | null> {
    try {
      return await this.bridge.stat(path, { followSymlinks });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async stat(path: string): Promise<ExecutionStat> {
    const stat = await this.probe(path, true);
    if (stat === null) throw new VfsError('ENOENT', path);
    return stat;
  }
  async lstat(path: string): Promise<ExecutionStat> {
    const stat = await this.probe(path, false);
    if (stat === null) throw new VfsError('ENOENT', path);
    return stat;
  }
  async exists(path: string): Promise<boolean> {
    return await this.probe(path, true) !== null;
  }
  async isDirectory(path: string): Promise<boolean> { return (await this.probe(path, true))?.type === 'directory'; }
  async isFile(path: string): Promise<boolean> { return (await this.probe(path, true))?.type === 'file'; }
  async isSymlink(path: string): Promise<boolean> {
    return (await this.probe(path, false))?.type === 'symlink';
  }
  async readFile(path: string): Promise<Uint8Array> {
    const bytes = await this.bridge.readFile(path);
    if (bytes === null) throw new VfsError('ENOENT', path);
    return bytes;
  }
  async readFileString(path: string): Promise<string> { return new TextDecoder().decode(await this.readFile(path)); }
  /** Ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.bridge.readRange(path, offset, length, { cached: false });
    if (bytes === null) throw new VfsError('ENOENT', path);
    return bytes;
  }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.bridge.readRange(path, offset, length);
    if (bytes === null) throw new VfsError('ENOENT', path);
    return bytes;
  }
  async writeFile(path: string, bytes: string | Uint8Array): Promise<void> { await this.bridge.writeFile(path, bytes); }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<number> {
    // The bridge writes every byte of the range.
    await this.bridge.writeRange(path, offset, bytes);
    return bytes.length;
  }
  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = await this.bridge.open(path, { write: true, append: true, create: true });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.bridge.write(handle.id, null, bytes.subarray(offset));
        if (written <= 0 || written > bytes.length - offset) throw new VfsError('EIO', path);
        offset += written;
      }
    } finally { await this.bridge.close(handle.id); }
  }
  async readdir(path: string) { return await this.bridge.readdir(path); }
  async readdirStat(path: string) {
    const entries = await this.readdir(path);
    const result = [];
    for (const entry of entries) result.push({ ...await this.lstat(resolve(path, entry.name)), name: entry.name });
    return result;
  }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> { await this.bridge.mkdir(path, options); }
  async unlink(path: string): Promise<void> { await this.bridge.unlink(path); }
  async rmdir(path: string): Promise<void> { await this.bridge.rmdir(path); }
  async rename(from: string, to: string): Promise<void> { await this.bridge.rename(from, to); }
  async copyFile(from: string, to: string): Promise<void> { await this.bridge.copyFile(from, to); }
  /** Copy a tree by reference; EXDEV when the bridge cannot (a mount). */
  async copyTree(from: string, to: string, options?: { preserve?: boolean }): Promise<number> {
    return await this.bridge.copyTree(from, to, options);
  }
  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.bridge.remove(path, options);
  }
  async rmdirRecursive(path: string): Promise<void> { await this.remove(path, { recursive: true }); }
  async realpath(path: string): Promise<string> {
    return await this.bridge.realpath(path);
  }
  async readlink(path: string): Promise<string> {
    const target = await this.bridge.readlink(path);
    if (target === null) throw new VfsError('EINVAL', path);
    return target;
  }
  async symlink(target: string, path: string): Promise<void> {
    await this.bridge.symlink(target, path);
  }
  async truncate(path: string, size: number): Promise<void> { await this.bridge.truncate(path, size); }
  async chmod(path: string, mode: number): Promise<void> { await this.bridge.chmod(path, mode); }
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    const stat = await this.bridge.stat(path);
    if (!stat) throw new VfsError('ENOENT', path);
    await this.bridge.chown(path, uid ?? stat.uid, gid ?? stat.gid);
  }
  async access(path: string, mode: number): Promise<void> { await this.bridge.access(path, mode); }
  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    await this.bridge.utimes(path, atime, mtime);
  }
  async touch(path: string): Promise<void> {
    const handle = await this.bridge.open(path, { write: true, create: true });
    await this.bridge.close(handle.id);
    const now = Date.now();
    await this.bridge.utimes(path, now, now);
  }
}

