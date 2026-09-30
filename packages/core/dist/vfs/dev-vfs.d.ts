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
export declare class DevVFS implements VFS {
    readonly sync: SyncVFS;
    /** The device at `path`; ENOENT for `syscall` when there is none. */
    private node;
    stat(path: string): VfsStat | null;
    readFile(path: string): Uint8Array;
    readRange(path: string, _offset: number, length: number): Uint8Array;
    writeFile(path: string): void;
    writeRange(path: string): void;
    /** A device has no length to set; the node must exist. */
    truncate(path: string): void;
    readdir(path: string): VfsDirent[];
    mkdir(path: string): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    describe(): {
        source: string;
        type: string;
        options: readonly ["rw"];
    };
}
//# sourceMappingURL=dev-vfs.d.ts.map