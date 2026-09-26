import type { RuntimeFsBridge, RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../runtime/os-contracts.js';
import { VfsError } from '../../../vfs/vfs-error.js';

/** The synchronous filesystem the in-process Node interpreter's `fs` and `require` read. */
export interface NodeFilesystem {
  readFile(path: string): Uint8Array;
  readFileString(path: string): string;
  writeFile(path: string, data: string | Uint8Array): void;
  appendFile(path: string, data: string | Uint8Array): void;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  stat(path: string): RuntimeVfsStat;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  readdir(path: string): RuntimeVfsDirEntry[];
  unlink(path: string): void;
  rmdir(path: string): void;
  rmdirRecursive(path: string): void;
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  onChange: (() => void) | undefined;
}

/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one.
 */
export function synchronousFilesystem(view: { process: RuntimeFsBridge }): () => NodeFilesystem {
  let opened: NodeFilesystem | null = null;
  return () => {
    opened ??= bridgeFilesystem(view.process);
    return opened;
  };
}

function bridgeFilesystem(bridge: RuntimeFsBridge): NodeFilesystem {
  const fs = bridge.synchronous;
  if (!fs) throw new Error('This Node interpreter requires a synchronous filesystem capability; asynchronous hosts use the resident Node runtime');
  const read = (path: string): Uint8Array => {
    const data = fs.readFile(path);
    if (data === null) throw new VfsError('ENOENT', path);
    return data;
  };
  let listener: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  return {
    readFile: read,
    readFileString: path => new TextDecoder().decode(read(path)),
    writeFile(path, data) { fs.writeFile(path, data); },
    appendFile(path, data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const handle = fs.open(path, { write: true, append: true, create: true });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.write(handle.id, null, bytes.subarray(offset));
          if (count <= 0 || count > bytes.length - offset) throw new Error('EIO: invalid append write length');
          offset += count;
        }
      } finally { fs.close(handle.id); }
    },
    exists: path => fs.stat(path) !== null,
    isFile: path => fs.stat(path)?.type === 'file',
    isDirectory: path => fs.stat(path)?.type === 'directory',
    stat(path) {
      const stat = fs.stat(path);
      if (!stat) throw new VfsError('ENOENT', path);
      return stat;
    },
    mkdir: (path, options) => fs.mkdir(path, options),
    readdir: path => fs.readdir(path) as RuntimeVfsDirEntry[],
    unlink: path => fs.unlink(path),
    rmdir: path => fs.rmdir(path),
    rmdirRecursive: path => fs.remove(path, { recursive: true }),
    rename: (from, to) => fs.rename(from, to),
    copyFile: (from, to) => fs.copyFile(from, to),
    chmod: (path, mode) => fs.chmod(path, mode),
    get onChange() { return listener; },
    set onChange(next) {
      unsubscribe?.();
      listener = next;
      unsubscribe = next ? bridge.subscribe?.('/', next) : undefined;
    },
  };
}
