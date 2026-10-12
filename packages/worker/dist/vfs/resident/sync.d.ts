/**
 * Bringing the store to the authority: the boot a process takes before its
 * first instruction, the ACQUIRE answers its barriers apply, the reconcile
 * that repairs a poison, and the listings and fetches all of them make.
 *
 * WHAT EXISTS has to come from the authority, not from anything the facet was
 * shipped. That was measured rather than assumed: for a working tree holding a
 * 25 MiB file outside the cwd, the spawn-time stat table this replaced arrived
 * with FOUR entries ("home", "opt", "var", "home/user"), every one a
 * directory. A launch ships only what it staged plus its ancestors; a store
 * that enumerated from that would hold only what the bundle already had, which
 * is the admission problem it exists to delete.
 *
 * One cost this store pays that a heap cache does not: LOSING the rows means
 * repopulating them, not lazily refetching on a miss. That is why the cursor is
 * PERSISTED beside the rows — a fresh incarnation resumes from a real cursor
 * instead of a null epoch, so it asks for a delta rather than inviting a poison
 * — and why a poison RECONCILES the rows against absolute per-path revisions
 * instead of dropping them. The invalidation log a delta rides on is
 * deliberately small (sqlite-vfs.ts, INVALIDATION_LOG_MAX_BYTES) and ordinary
 * write churn trims it past a live cursor as a matter of course, so "poison ⇒
 * full repopulation" made an npm install re-buy the whole filesystem over and
 * over — measured past the DO CPU limit at pi scale. See `synchronize`.
 */
import type { ResidentNamespace } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
import type { Admission } from './admission.js';
import type { Admitted, Cells } from './cells.js';
import { type ResidentCell } from './cell-cost.js';
import type { Coherence, Cursor } from './coherence.js';
import { type Namespace } from './namespace.js';
import type { ResidentCred } from './permissions.js';
import type { AcquireAnswer, ResidentStat, ResidentSupervisor } from './supervisor.js';
/** A file to fetch: its listed size and revision, the epoch they are on, and its content key. */
interface WantedFile {
    path: string;
    size: number;
    rev: number;
    epoch: string;
    ckey?: string | null;
    stat?: ResidentStat | null;
}
export interface FillReport {
    requested: number;
    filled: number;
    failed: number;
    bytes?: number;
    ranges?: number;
    copied?: number;
}
export interface SyncReport extends FillReport {
    skipped?: string;
    incomplete?: string;
    kept?: number;
    rekeyed?: number;
    dropped?: number;
    own?: {
        path: string;
        rev: number | null;
    }[];
    reconciled?: boolean;
    complete?: boolean;
    cursor?: Cursor | null;
}
export interface Sync {
    boot(takeBundle: () => Record<string, ResidentCell> | null | undefined, moduleCursor: unknown, supervisor: ResidentSupervisor | null | undefined, moduleBytes?: number): Promise<{
        cursor: Cursor | null;
        failure: string | null;
    }>;
    setPushRoots(roots: unknown): void;
    pushable(path: string): boolean;
    acquireOptions(): {
        namespace: true;
        push?: {
            roots: string[];
            exclude: string[];
        };
    };
    applyAcquire(supervisor: ResidentSupervisor | null | undefined, result: AcquireAnswer): Promise<Admitted>;
    relist(supervisor: ResidentSupervisor | null | undefined, dir: string): Promise<void>;
    bootLazy(supervisor: ResidentSupervisor | null | undefined): Promise<boolean>;
    namespaceView(supervisor: ResidentSupervisor, device: number, cred: ResidentCred): ResidentNamespace;
    setPlan(paths: unknown): void;
    setManifests(manifests: unknown): void;
    adoptModuleBundle(bundle: Record<string, ResidentCell> | null | undefined, moduleCursor: unknown): Cursor | null;
    fetchFiles(supervisor: ResidentSupervisor, files: WantedFile[]): Promise<Required<Omit<FillReport, 'bytes' | 'ranges' | 'copied'>> & {
        bytes: number;
        ranges: number;
        copied: number;
    }>;
    synchronize(supervisor: ResidentSupervisor | null | undefined): Promise<SyncReport>;
    refillFromNamespace(supervisor: ResidentSupervisor, dropped: readonly string[]): Promise<FillReport>;
    requireNamespace(supervisor: ResidentSupervisor | null | undefined, bootFailure: string | null): Promise<string | null>;
}
export declare function createSync(coherence: Coherence, admission: Admission, namespace: Namespace, cells: Cells): Sync;
export {};
//# sourceMappingURL=sync.d.ts.map