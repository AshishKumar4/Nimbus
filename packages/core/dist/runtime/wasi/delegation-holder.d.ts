/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and logs
 * them as calls into the process's filesystem client (process-fs-client.ts,
 * P4b), which takes the subtrees, numbers the log and sends it, in order:
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls a subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held once the process has mutated in it often enough to
 *     be worth it (the client's policy): the deepest existing directory
 *     holding the name it changes, a bounded number of them. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL
 *     in it (its inheritance is the session's to apply): there, the process
 *     writes through as before.
 *   - Refusals are the walk's own (resolve), and the cases decided here are
 *     the plain ones: a create where the parent is a writable directory, a
 *     mkdir, an unlink of a file or link, a rename of a file, or of a
 *     directory to a free name outside itself, within one held subtree. Any
 *     other mutation in a held subtree sends the log first and is the
 *     session's, as before.
 *   - A name made here is numbered from the grant's reserved inode range and
 *     keeps that number in the session; it is owned as the session makes a
 *     holder's names (the process's, a setgid directory's group), its mode
 *     the asked mode less the umask.
 *   - The log keeps program order: each decision is logged as it is made,
 *     and a file's bytes, which change write by write, are logged whole (its
 *     latest) before the next decision is, or at the flush.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */
import type { RuntimeFileHandle, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { type ProcessFsClient, type ProcessFsJournal, type ProcessFsSession } from '../../_shared/process-fs-client.js';
/** What the holder reads of the process's resident store (its own decisions aside). */
export interface HolderStore {
    readonly device: number;
    readonly cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
    };
    /** As ResidentNamespace.entry: undefined when the store does not know. */
    entry(key: string): ResidentEntry | null | undefined;
    /** As ResidentNamespace.children. */
    children(key: string): RuntimeVfsDirEntry[] | undefined;
}
export interface HolderOptions {
    /** The session the process's filesystem client sends to and takes its grants from. */
    readonly session: ProcessFsSession;
    readonly store: HolderStore;
    /** Every engine key that is a home directory (`home/<name>`): never held itself. */
    readonly isHomeRoot?: (key: string) => boolean;
    /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
    readonly sent?: () => void;
    /** The clock files are stamped with. */
    readonly now?: () => number;
    /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
    readonly grantAfter?: number;
    /** Inode numbers a first grant reserves (the client's GRANT_INOS). */
    readonly grantInos?: number;
    /** Where the client logs what it sends until the session answers: the process's own store, where it has one (process-fs-journal.ts). */
    readonly journal?: ProcessFsJournal;
}
/** The decisions the process made in a held subtree, not yet sent. */
export interface DelegationHolder {
    /** The process's filesystem client: what the holder decided is logged into it. */
    readonly client: ProcessFsClient;
    /** What the process decided is at `key`: an entry, null (removed), or undefined (nothing decided). */
    entry(key: string): ResidentEntry | null | undefined;
    /** The names in `key`, as `base` lists them with what the process decided there. */
    children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
    /** The bytes of a file made or rewritten here. */
    content(entry: ResidentEntry): Uint8Array | undefined;
    /** Whether `handleId` is one of the holder's own descriptors. */
    owns(handleId: number): boolean;
    /**
     * Open `key` to write it at the session, as a write description outside
     * any subtree this process holds: one `open` call (W7Call open), ordered
     * with everything the process logged before it and answered with the
     * file's stat; the description it returns writes through (LocalFile.through).
     */
    openThrough(key: string, path: string, flags: {
        read?: boolean;
        append?: boolean;
        create?: boolean;
        truncate?: boolean;
        exclusive?: boolean;
        followSymlinks?: boolean;
        mode?: number;
    }): Promise<RuntimeFileHandle>;
    /**
     * Everything logged so far answered, what the session refused kept for the
     * next sync (flush) to report: what goes before a call to the session.
     */
    send(): Promise<void>;
    /** A refusal the session has made of what this process logged, thrown now (with its errno), not waiting for anything: what a close reports. */
    reportRecorded(): void;
    /**
     * The process is about to change a name or an access at or above `keys`
     * (anywhere, when absent) by a route not decided here (a call of the
     * session's, or a change by name the client logs): each file it holds
     * open there writes through from now on, its descriptions opened first.
     */
    changing(keys?: readonly string[]): void;
    /** Whether `handleId` writes through: its reads are the session's (readThrough). */
    through(handleId: number): boolean;
    /** A write-through description's session descriptor (its open answered), or undefined (a mount's file keeps none). */
    sessionOf(handleId: number): Promise<number | undefined>;
    /** fcntl(F_SETFL) of one of the holder's descriptors: O_APPEND is its writes' to keep. */
    setStatus(handleId: number, status: {
        append?: boolean;
    }): void;
    /** The size this process gave file `ino` through a description of it still open, or undefined: what a stat of it by name reports here. */
    writing(ino: number): number | undefined;
    /**
     * A read through a write-through description, at `offset` or its
     * position: `read` reads the session's bytes of `key` (what this process
     * sent before it is answered first).
     */
    readThrough(handleId: number, offset: number | null, length: number, read: (key: string, at: number, length: number) => Promise<Uint8Array>): Promise<Uint8Array>;
    /**
     * Decide an open that creates or empties a file at `key` (resolved, its
     * parent known): a descriptor of the holder's, or undefined when the
     * session is to decide it.
     */
    open(key: string, path: string, flags: {
        read?: boolean;
        write?: boolean;
        append?: boolean;
        create?: boolean;
        truncate?: boolean;
        exclusive?: boolean;
        mode?: number;
    }): RuntimeFileHandle | undefined;
    read(handleId: number, offset: number | null, length: number): Uint8Array;
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    ftruncate(handleId: number, size: number): void;
    fstat(handleId: number): ResidentEntry;
    close(handleId: number): void;
    /** The name a descriptor of the holder's writes, now. */
    keyOf(handleId: number): string;
    /** Another descriptor of the same open file (its position shared). */
    dup(handleId: number): RuntimeFileHandle;
    /** Decide a mkdir at `key`: true when decided here (and done), false when the session is to. */
    mkdir(key: string, path: string, mode: number): boolean;
    /** Decide an unlink of `key` (a file or link): true when decided here. */
    unlink(key: string, path: string): boolean;
    /** Decide a rename of `from` to `to` (both resolved): true when decided here. */
    rename(from: string, to: string, path: string): boolean;
    /** Decide an attribute change of `key`: true when decided here. */
    setattr(key: string, attrs: W7Attrs): boolean;
    /** Whether a mutation at `key` would be decided here (a held subtree holds it). */
    holds(key: string): boolean;
    /** Whether anything decided here is not sent yet. */
    pending(): boolean;
    /** Send everything decided, in order. A refusal is thrown (the run fails, naming it). */
    flush(): Promise<void>;
    /** The end of the run: send everything, and give every subtree back. */
    settle(): Promise<void>;
    /** Waves sent, recalls answered, and grants taken. */
    stats(): {
        waves: number;
        ops: number;
        recalls: number;
        grants: number;
        widened: number;
    };
}
export declare function delegationHolder(options: HolderOptions): DelegationHolder;
//# sourceMappingURL=delegation-holder.d.ts.map