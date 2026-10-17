/**
 * What a caller that cannot wait (ResidentFilesystem.synchronous) decides
 * where no subtree the process holds decides it (VFS-9 B stage 3, rev 5):
 * answered now from this process's view, logged as the operations it made,
 * and the session's to refuse.
 *
 * The log is the overlay. Every decision is a record in log order: a name
 * made, removed or moved, or an operation on an inode (write, append,
 * truncate, chmod, chown, utimes). What the process sees of a name or an
 * inode is its admitted baseline with its pending records folded over it
 * (inode-fold.ts). An answered record retires once a barrier begun after
 * its answer lands; a refused one leaves, and what it touched is folded
 * again from the baseline. A rename moves names, never records.
 *
 * One Inode per (dev, ino) this process has opened or changed here: every
 * descriptor's read, write, truncate, stat, seek, attribute change, reopen
 * and close goes through it. Its identity is checked against the row its
 * name leads to: a name that leads elsewhere leaves it what it retains, or
 * ESTALE, never another file's bytes or attributes. A descriptor that may
 * write is opened at the session as it was opened here, by a description of
 * its own, and writes by it.
 *
 * Every call plans what it will log and keep, judges all of it (refusals,
 * the client's synchronous cap on what it logs, the budget for what it
 * keeps), then commits: a refusal, or a call that cannot answer now, leaves
 * nothing. What is admitted is given back by the object that holds it.
 */
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import type { ProcessFsClient } from '../../_shared/process-fs-client.js';
/** What the provisional decisions read and log through: the holder's. */
export interface ProvisionalHost {
    readonly device: number;
    readonly cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
    };
    /** The row at `key` this process's provisional decisions aside (a held subtree's included): undefined where the view does not know. */
    row(key: string): ResidentEntry | null | undefined;
    /** The listing of `key`, as `row` sees it. */
    children(key: string): RuntimeVfsDirEntry[] | undefined;
    /** The store's bytes of `key` at `revision`, where it holds them. */
    content(key: string, revision: number): Uint8Array | undefined;
    reserve(bytes: number): boolean;
    release(bytes: number): void;
    readonly client: ProcessFsClient;
    /** Log what a held subtree decided and has not logged yet: what is logged here comes after it. */
    drain(): void;
    /** What was logged here was answered: the view owes the session's version of it (a barrier). */
    sent(): void;
    /** Whether the process sees anything of its provisional decisions now: what reads by name and by number consult them only while it does. */
    active(on: boolean): void;
    /** Whether a held subtree holds `key`: its grant decides there, and its names wait for it. */
    held(key: string): boolean;
    /** Count a change at `key` toward taking a subtree there, as a decided one is: once it is made. */
    count(key: string): void;
    /** The process's live umask. */
    umask(): number;
    now(): number;
    /** The next descriptor id, from the holder's own range. */
    nextHandle(): number;
}
export interface Provisional {
    /** What it keeps of the process's budget now, counted afresh from what it holds: what it has taken of it, where its accounting is right. */
    kept(): number;
    owns(handleId: number): boolean;
    /** Whether a decision of this process's at `key`, or at the directory it is in, is not yet the view's: a held subtree decides nothing there until it is. */
    touches(key: string): boolean;
    /** fcntl(F_SETFL) of a descriptor: O_APPEND is its writes' to keep. */
    setStatus(handleId: number, status: {
        append?: boolean;
    }): void;
    /** This process's provisional word on `key`: an entry, null (no name), or undefined (none). */
    entry(key: string): ResidentEntry | null | undefined;
    children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
    /** An open of `key` (resolved; `row` what it names, null for nothing): a descriptor, undefined where it is not made here. */
    open(key: string, path: string, flags: RuntimeOpenFlags, row: ResidentEntry | null): RuntimeFileHandle | undefined;
    /** A whole file written by name: its open, write and close, judged together. False where it is not made here. */
    writeFile(key: string, path: string, bytes: Uint8Array, row: ResidentEntry | null, umask: number | undefined): boolean;
    /** Undefined where its bytes are the store's and it does not hold them: inodeOf says what to fetch. */
    read(handleId: number, offset: number | null, length: number): Uint8Array | undefined;
    /** Logged as made: it needs none of the file's bytes (what it keeps is folded over them when they are held). */
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    ftruncate(handleId: number, size: number): void;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    fstat(handleId: number): ResidentEntry;
    fsetattr(handleId: number, attrs: W7Attrs): void;
    close(handleId: number): void;
    dup(handleId: number): RuntimeFileHandle;
    reopen(handleId: number, flags: RuntimeOpenFlags): RuntimeFileHandle | undefined;
    /** What a descriptor's read needs fetched: the name its file is at and its row; undefined where no name leads to it. */
    inodeOf(handleId: number): {
        key: string;
        entry: ResidentEntry;
    } | undefined;
    keyOf(handleId: number): string;
    mkdir(key: string, path: string, mode: number, row: ResidentEntry | null | undefined, umask: number | undefined): boolean;
    unlink(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
    rmdir(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
    symlink(key: string, path: string, target: string, row: ResidentEntry | null | undefined): boolean;
    rename(from: string, to: string, path: string, source: ResidentEntry | null | undefined, target: ResidentEntry | null | undefined): boolean;
    setattr(key: string, path: string, attrs: W7Attrs, row: ResidentEntry | null | undefined): boolean;
    copyFile(to: string, path: string, source: ResidentEntry, bytes: Uint8Array | undefined, target: ResidentEntry | null, keepMode: boolean): boolean;
    /** The bytes of the file `entry` names, where this process's are its content. */
    content(entry: ResidentEntry): Uint8Array | undefined;
    barrierBegun(): number;
    /** A barrier that began as `begun` landed: what was answered before it, outside a held subtree, is the view's now. */
    retire(begun: number): void;
}
export declare function provisional(host: ProvisionalHost): Provisional;
//# sourceMappingURL=provisional.d.ts.map