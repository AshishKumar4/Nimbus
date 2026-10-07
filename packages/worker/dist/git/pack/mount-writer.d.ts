/**
 * git/pack/mount-writer.ts — a clone's files on a mounted filesystem.
 *
 * A wave writes a file to a mount in one call, up to ROUTED_FILE_MAX bytes
 * (sqlite-vfs.ts); a larger one it refuses. So on a mount, a file within
 * that goes in the wave as on the session's own filesystem, and a larger
 * one is written as any program writes a large file: through the session's
 * file API (open, write in pieces, close), under the clone's lease, once
 * what the waves hold before it is published, so it lands in git's order;
 * its directory is made first, as `mkdir -p` would.
 * The index, which git writes whole to index.lock and renames over
 * .git/index, is written the same way. Its stat is the receipt a wave would
 * have answered.
 */
import type { CloneReceipt, CloneWriter } from './clone.js';
/** sqlite-vfs.ts ROUTED_FILE_MAX: the largest file a wave writes to a mount. */
export declare const MOUNT_WAVE_FILE_MAX: number;
/** An open file's stat, as fstat answers it: what its receipt is made of. */
export interface FileStat {
    ino: number;
    mode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
}
/** The session's file API, as the clone's supervisor binding offers it (its lease presented). */
export interface FileApi {
    mkdir(path: string, options: {
        recursive: true;
    }): Promise<void>;
    fsOpen(path: string, flags: {
        write: true;
        create: true;
        truncate: true;
        mode: number;
    }): Promise<{
        id: number;
    }>;
    fsWrite(handleId: number, offset: number, bytes: Uint8Array): Promise<number>;
    fsFstat(handleId: number): Promise<FileStat>;
    fsClose(handleId: number): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}
/**
 * `writer` (rooted at `dir`, a namespace path on a mount), with each file
 * over a wave's mount limit written through `api` instead, its receipt to
 * `onReceipts`.
 */
export declare function mountWriter(writer: CloneWriter, api: FileApi, dir: string, onReceipts?: (receipts: CloneReceipt[]) => void): CloneWriter;
//# sourceMappingURL=mount-writer.d.ts.map