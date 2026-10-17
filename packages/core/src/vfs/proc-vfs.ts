/**
 * /proc: files generated when read, for the principal reading them.
 *
 * Synchronous and read-only. A file is a generator from the reading
 * principal's credential to text; `register` adds or replaces one, and
 * `name` may be nested (`net/info`), which makes its directories. Nothing
 * here is stored, so nothing here has a revision: a cache never holds it.
 */
import type { SyncVFS, VFS, VfsCred, VfsDirent, VfsStat } from './vfs.js';
import { syscallError } from './vfs-error.js';
import { posixAccess } from './posix-access.js';

/** A /proc file's content, for the credential of the process reading it (null: the embedder's view). */
export type ProcGenerator = (cred: VfsCred | null) => string;

const enc = new TextEncoder();
/** A directory's and a file's mode and owner: what their stats say and their access asks. */
const DIRECTORY = { mode: 0o40555, uid: 0, gid: 0, type: 'directory' } as const;
const FILE = { mode: 0o100444, uid: 0, gid: 0, type: 'file' } as const;
const DIR: VfsStat = { size: 0, mtimeMs: 0, ...DIRECTORY };

function key(path: string): string {
  return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

export class ProcVFS implements VFS {
  private readonly files: Map<string, ProcGenerator>;
  readonly sync: SyncVFS;

  constructor(files?: Map<string, ProcGenerator>, private readonly cred: VfsCred | null = null) {
    this.files = files ?? new Map();
    this.sync = this;
  }

  /** Add or replace `/proc/<name>`. */
  register(name: string, generator: ProcGenerator): void {
    this.files.set(key(name), generator);
  }

  /** The same files, generated for `cred`. */
  as(cred: VfsCred): ProcVFS {
    return new ProcVFS(this.files, cred);
  }

  private isDir(k: string): boolean {
    if (k === '') return true;
    for (const name of this.files.keys()) if (name.startsWith(`${k}/`)) return true;
    return false;
  }

  private generate(path: string): Uint8Array {
    const k = key(path);
    const generator = this.files.get(k);
    if (generator === undefined) throw syscallError(this.isDir(k) ? 'EISDIR' : 'ENOENT', 'open', path);
    return enc.encode(generator(this.cred));
  }

  stat(path: string): VfsStat | null {
    const k = key(path);
    if (this.isDir(k)) return DIR;
    if (!this.files.has(k)) return null;
    return { size: this.generate(path).length, mtimeMs: Date.now(), ...FILE };
  }

  readFile(path: string): Uint8Array {
    return this.generate(path);
  }

  /** Its files are root's, 0444, its directories 0555: a credential asks them by their mode (the embedder's view is not judged). */
  access(path: string, mode: number): void {
    const k = key(path);
    const entry = this.isDir(k) ? DIRECTORY : this.files.has(k) ? FILE : null;
    if (entry === null) throw syscallError('ENOENT', 'open', path);
    if (this.cred !== null && !posixAccess(entry, mode, this.cred)) throw syscallError('EACCES', 'open', path);
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.generate(path).slice(offset, offset + length);
  }

  readdir(path: string): VfsDirent[] {
    const k = key(path);
    if (!this.isDir(k)) throw syscallError(this.files.has(k) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
    const prefix = k === '' ? '' : `${k}/`;
    const out = new Map<string, VfsDirent>();
    for (const name of this.files.keys()) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf('/');
      const child = slash < 0 ? rest : rest.slice(0, slash);
      if (!out.has(child)) out.set(child, { name: child, type: slash < 0 ? 'file' : 'directory' });
    }
    return [...out.values()];
  }

  private readOnly(syscall: string, path: string): never {
    throw syscallError('EROFS', syscall, path, { detail: '/proc is read-only' });
  }
  writeFile(path: string): void { this.readOnly('open', path); }
  mkdir(path: string): void { this.readOnly('mkdir', path); }
  unlink(path: string): void { this.readOnly('unlink', path); }
  rmdir(path: string): void { this.readOnly('rmdir', path); }

  describe() {
    return { source: 'proc', type: 'proc', options: ['ro'] as const };
  }
}

/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version and
 * net/info. ProcessFiles adds `mounts`, and a host adds its own with
 * `register`.
 */
export function standardProc(): ProcVFS {
  const proc = new ProcVFS();
  proc.register('cpuinfo', () => {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1;
    const lines: string[] = [];
    for (let i = 0; i < cores; i++) {
      lines.push(`processor\t: ${i}`, 'model name\t: Browser Virtual CPU', `cpu cores\t: ${cores}`, '');
    }
    return lines.join('\n');
  });
  proc.register('meminfo', () => {
    const memory = ((globalThis as { performance?: unknown }).performance as {
      memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number; totalJSHeapSize: number };
    } | undefined)?.memory;
    if (!memory) return ['MemTotal:       2097152 kB', 'MemFree:        1048576 kB', 'MemUsed:        1048576 kB', ''].join('\n');
    const totalKB = Math.floor(memory.jsHeapSizeLimit / 1024);
    const usedKB = Math.floor(memory.usedJSHeapSize / 1024);
    return [
      `MemTotal:       ${totalKB} kB`,
      `MemFree:        ${totalKB - usedKB} kB`,
      `MemUsed:        ${usedKB} kB`,
      `HeapTotal:      ${Math.floor(memory.totalJSHeapSize / 1024)} kB`,
      '',
    ].join('\n');
  });
  proc.register('uptime', () => {
    const seconds = typeof performance !== 'undefined' ? (performance.now() / 1000).toFixed(2) : '0.00';
    return `${seconds} ${seconds}\n`;
  });
  proc.register('version', () => `Lifo 1.0.0 (${typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js'})\n`);
  proc.register('net/info', () => {
    const conn = typeof navigator !== 'undefined'
      ? (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number; type?: string } }).connection
      : undefined;
    if (!conn) return 'Network information not available\n';
    return [
      `type:          ${conn.type ?? 'unknown'}`,
      `effectiveType: ${conn.effectiveType ?? 'unknown'}`,
      `downlink:      ${conn.downlink ?? 0} Mbps`,
      `rtt:           ${conn.rtt ?? 0} ms`,
      '',
    ].join('\n');
  });
  return proc;
}
