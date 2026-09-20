import type { RuntimeFsBridge, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { VFSError } from '../substrate/lifo/kernel/vfs/index.js';

/** Awaited command conveniences; the bridge remains the only namespace authority. */
export class ExecutionFs {
  constructor(readonly bridge: RuntimeFsBridge) {}

  async stat(path: string): Promise<RuntimeVfsStat> {
    const stat = await this.bridge.stat(path);
    if (stat === null) throw new VFSError('ENOENT', path);
    return stat;
  }

  async lstat(path: string): Promise<RuntimeVfsStat> {
    const stat = await this.bridge.stat(path, { followSymlinks: false });
    if (stat === null) throw new VFSError('ENOENT', path);
    return stat;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.bridge.stat(path)) !== null;
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await this.bridge.stat(path))?.type === 'directory';
  }

  async isFile(path: string): Promise<boolean> {
    return (await this.bridge.stat(path))?.type === 'file';
  }

  async isSymlink(path: string): Promise<boolean> {
    return (await this.bridge.stat(path, { followSymlinks: false }))?.type === 'symlink';
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = await this.bridge.readFile(path);
    if (bytes === null) throw new VFSError('ENOENT', path);
    return bytes;
  }

  async readFileString(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.bridge.readRange(path, offset, length);
    if (bytes === null) throw new VFSError('ENOENT', path);
    return bytes;
  }

  async writeFile(path: string, bytes: string | Uint8Array): Promise<void> {
    await this.bridge.writeFile(path, bytes);
  }

  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<number> {
    return await this.bridge.writeRange(path, offset, bytes);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = await this.bridge.open(path, { write: true, append: true, create: true });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.bridge.write(handle.id, null, bytes.subarray(offset));
        if (written <= 0) throw Object.assign(new Error(`EIO: zero-length write: ${path}`), { code: 'EIO' });
        offset += written;
      }
    } finally {
      await this.bridge.close(handle.id);
    }
  }

  async readdir(path: string) {
    return await this.bridge.readdir(path);
  }

  async readdirStat(path: string) {
    const entries = await this.bridge.readdir(path);
    const result = [];
    for (const entry of entries) {
      const child = path.endsWith('/') ? path + entry.name : `${path}/${entry.name}`;
      result.push({ ...await this.lstat(child), name: entry.name });
    }
    return result;
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await this.bridge.mkdir(path, options);
  }

  async unlink(path: string): Promise<void> { await this.bridge.unlink(path); }
  async rmdir(path: string): Promise<void> { await this.bridge.rmdir(path); }
  async rename(from: string, to: string): Promise<void> { await this.bridge.rename(from, to); }
  async copyFile(from: string, to: string): Promise<void> { await this.bridge.copyFile(from, to); }
  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.bridge.remove(path, options);
  }
  async rmdirRecursive(path: string): Promise<void> { await this.bridge.remove(path, { recursive: true }); }
  async realpath(path: string): Promise<string> { return await this.bridge.realpath(path); }
  async readlink(path: string): Promise<string> {
    const target = await this.bridge.readlink(path);
    if (target === null) throw new VFSError('ENOENT', path);
    return target;
  }
  async symlink(target: string, path: string): Promise<void> { await this.bridge.symlink(target, path); }
  async truncate(path: string, size: number): Promise<void> { await this.bridge.truncate(path, size); }
  async chmod(path: string, mode: number): Promise<void> { await this.bridge.chmod(path, mode); }
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    const stat = uid === null || gid === null ? await this.stat(path) : null;
    await this.bridge.chown(path, uid ?? stat!.uid, gid ?? stat!.gid);
  }
  async access(path: string, mode: number): Promise<void> { await this.bridge.access(path, mode); }
  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    await this.bridge.utimes(path, atime, mtime);
  }
  async touch(path: string): Promise<void> {
    if (!await this.exists(path)) {
      const handle = await this.bridge.open(path, { write: true, create: true });
      await this.bridge.close(handle.id);
    }
    const now = Date.now();
    await this.bridge.utimes(path, now, now);
  }
}
