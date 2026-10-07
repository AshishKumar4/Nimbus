/**
 * git/clone-job.ts — a clone's durable job record, and the cleanup of a
 * clone that failed or was cut short, as git's remove_junk (builtin/clone.c)
 * cleans up after one.
 *
 * A clone's record (DO storage, CLONE_JOB_PREFIX and its destination) is
 * written under the clone's lease before the clone writes anything. It names
 * the job (its id is the one the clone's marker, .git/nimbus-clone-job,
 * carries), the credential the clone writes as, whether the destination
 * existed, and the clone's phase: 'transport' until every object the clone
 * fetches is in, then 'checkout' (git's junk_mode: JUNK_LEAVE_NONE, then
 * JUNK_LEAVE_REPO). It goes when the clone has finished, or its cleanup has.
 *
 * Cleanup runs in the DO on the session's filesystem, as the record's
 * credential, a slice of entries at a time with the DO yielded between
 * slices (a worktree of 33,980 files must not hold it):
 *   transport  everything in the destination, files first, then the
 *              directories deepest first, the job marker last; then the
 *              destination itself unless it existed (git keeps one that did,
 *              emptied)
 *   checkout   only what is Nimbus's: the clone's staging directory, its
 *              temporary packs and the job marker; the repository and what
 *              was checked out stay, as git leaves them ("Clone succeeded,
 *              but checkout failed.")
 * Each slice walks what is left, so a cleanup cut short (a reset) is
 * finished by the next generation of the session: it lists the records of
 * earlier generations before it serves anything, reserves each destination
 * (its lease) before the filesystem takes a write, and cleans them up in the
 * background. A destination whose marker names another job is not the
 * record's to touch: only the record goes. The clone proves its
 * destination absent or empty before it writes the record, so a cleanup
 * removes only what the clone made.
 */
import type { VfsCred } from '@nimbus-sh/core/vfs/vfs.js';
/** What a clone's job record says. */
export interface CloneJobRecord {
    version: 1;
    jobId: string;
    /** The destination, as the session's filesystem names it (no leading slash). */
    dir: string;
    /** The credential the clone writes as, and its cleanup removes as. */
    cred: VfsCred;
    /** The destination existed (empty) before the clone: its cleanup keeps it. */
    rootExisted: boolean;
    phase: 'transport' | 'checkout';
    /** The session's generation (fabric generation.ts) that ran the clone: an earlier one's clone is not running. */
    generation: number;
    startedAt: number;
}
/** The storage the records live in (DurableObjectStorage's async KV). */
export interface CloneJobStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: {
        prefix: string;
    }): Promise<Map<string, T>>;
}
export declare const CLONE_JOB_PREFIX = "git-clone-job:";
/** Entries a cleanup removes before it yields the DO. */
export declare const CLEANUP_SLICE_ENTRIES = 2000;
export declare function writeCloneJob(storage: CloneJobStorage, record: CloneJobRecord): Promise<void>;
export declare function setCloneJobPhase(storage: CloneJobStorage, record: CloneJobRecord, phase: CloneJobRecord['phase']): Promise<void>;
export declare function deleteCloneJob(storage: CloneJobStorage, dir: string): Promise<void>;
export declare function listCloneJobs(storage: CloneJobStorage): Promise<CloneJobRecord[]>;
/** What a cleanup works through: the session's filesystem, as the record's credential (and the clone's lease, while it holds one). */
export interface CleanupFs {
    readFile(path: string): Uint8Array;
    readdir(path: string): {
        name: string;
        type: string;
    }[];
    unlink(path: string): void;
    rmdir(path: string): void;
}
/** How a cleanup went. */
export interface CleanupOutcome {
    /** 'removed': git's JUNK_LEAVE_NONE; 'kept-repo': JUNK_LEAVE_REPO; 'not-ours': another job's marker. */
    outcome: 'removed' | 'kept-repo' | 'not-ours';
    removed: number;
    slices: number;
}
/**
 * The record's cleanup, then the record. `yieldBetween` lets the DO serve
 * others between slices; `sliceEntries` bounds a slice.
 */
export declare function cleanUpClone(fs: CleanupFs, storage: CloneJobStorage, record: CloneJobRecord, options?: {
    sliceEntries?: number;
    yieldBetween?: () => Promise<void>;
}): Promise<CleanupOutcome>;
/** The session's filesystem, as the cleanup of a clone no lease holds takes it. */
export interface SessionCleanupFs {
    as(cred: VfsCred, options?: {
        mutationOwner?: string;
    }): CleanupFs & {
        acquireExclusiveMutation(path: string, options?: {
            includeMissingAncestors?: boolean;
        }): {
            owner: string;
        };
    };
    releaseExclusiveMutation(owner: string): void;
}
/** The records of clones an earlier generation of the session ran (than `current`): none of them is running. */
export declare function listInterruptedClones(storage: CloneJobStorage, current: number): Promise<CloneJobRecord[]>;
/** A clone's record, and the lease its cleanup holds on its destination. */
export interface ReservedClone {
    record: CloneJobRecord;
    owner: string;
}
/**
 * Each record's destination reserved (its lease taken, as the record's
 * credential), before anything else can write there: the session does this
 * as its filesystem comes up. One that cannot be reserved (another lease
 * overlaps it) is left for the next generation.
 */
export declare function reserveInterruptedClones(vfs: SessionCleanupFs, records: readonly CloneJobRecord[]): ReservedClone[];
/**
 * The cleanup of each reserved clone, in slices, its lease released when it
 * is done (or has failed: its record stays for the next generation).
 */
export declare function finishReservedClones(vfs: SessionCleanupFs, storage: CloneJobStorage, reserved: readonly ReservedClone[], options?: {
    sliceEntries?: number;
    yieldBetween?: () => Promise<void>;
}): Promise<CleanupOutcome[]>;
//# sourceMappingURL=clone-job.d.ts.map