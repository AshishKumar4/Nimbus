/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/resident, the one a node process reads its
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
import type { RuntimeFsBridge, RuntimeFsPath, RuntimeSynchronousFs, RuntimeVfsDirEntry, RuntimeVfsStat } from '../os-contracts.js';
import { type HolderOptions } from './delegation-holder.js';
import type { ReadDirectorySupervisor } from '../read-directory-batch.js';
import type { VfsAcquireResult } from '../os-contracts.js';
import type { ProcessFsClient, ProcessFsJournal, ProcessFsSession, ProcessFsStats } from '../../_shared/process-fs-client.js';
import type { WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
import { type FeedPosition } from '../feed-position.js';
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
    /**
     * The bytes of file `key` the store holds, or undefined; with `revision`,
     * only bytes dated at it or later (or the facet's own): a read of older
     * bytes that landed after a barrier admitted the change is not served.
     */
    content(key: string, revision?: number): Uint8Array | undefined;
    /** Fetch file `key`'s bytes (at `entry`'s revision) into the store; null when they could not be fetched. */
    fill(key: string, entry: ResidentEntry): Promise<Uint8Array | null>;
    /**
     * Pages `first`..`last` (RESIDENT_PAGE_BYTES each) of file `key`, `size`
     * bytes at revision `revision`: held ones from the store, the rest read
     * pinned to that revision and held, with how many were read. Null when
     * the file is no longer at `revision` or a read failed.
     */
    pages(key: string, revision: number, size: number, first: number, last: number): Promise<{
        pages: Uint8Array[];
        fetched: number;
    } | null>;
    /** Fetch these files' bytes (each at its entry's revision) into the store in batched round trips. */
    fillMany(files: ReadonlyArray<readonly [string, ResidentEntry]>): Promise<void>;
    /** The ACQUIRE barrier: landed when the store answers at the session's state as of it. */
    barrier(options?: ResidentBarrierOptions): Promise<ResidentBarrier>;
    /** What a barrier asks the session with (its cursor and options), for a delivery to answer from; null with no cursor. */
    acquireArgs(): ResidentAcquireArgs | null;
    /** Whether the store holds rows a repair could not vouch for: every barrier repairs until one does. */
    repairOwed?(): boolean;
    /** The store's provenance cursor: the namespace's position its rows are known-good at. */
    cursor(): FeedPosition | null;
    /** Charge `bytes` of heap held outside the store to its budget: false when they do not fit. */
    reserve(bytes: number): boolean;
    /** Return what `reserve` charged. */
    release(bytes: number): void;
    /**
     * `listener` is told of each row the view takes in (a barrier's or an
     * answer's delta, a listing, a lookup), by its key and its file's number
     * (`dev`, `ino`, as `entry` has them), synchronously within the admission:
     * in the same turn the view holds the row, before any caller can read it,
     * so whoever holds a file by its number has its row and name as the view
     * does, never one behind. It reads the row (`entry`) only for a number it
     * holds.
     */
    onAdmitted?(listener: (key: string, dev: number, ino: number) => void): void;
}
/**
 * What a barrier asks the session with: the store's cursor, and its ACQUIRE
 * options. A process's own also carry `begin`, the watermark of its own
 * changes when they were built, and `own`, its own debt then (acquireArgs).
 */
