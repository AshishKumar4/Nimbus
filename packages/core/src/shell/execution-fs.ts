import type { NimbusFilesystemAuthority, NimbusFilesystemBinding, RuntimeFsBridge, RuntimeVfsStat, VfsCred } from '../runtime/os-contracts.js';
import { VFS, VFSError } from '../substrate/lifo/kernel/vfs/index.js';
import type { Stat } from '../substrate/lifo/kernel/vfs/types.js';
import { resolve } from '../substrate/lifo/utils/path.js';

export type ShellFilesystem = NimbusFilesystemAuthority | VFS;
export type ExecutionStat = Stat & Partial<Pick<RuntimeVfsStat, 'dev' | 'ino' | 'nlink' | 'atime' | 'uid' | 'gid'>>;

export function bindExecutionFs(filesystem: ShellFilesystem, binding: NimbusFilesystemBinding): ExecutionFs {
  return new ExecutionFs(filesystem instanceof VFS ? filesystem.as(binding.cred) : filesystem.bind(binding));
}

/** Host-side work over a credentialed lease that is released when the work settles. */
export async function withHostFilesystem<T>(
  authority: NimbusFilesystemAuthority,
  cred: Readonly<VfsCred>,
  use: (fs: ExecutionFs) => Promise<T>,
): Promise<T> {
  const lease = authority.openHost(cred);
  try {
    return await use(new ExecutionFs(lease.fs));
  } finally {
    await lease.dispose();
  }
}

/** Normalizes command I/O without copying files or owning a mount table. */
export class ExecutionFs {
  constructor(readonly bridge: RuntimeFsBridge | VFS) {}

  get local(): VFS | null { return this.bridge instanceof VFS ? this.bridge : null; }
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
      if (!bytes || bytes.length === 0) throw new VFSError('ESTALE', `${path} changed during read`);
      result.set(bytes, offset); offset += bytes.length;
    }
    return buffer;
  }
  get authority(): RuntimeFsBridge {
    if (this.bridge instanceof VFS) throw new Error('Runtime execution requires a filesystem authority');
    return this.bridge;
  }

  private async probe(path: string, followSymlinks: boolean): Promise<ExecutionStat | null> {
    try {
      return this.bridge instanceof VFS
        ? followSymlinks ? this.bridge.stat(path) : this.bridge.lstat(path)
        : await this.bridge.stat(path, { followSymlinks });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async stat(path: string): Promise<ExecutionStat> {
    const stat = await this.probe(path, true);
    if (stat === null) throw new VFSError('ENOENT', path);
    return stat;
  }
  async lstat(path: string): Promise<ExecutionStat> {
    const stat = await this.probe(path, false);
    if (stat === null) throw new VFSError('ENOENT', path);
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
    if (bytes === null) throw new VFSError('ENOENT', path);
    return bytes;
  }
  async readFileString(path: string): Promise<string> { return new TextDecoder().decode(await this.readFile(path)); }
  /** Ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = this.bridge instanceof VFS
      ? this.bridge.readRange(path, offset, length)
      : await this.bridge.readRange(path, offset, length, { cached: false });
    if (bytes === null) throw new VFSError('ENOENT', path);
    return bytes;
  }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.bridge.readRange(path, offset, length);
    if (bytes === null) throw new VFSError('ENOENT', path);
    return bytes;
  }
  async writeFile(path: string, bytes: string | Uint8Array): Promise<void> { await this.bridge.writeFile(path, bytes); }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<number> {
    // Both the bridge and the lifo VFS write every byte of the range.
    await this.bridge.writeRange(path, offset, bytes);
    return bytes.length;
  }
  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    if (this.bridge instanceof VFS) { this.bridge.appendFile(path, content); return; }
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = await this.bridge.open(path, { write: true, append: true, create: true });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.bridge.write(handle.id, null, bytes.subarray(offset));
        if (written <= 0 || written > bytes.length - offset) throw new VFSError('EIO', path);
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
  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    if (!(this.bridge instanceof VFS)) { await this.bridge.remove(path, options); return; }
    try { if (options.recursive && this.bridge.isDirectory(path)) this.bridge.rmdirRecursive(path); else this.bridge.unlink(path); }
    catch (error) { if (!(options.force && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  async rmdirRecursive(path: string): Promise<void> { await this.remove(path, { recursive: true }); }
  async realpath(path: string): Promise<string> {
    return await this.bridge.realpath(path);
  }
  async readlink(path: string): Promise<string> {
    const target = await this.bridge.readlink(path);
    if (target === null) throw new VFSError('EINVAL', path);
    return target;
  }
  async symlink(target: string, path: string): Promise<void> {
    await this.bridge.symlink(target, path);
  }
  async truncate(path: string, size: number): Promise<void> { await this.bridge.truncate(path, size); }
  async chmod(path: string, mode: number): Promise<void> { await this.bridge.chmod(path, mode); }
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    if (this.bridge instanceof VFS) { this.bridge.chown(path, uid, gid); return; }
    const stat = await this.bridge.stat(path);
    if (!stat) throw new VFSError('ENOENT', path);
    await this.bridge.chown(path, uid ?? stat.uid, gid ?? stat.gid);
  }
  async access(path: string, mode: number): Promise<void> { await this.bridge.access(path, mode); }
  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    await this.bridge.utimes(path, atime, mtime);
  }
  async touch(path: string): Promise<void> {
    if (this.bridge instanceof VFS) { this.bridge.touch(path); return; }
    const handle = await this.bridge.open(path, { write: true, create: true });
    await this.bridge.close(handle.id);
    const now = Date.now();
    await this.bridge.utimes(path, now, now);
  }
}

