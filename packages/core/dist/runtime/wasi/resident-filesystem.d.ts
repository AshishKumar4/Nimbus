/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/facet-resident-store.ts, the one a node process reads its
 * synchronous calls from). This adapter puts the codec's calls in front of
 * it: a lookup, a stat, a directory listing and its descriptor, and a file's
 * bytes (which the codec holds for a read-only descriptor, its ResidentFd) are
 * answered from the store; anything that changes the filesystem, and anything
 * the store cannot vouch for, goes to the authority exactly as before. The
 * store is the process's one copy of file bytes, under its one budget: a
 * descriptor the codec answers itself pins the bytes it reads for its
 * lifetime (`pinContent`), charged to that budget, and past it the codec
 * opens the session's descriptor instead.
 *
 * What makes an answer from the store the authority's answer:
 *   - The walk is the authority's own (beneath-walk.ts walkBeneath), its
 *     lookups answered from the store's entries, so `..`, links, search
 *     permission and every refusal come out as the authority's would.
 *   - Only the session's SQLite filesystem is answered here, recognised by
 *     its device: an entry on another device (a mount: /proc, /dev, an
 *     embedder's) changes without the change log, so it is the authority's.
 *   - The store is coherent with the authority at its cursor, and the cursor
 *     moves by the ACQUIRE barrier. The barrier is owed after any call this
 *     adapter sent to the authority that may have changed something, and
 *     after input entered the process from outside (`inbound`): before its
 *     next answer the adapter takes it, so what the guest learned elsewhere,
 *     or did itself, is in what it reads next. That is the causal rule a node
 *     process keeps (core README, process model).
 *   - A name the store does not know (its directory not listed yet) is not
 *     absent: the adapter lists the directory and walks again.
 */
import type { RuntimeFsBridge, RuntimeFsPath, RuntimeVfsDirEntry, RuntimeVfsStat } from '../os-contracts.js';
import type { ProcessFsJournal, ProcessFsSession, ProcessFsStats } from '../../_shared/process-fs-client.js';
/** A name as the store holds it: its lstat, and a symlink's text. */
export interface ResidentEntry {
    type: 'file' | 'directory' | 'symlink';
    dev: number;
    ino: number;
    nlink: number;
    size: number;
    atime: number;
    mtime: number;
    ctime: number;
    mode: number;
    uid: number;
    gid: number;
    revision: number;
    target: string | null;
}
/** What the adapter asks of the process's store. Keys have no leading `/`. */
export interface ResidentNamespace {
    /** The device the session's SQLite filesystem reports: the only one answered here. */
    readonly device: number;
    /** The credential the process walks and reads as. */
    readonly cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
    };
    /** False while the store cannot answer (it lost its cursor): every call then goes to the authority. */
    ready(): boolean;
    /** The entry at `key`, no link followed: null when the store knows nothing is there, undefined when it does not know. */
    entry(key: string): ResidentEntry | null | undefined;
    /** The names in directory `key`, or undefined when it is not listed. */
    children(key: string): RuntimeVfsDirEntry[] | undefined;
    /** List directory `key`'s entries. False when it cannot be. */
    list(key: string): Promise<boolean>;
    /**
     * Learn the entries at `keys`, shallowest first, in one round trip; a
     * missing one is not recorded. With `content`, a small file at the last key
     * comes with its bytes.
     */
    lookup(keys: string[], content: boolean): Promise<boolean>;
    /** List everything under `key` in a few pages. False when that did not finish. */
    listTree(key: string): Promise<boolean>;
    /** The bytes of file `key` the store holds, or undefined. */
    content(key: string): Uint8Array | undefined;
    /** Fetch file `key`'s bytes (at `entry`'s revision) into the store; null when they could not be fetched. */
    fill(key: string, entry: ResidentEntry): Promise<Uint8Array | null>;
    /** The ACQUIRE barrier. */
    barrier(): Promise<boolean>;
    /** Charge `bytes` of heap held outside the store to its budget: false when they do not fit. */
    reserve(bytes: number): boolean;
    /** Return what `reserve` charged. */
    release(bytes: number): void;
}
/** A file's bytes, kept for a descriptor's lifetime: `release` when it closes. */
export interface PinnedContent {
    bytes: Uint8Array;
    release(): void;
}
export interface ResidentFilesystem extends RuntimeFsBridge {
    /**
     * The bytes of the file `path` names, which `stat` describes, kept for a
     * descriptor until it releases them: one buffer per revision however many
     * descriptors read it, charged once to the store's budget. Null when they
     * cannot be (the file changed, or the budget is spent): the caller opens
     * the session's descriptor instead.
     */
    pinContent(path: RuntimeFsPath, stat: RuntimeVfsStat): PinnedContent | null | Promise<PinnedContent | null>;
    /** Input from outside the process arrived: the barrier is owed before the next answer. */
    inbound(): void;
    /** Whether writes are held that the session does not have yet. */
    holding(): boolean;
    /**
     * Send every held write to the session, before something leaves the
     * process (a socket send): what it wrote is there before anyone hears from
     * it. A refusal stays recorded for the writer's close, fsync or settle.
     */
    flush(): Promise<void>;
    /**
     * fsync(2) through a descriptor this process holds no writes for (the
     * codec's own copy of a file): the file's held writes go to the session
     * first, and what they met is this call's answer.
     */
    syncInode(dev: number, ino: number): void | Promise<void>;
    /**
     * The end of a run: every held write goes to the session, and every refusal
     * not yet reported (by its descriptor's close or fsync) is returned, naming
     * the file, and forgotten.
     */
    settle(): Promise<UnsettledWrite[]>;
    /** What the process has asked so far, and who answered: a run's filesystem cost, in calls. */
    stats(): ResidentFilesystemStats;
}
/** A held file the session refused part of: what a run reports, naming the file. */
export interface UnsettledWrite {
    path: string;
    /** The file's identity: an fsync through any descriptor of it reports the refusal too. */
    dev: number;
    ino: number;
    error: unknown;
}
/** Counts since the process started. Every `delegated` call is a round trip to the session. */
export interface ResidentFilesystemStats {
    /** Calls answered from the store. */
    local: number;
    /** Calls the session answered, by name. */
    delegated: Record<string, number>;
    /** Path lookups (one round trip each), directory listings (two each) and tree listings. */
    lookups: number;
    listings: number;
    treeListings: number;
    /** Files fetched into the store, and their bytes. */
    fills: number;
    filledBytes: number;
    /** ACQUIRE barriers taken. */
    barriers: number;
    /** Wall time the process spent waiting on the session for any of the above, in ms. */
    waitMs: number;
    /** File bytes pinned for descriptors now, and how many buffers hold them. */
    pinnedBytes: number;
    pins: number;
    /** Its filesystem client's waves, grants and recalls, when it holds delegations. */
    client?: ProcessFsStats;
}
/**
 * What makes the process a delegation's holder (delegation-holder.ts): the
 * session calls it takes and answers recalls with, and which keys are home
 * directories (never held themselves).
 */
export interface ResidentDelegation {
    readonly session: ProcessFsSession;
    /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
    readonly grantAfter?: number;
    /** Inode numbers a first grant reserves (the client's GRANT_INOS). */
    readonly grantInos?: number;
    readonly isHomeRoot?: (key: string) => boolean;
    /** The process's own store's write log (HolderOptions.journal). */
    readonly journal?: ProcessFsJournal;
}
export declare function residentFilesystem(session: RuntimeFsBridge, resident: ResidentNamespace, delegation?: ResidentDelegation): ResidentFilesystem;
//# sourceMappingURL=resident-filesystem.d.ts.map