export interface ResidentAcquireArgs {
    readonly position: FeedPosition;
    readonly options?: object;
    readonly begin?: number;
    readonly own?: number;
}
/** A read lease's terms, as an ACQUIRE answer carries them. */
export type ResidentReadLease = NonNullable<VfsAcquireResult['readLease']>;
export interface ResidentBarrierOptions {
    /** An answer the caller took itself (a directory batch's), applied as the barrier applies one. */
    readonly answer?: VfsAcquireResult;
    /**
     * An answer a delivery carried, with the arguments it was asked with: it
     * stands in for asking when it answers from a position the store has
     * reached.
     */
    readonly delivered?: {
        readonly args: ResidentAcquireArgs;
        readonly answer: VfsAcquireResult;
    } | null;
    /** A read lease asked with the barrier: `answered` once the session grants it, whatever the barrier does next. */
    readonly lease?: {
        answered(terms: ResidentReadLease): void;
    } | undefined;
}
export interface ResidentBarrier {
    /** The store answers at the session's state as of this barrier. */
    readonly landed: boolean;
    /** The answer (asked, delivered or given) was applied as it was: not started again from, nor repaired past. */
    readonly applied?: boolean;
    /** The lease the answer granted, applied with it (vouched from now). */
    readonly readLease?: ResidentReadLease;
    /** The answer a delivery carried stood in for asking. */
    readonly fromDelivery?: boolean;
}
/** A file's bytes, kept for a descriptor's lifetime: `release` when it closes. */
export interface PinnedContent {
    bytes: Uint8Array;
    release(): void;
    /** The name it was pinned at, which an open of /dev/fd/N opens it again by while that name has it (openIdentified). */
    name: string;
}
export interface ResidentFilesystem extends RuntimeFsBridge {
    /**
     * The same filesystem for a caller that cannot wait: each call answered
     * now from what this process holds and has decided, or refused before it
     * begins anything (EAGAIN: what it needs is the session's, not resident;
     * the name's own state where the view knows it). Never a promise.
     */
    readonly synchronous: RuntimeSynchronousFs;
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
    /**
     * Input arrived and the program is about to run on it (a timer, a
     * response, a relayed frame, a delivered answer): the barrier taken now,
     * so a synchronous call in what runs next reads the session's state as of
     * the input. `viaIo`: taken where I/O just arrived, which a trusted read
     * lease answers without asking (nothing the process holds has changed: a
     * change waits for the lease's recall). `delivered`: an answer the
     * delivery carried, which stands in for asking when it can. Resolves once
     * the barrier landed or failed (a failure is owed still).
     */
    catchUp(options?: {
        viaIo?: boolean;
        delivered?: ResidentBarrierOptions['delivered'];
    }): Promise<void>;
    /** What a barrier asks the session with, for a delivery to answer from (ResidentNamespace.acquireArgs), with the process's watermark and own debt then. */
    acquireArgs(): (ResidentAcquireArgs & {
        readonly begin: number;
        readonly own: number;
    }) | null;
    /** A park's deadline elapsed; never install an abandoned directory open's late answer. */
    cancelPendingDirectories(): void;
    /** Whether writes are held that the session does not have yet. */
    holding(): boolean;
    /**
     * The process's filesystem client, its holder's and the only one it has:
     * its effect is the output gate (what the holder decided logged and sent
     * first, the client left live), its published and rawSocket the escapes.
     * Null where the process holds nothing (no delegation).
     */
    readonly client: ProcessFsClient | null;
    /** What the process decided and has not logged, logged now into its own log, with no round trip, and the client sealed: the run's end (DelegationHolder.logHeld). */
    logHeld(): void;
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
     * The end of a run: every held write goes to the session, every fault-in
     * out ends, and every refusal not yet reported (by its descriptor's close
     * or fsync) is returned, naming the file, and forgotten.
     */
    settle(): Promise<UnsettledWrite[]>;
    /**
     * The reads the program was refused (`synchronous`, not resident) that
     * nothing has answered since, by key, in the order first refused, once
     * every fault-in out has ended: less those the view now knows are absent
     * (ResidentDelegation.residency; none without it). Not the run's end: a
     * live process asks as often as it reports.
     */
    misses(): Promise<string[]>;
    /** What the process has asked so far, and who answered: a run's filesystem cost, in calls. */
    stats(): ResidentFilesystemStats;
    /** The directories this process opened, in order (bounded): the next run's in the same facet (ResidentDelegation.walked). */
    walked(): readonly string[];
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
    /** Files fetched into the store, and their bytes; of those, fetched ahead of their reads (and with the read that asked). */
    fills: number;
    filledBytes: number;
    readAhead: number;
    /** Of those, fetched for a refused synchronous read (ResidentDelegation.residency). */
    faultIns: number;
    /** Reads of files too big to hold whole answered through the store's pages, and the pages the session was asked for. */
    pagedReads: number;
    pagesFetched: number;
    /** ACQUIRE barriers taken, and of those, ones that did not land (owed still). */
    barriers: number;
    barrierFailures: number;
    /** Barriers owed by input a trusted read lease answered without asking. */
    leasedBarriers: number;
    /** Wall time the process spent waiting on the session for any of the above, in ms. */
    waitMs: number;
    /** Session interactions begun: calls, listings, lookups, fills, pages and barriers. */
    sessionCalls: number;
    /** Synchronous calls refused because they needed the session (not resident). */
    notResident: number;
    /** File bytes pinned for descriptors now, and how many buffers hold them. */
    pinnedBytes: number;
    pins: number;
    /** What its provisional decisions keep of the store's budget now, as they cost it (Provisional.kept): with pinnedBytes, all it has taken. */
    provisionalBytes: number;
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
    /** The process's live umask, for what a caller that cannot wait makes outside a held subtree (HolderOptions.umask). */
    readonly umask?: () => number;
    /** The timers and clock the process's filesystem runs on (HolderOptions.timers, now): the runtime's own, not a program's. */
    readonly timers?: WaveTimers;
    readonly now?: () => number;
    /**
     * Whether this run asks a read lease with each barrier (ProcessFsClient.
     * readLeaseAsk). A run that can stop and run again takes none: when it
     * asks, and what it is answered, are the run before's.
     */
    readonly readLeases?: () => boolean;
    /** The process's own store's write log (HolderOptions.journal). */
    readonly journal?: ProcessFsJournal;
    /** Told of each change the process's client logs (HolderOptions.logged). */
    readonly logged?: HolderOptions['logged'];
    /**
     * A mount that states no change model is answered as the store's walk of
     * it left it (its launch named it), and what this process changes on a
     * mount (but the kernel's /dev and /proc) is decided here, staying its own
     * where the view never hears of it: node's, as its fs always answered.
     * Without it such a mount is the session's to answer, and every mount's
     * changes the session's to decide.
     */
    readonly walkedMounts?: boolean;
    readonly readDirectories?: ReadDirectorySupervisor['fsReadDirectories'];
    /**
     * The directories the last process in this facet opened, in order (its
     * walked()): a run that repeats it (git status, again) opens them again,
     * so the batch prefetches them first. A guess: each prefetched
     * description is admitted only if the namespace still vouches for it.
     */
    readonly walked?: readonly string[];
    /**
     * The process's program reads synchronously (node's): a read it is
     * refused is recorded (ResidentFilesystem.misses), and a refused file's
     * bytes are fetched for its next read. Without it a refusal leaves
     * nothing (a WASI program's).
     */
    readonly residency?: ProgramResidency;
}
/**
 * What a program that reads synchronously is refused. A refused read is a
 * code no program branches on (EAGAIN cannot come of reading a regular
 * file), so whatever catches it carries on as if the file were missing:
 * the run's end reports what is left (misses), and the next launch stages
 * it. A refused read stays the program's miss until its own awaited read of
 * the name answers it (one of the file's bytes for a refused read of them,
 * any for a refused stat), or the view knows the name absent; a fill behind
 * its back or a later synchronous answer does not, since it may have built
 * on the refusal by then (vite's resolver swallows a refused package.json).
 * A refused read of a file the view has fetches its bytes for the next read
 * (a fault-in): one fetch per file while it is out, which every read of it
 * joins; the refusals of one turn are fetched together; one that did not
 * land is asked again by the next refusal.
 */
export interface ProgramResidency {
    /** The speculative read running now (the import prefetch's), or null. */
    speculation(): ResidentSpeculation | null;
    /** A read the program was refused, by key, for the first time: told as it happens, so a run the platform kills has reported it. */
    missed?(key: string): void;
}
/**
 * A speculative read (an import's prefetch, reading ahead of its load as the
 * load will read): a read refused under it is its own, never the program's,
 * and the fetch of a file it is refused is charged to its quota first.
 */
export interface ResidentSpeculation {
    /**
     * `key` was refused under it. `fetch` brings its bytes: a fill issued for
     * it, or one out it joined, telling whether they are held once it ends.
     * Null where none was issued: past its quota, or nothing to fetch (a name
     * the view cannot say, bytes only the session reads).
     */
    missed(key: string, fetch: Promise<boolean> | null): void;
    /** One more file, of `bytes`, before its fetch is issued: false past its quota, and nothing is issued. */
    charge(bytes: number): boolean;
}
export declare function residentFilesystem(session: RuntimeFsBridge, resident: ResidentNamespace, delegation?: ResidentDelegation): ResidentFilesystem;
//# sourceMappingURL=resident-filesystem.d.ts.map