/**
 * /proc: files generated when read, for the principal reading them.
 *
 * Synchronous and read-only. A file is a generator from the reading
 * principal's credential to text; `register` adds or replaces one, and
 * `name` may be nested (`net/info`), which makes its directories.
 *
 * Its tree changes only by `register`, so its feed is an immutable one
 * (immutable-changes.ts): a reader that listed it is current until a file
 * is registered. A file is generated (`register` with `volatile`: the
 * standard ones, proc-files.ts, and /proc/mounts), its stat size 0, as
 * Linux procfs says, its content made at each read; or held (the trust
 * store), its stat its content's size.
 * Every stat's mtime is the tree's: when it was made, or last registered to.
 */
import { CA_CERTIFICATES_PEM } from './ca-certificates.generated.js';
import { immutableChanges } from './immutable-changes.js';
import { PROC_FILES, type ProcGenerator } from './proc-files.js';
import type { SyncVFS, VFS, VfsChanges, VfsCred, VfsDirent, VfsStat } from './vfs.js';
import { syscallError } from './vfs-error.js';
import { posixAccess } from './posix-access.js';


const enc = new TextEncoder();
/** A directory's and a file's mode and owner: what their stats say and their access asks. */
const DIRECTORY = { mode: 0o40555, uid: 0, gid: 0, type: 'directory' } as const;
const FILE = { mode: 0o100444, uid: 0, gid: 0, type: 'file' } as const;
const DIR: VfsStat = { size: 0, mtimeMs: 0, ...DIRECTORY };

function key(path: string): string {
  return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

/** What every view of one /proc shares: its files, which of them are volatile, its tree's version and time, and its feed. */
interface ProcTree {
  readonly files: Map<string, ProcGenerator>;
  readonly volatile: Set<string>;
  version: number;
  mtimeMs: number;
  changes?: VfsChanges;
}

export class ProcVFS implements VFS {
  readonly sync: SyncVFS;
  readonly changes: VfsChanges;

  constructor(private readonly tree: ProcTree = { files: new Map(), volatile: new Set(), version: 0, mtimeMs: Date.now() }, private readonly cred: VfsCred | null = null) {
    this.sync = this;
    // One feed for every principal's view: its tree is theirs alike (a file's content is what differs, made when read).
    this.changes = tree.changes ??= immutableChanges(this, () => tree.version);
  }

  private get files(): Map<string, ProcGenerator> { return this.tree.files; }

  /** Add or replace `/proc/<name>`; `volatile`: its content is made at each read (size 0). */
  register(name: string, generator: ProcGenerator, volatile = false): void {
    const k = key(name);
    this.files.set(k, generator);
    if (volatile) this.tree.volatile.add(k); else this.tree.volatile.delete(k);
    this.tree.version++;
    this.tree.mtimeMs = Date.now();
  }

  /** The same files, generated for `cred`. */
  as(cred: VfsCred): ProcVFS {
    return new ProcVFS(this.tree, cred);
  }

  private isDir(k: string): boolean {
    if (k === '') return true;
    for (const name of this.files.keys()) if (name.startsWith(`${k}/`)) return true;
    return false;
  }

  /** The file's content: text made for this read, or bytes shared with every read, which are not the caller's to change. */
  private generate(path: string): string | Uint8Array {
    const k = key(path);
    const generator = this.files.get(k);
    if (generator === undefined) throw syscallError(this.isDir(k) ? 'EISDIR' : 'ENOENT', 'open', path);
    return generator(this.cred);
  }

  stat(path: string): VfsStat | null {
    const k = key(path);
    if (this.isDir(k)) return { ...DIR, mtimeMs: this.tree.mtimeMs };
    if (!this.files.has(k)) return null;
    if (this.tree.volatile.has(k)) return { size: 0, mtimeMs: this.tree.mtimeMs, ...FILE };
    const content = this.generate(path);
    return { size: typeof content === 'string' ? enc.encode(content).length : content.length, mtimeMs: this.tree.mtimeMs, ...FILE };
  }

  readFile(path: string): Uint8Array {
    const content = this.generate(path);
    // Shared bytes are copied, so no reader changes them for the next.
    return typeof content === 'string' ? enc.encode(content) : content.slice();
  }

  /** Its files are root's, 0444, its directories 0555: a credential asks them by their mode (the embedder's view is not judged). */
  access(path: string, mode: number): void {
    const k = key(path);
    const entry = this.isDir(k) ? DIRECTORY : this.files.has(k) ? FILE : null;
    if (entry === null) throw syscallError('ENOENT', 'open', path);
    if (this.cred !== null && !posixAccess(entry, mode, this.cred)) throw syscallError('EACCES', 'open', path);
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    const content = this.generate(path);
    return (typeof content === 'string' ? enc.encode(content) : content).slice(offset, offset + length);
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
 * The trust store: the TLS roots this build serves (Mozilla's, pinned by
 * scripts/update-ca-certificates.mjs). Generated here rather than kept in a
 * session, so every session trusts what the deployed Nimbus trusts, and a
 * root Mozilla distrusts leaves every session with the next deploy (a copy
 * staged in a session would keep it). CPython's and Ruby's OpenSSL read it
 * through SSL_CERT_FILE (interpreter-env.ts): their default paths are their
 * build machine's.
 */
export const CA_CERTIFICATES_FILE = '/proc/nimbus/ca-certificates.crt';
/** Its bytes, encoded once per isolate: CPython reads the file for every TLS connection it makes. */
const CA_CERTIFICATES = enc.encode(CA_CERTIFICATES_PEM);

/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version,
 * net/info and the trust store. ProcessFiles adds `mounts`, and a host adds
 * its own with `register`.
 */
export function standardProc(): ProcVFS {
  const proc = new ProcVFS();
  for (const [name, { generate }] of Object.entries(PROC_FILES)) proc.register(name, generate, true);
  proc.register(CA_CERTIFICATES_FILE.slice('/proc/'.length), () => CA_CERTIFICATES);
  return proc;
}
