/**
 * git/pack/mount-writer.ts — a clone's files on a mounted filesystem.
 *
 * A wave writes a file to a mount in one call, up to ROUTED_FILE_MAX bytes
 * (sqlite-vfs.ts); a larger one it refuses. So on a mount, a file within
 * that goes in the wave as on the session's own filesystem, and a larger
 * one is written as git's checkout writes a file (entry.c write_entry),
 * through the session's file API under the clone's lease, once what the
 * waves hold before it is published, so it lands in git's order: its
 * directory made, the old entry unlinked (so a hard link to it keeps its
 * content), then created exclusively with the entry's mode, written whole,
 * and closed. The index, of any size, is written as git's lockfile.c writes
 * it: index.lock created exclusively, written, closed, renamed over the
 * index; our own lock removed if that fails. A failure says what git says
 * (GitWriteFailure), and fails the clone. Each stat is the receipt a wave
 * would have answered. No call starts past the phase's deadline, but a
 * close, or the removal of our own lock, which clean up what was started.
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
    unlink(path: string): Promise<void>;
    fsOpen(path: string, flags: {
        write: true;
        create: true;
        exclusive: true;
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
 * A write git would have failed, and what git says (its lines, `error:` and
 * `fatal:` alike): the clone fails with them.
 */
export declare class GitWriteFailure extends Error {
    readonly lines: string;
    constructor(lines: string);
}
/**
 * `api` within a phase's `deadline` (ms since the epoch; null for none): a
 * call past it is refused, but a close or an unlink, which clean up what a
 * call before it started.
 */
export declare function withinDeadline(api: FileApi, deadline: number | null): FileApi;
/**
 * entry.c write_entry of a file at `at` (the worktree's `name`, as git names
 * it): its directory made, the old entry unlinked, then created exclusively
 * with `mode`, written whole, closed. Answers its stat.
 */
export declare function writeEntry(api: FileApi, at: string, name: string, mode: number, bytes: Uint8Array): Promise<FileStat>;
/**
 * A file at `at` replaced as a program replaces one (fetch's packs on a
 * mount): its directory made, the old one unlinked, then created
 * exclusively with `mode`, written whole, closed. Its failures are the
 * file API's. Answers its stat.
 */
export declare function replaceFile(api: FileApi, at: string, mode: number, bytes: Uint8Array): Promise<FileStat>;
/**
 * lockfile.c's write of the index at `at`: index.lock created exclusively
 * (one there already is git's "Unable to create"), written whole, closed,
 * renamed over the index; our own lock removed if any of that fails.
 * Answers the index's stat.
 */
export declare function writeLockedIndex(api: FileApi, at: string, bytes: Uint8Array): Promise<FileStat>;
/** A writer that also streams a file it never holds whole (the wave writer's fileChunks). */
type StreamingWriter = CloneWriter & {
    fileChunks?(path: string, mode: number, size: number, chunks: AsyncIterable<Uint8Array>): Promise<void>;
};
/**
 * `writer` (rooted at `dir`, a namespace path on a mount), with each file
 * over a wave's mount limit, and the index of any size, written through
 * `api` instead, its receipt to `onReceipts`; a streamed file over the
 * limit is streamed through `api` too.
 */
export declare function mountWriter<W extends StreamingWriter>(writer: W, api: FileApi, dir: string, onReceipts?: (receipts: CloneReceipt[]) => void): W;
export {};
//# sourceMappingURL=mount-writer.d.ts.map