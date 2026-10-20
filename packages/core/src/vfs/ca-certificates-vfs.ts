/**
 * /etc/ssl/certs: the trust store, as Debian lays it out.
 *
 * Served from this build rather than kept in a session, so every session
 * trusts what the deployed Nimbus trusts: a root Mozilla distrusts leaves
 * every session with the next deploy, an installed one included (a copy in
 * the session would keep it). Read-only, as a distribution's store is to its
 * programs; a program that needs another trusts it by SSL_CERT_FILE.
 * CPython and Ruby carry their own OpenSSL, whose default paths are their
 * build machine's, so their environment names this file (interpreter-env.ts).
 */
import { CA_CERTIFICATES_DATE, CA_CERTIFICATES_PEM } from './ca-certificates.generated.js';
import type { SyncVFS, VFS, VfsDirent, VfsStat } from './vfs.js';
import { syscallError } from './vfs-error.js';

export const CA_CERTIFICATES_DIR = '/etc/ssl/certs';
const NAME = 'ca-certificates.crt';
export const CA_CERTIFICATES_FILE = `${CA_CERTIFICATES_DIR}/${NAME}`;

const BYTES = new TextEncoder().encode(CA_CERTIFICATES_PEM);
const MTIME_MS = Date.parse(CA_CERTIFICATES_DATE);

function name(path: string): string {
  return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

export class CaCertificatesVFS implements VFS {
  readonly sync: SyncVFS = this;

  /** The file at `path`; ENOENT for `syscall` when it names something else, EISDIR for the directory. */
  private file(path: string, syscall: string): Uint8Array {
    const n = name(path);
    if (n === '') throw syscallError('EISDIR', syscall, path);
    if (n !== NAME) throw syscallError('ENOENT', syscall, path);
    return BYTES;
  }

  stat(path: string): VfsStat | null {
    const n = name(path);
    if (n === '') return { type: 'directory', size: 0, mtimeMs: MTIME_MS, mode: 0o40755, uid: 0, gid: 0 };
    return n === NAME ? { type: 'file', size: BYTES.length, mtimeMs: MTIME_MS, mode: 0o100644, uid: 0, gid: 0 } : null;
  }

  readFile(path: string): Uint8Array {
    return this.file(path, 'open').slice();
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.file(path, 'open').slice(offset, offset + length);
  }

  readdir(path: string): VfsDirent[] {
    if (name(path) !== '') {
      this.file(path, 'scandir');
      throw syscallError('ENOTDIR', 'scandir', path);
    }
    return [{ name: NAME, type: 'file' }];
  }

  writeFile(path: string): void {
    throw syscallError('EROFS', 'open', path);
  }

  mkdir(path: string): void {
    throw syscallError('EROFS', 'mkdir', path);
  }

  unlink(path: string): void {
    throw syscallError('EROFS', 'unlink', path);
  }

  rmdir(path: string): void {
    throw syscallError('EROFS', 'rmdir', path);
  }

  describe() {
    return { source: 'ca-certificates', type: 'ca-certificates', options: ['ro'] as const };
  }
}
