/**
 * /dev: the character devices.
 *
 * Device nodes are byte sources and sinks, not files with content. `stat`
 * says so (S_IFCHR, size 0), and `readRange` produces the requested bytes on
 * demand, so a device has no content ceiling but the caller's bound. A
 * whole-file read of a device that never ends cannot be answered and fails
 * (EINVAL) rather than handing back an arbitrary prefix; bounded readers
 * (`head -c N`, `dd count=N`, redirections) use `readRange`.
 *
 * /dev/stdin, stdout, stderr and tty exist so `test -e` and `ls` see them;
 * the shell resolves them to the process's own descriptors before any read.
 * /dev/tcp is the WASI socket prefix, not a node here.
 */
import type { SyncVFS, VFS, VfsDirent, VfsStat } from './vfs.js';
import { syscallError } from './vfs-error.js';

const S_IFCHR = 0o020000;
const DEV_MODE = S_IFCHR | 0o666;
/** Largest buffer one read produces; fewer bytes than asked is ordinary read(2). */
const MAX_DEVICE_READ = 1024 * 1024;
/** crypto.getRandomValues refuses more than this at once. */
const RANDOM_FILL_CHUNK = 65536;

interface DevNode {
  /** Never at EOF: a whole-file read cannot be answered. */
  readonly unbounded: boolean;
  /** Fill with the device's bytes; absent means always at EOF. */
  readonly fill?: (out: Uint8Array) => void;
  readonly write: (path: string, syscall: string) => void;
}

const discard = (): void => {};
const zeros = (): void => {}; // a Uint8Array is born zeroed
function fillRandom(out: Uint8Array): void {
  for (let i = 0; i < out.length; i += RANDOM_FILL_CHUNK) {
    crypto.getRandomValues(out.subarray(i, Math.min(out.length, i + RANDOM_FILL_CHUNK)));
  }
}

const DEVICES: ReadonlyMap<string, DevNode> = new Map<string, DevNode>([
  ['null', { unbounded: false, write: discard }],
  ['zero', { unbounded: true, fill: zeros, write: discard }],
  ['full', { unbounded: true, fill: zeros, write: (path, syscall) => { throw syscallError('ENOSPC', syscall, path); } }],
  ['random', { unbounded: true, fill: fillRandom, write: discard }],
  ['urandom', { unbounded: true, fill: fillRandom, write: discard }],
  ['stdin', { unbounded: false, write: discard }],
  ['stdout', { unbounded: false, write: discard }],
  ['stderr', { unbounded: false, write: discard }],
  ['tty', { unbounded: false, write: discard }],
]);

function name(path: string): string {
  return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

export class DevVFS implements VFS {
  readonly sync: SyncVFS = this as unknown as SyncVFS;

  /** The device at `path`; ENOENT for `syscall` when there is none. */
  private node(path: string, syscall: string): DevNode {
    const found = DEVICES.get(name(path));
    if (found === undefined) throw syscallError('ENOENT', syscall, path);
    return found;
  }

  stat(path: string): VfsStat | null {
    const n = name(path);
    if (n === '') return { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40755, uid: 0, gid: 0 };
    return DEVICES.has(n) ? { type: 'file', size: 0, mtimeMs: 0, mode: DEV_MODE, uid: 0, gid: 0 } : null;
  }

  readFile(path: string): Uint8Array {
    if (name(path) === '') throw syscallError('EISDIR', 'read', path);
    if (this.node(path, 'open').unbounded) {
      throw syscallError('EINVAL', 'read', path, { detail: 'this device produces bytes without end; read a bounded slice (head -c N, dd count=N)' });
    }
    return new Uint8Array(0);
  }

  readRange(path: string, _offset: number, length: number): Uint8Array {
    const node = this.node(path, 'open');
    if (node.fill === undefined) return new Uint8Array(0);
    const out = new Uint8Array(Math.min(length, MAX_DEVICE_READ));
    node.fill(out);
    return out;
  }

  writeFile(path: string): void {
    this.node(path, 'open').write(path, 'write');
  }

  writeRange(path: string): void {
    this.node(path, 'open').write(path, 'write');
  }

  /** A device has no length to set; the node must exist. */
  truncate(path: string): void {
    this.node(path, 'open');
  }

  readdir(path: string): VfsDirent[] {
    if (name(path) !== '') {
      this.node(path, 'scandir');
      throw syscallError('ENOTDIR', 'scandir', path);
    }
    return [...DEVICES.keys()].map((device) => ({ name: device, type: 'file' as const }));
  }

  mkdir(path: string): void {
    throw syscallError('EPERM', 'mkdir', path, { detail: 'devices are not created here' });
  }

  unlink(path: string): void {
    this.node(path, 'unlink');
    throw syscallError('EPERM', 'unlink', path, { detail: 'a device node cannot be removed' });
  }

  rmdir(path: string): void {
    if (name(path) === '') throw syscallError('EBUSY', 'rmdir', path, { detail: 'the device directory' });
    throw syscallError('ENOTDIR', 'rmdir', path);
  }

  describe() {
    return { source: 'devtmpfs', type: 'devtmpfs', options: ['rw'] as const };
  }
}
