/**
 * The store's reads of the session: whole listings a page at a time, one
 * directory's, one subtree's, an lstat walk down one path, and file bytes in
 * packed ranged batches. What boot, reconcile and a lazily listed namespace
 * fetch with (sync.ts, lazy.ts). Every bound here is the session's.
 */
import type { RuntimeVfsStat, VfsListEntry } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { Admission } from './admission.js';
import type { Cells } from './cells.js';
import type { Coherence, Cursor } from './coherence.js';
import { type Namespace } from './namespace.js';
import type { ResidentSupervisor } from './supervisor.js';
/** A file to fetch: its listed size and revision, the epoch they are on, and its content key. */
export interface WantedFile {
    path: string;
    size: number;
    rev: number;
    epoch: string;
    ckey?: string | null;
    stat?: RuntimeVfsStat | null;
}
export interface FillReport {
    requested: number;
    filled: number;
    failed: number;
    bytes?: number;
    ranges?: number;
    copied?: number;
}
/** What one fetch did: files asked for, held (copies included), refused; bytes fetched, in how many ranges. */
export interface Fetched {
    requested: number;
    filled: number;
    failed: number;
    bytes: number;
    ranges: number;
    copied: number;
}
/** A whole enumeration: its files, every name, what the names cost a one-shot, its cursor, and whether it finished. */
export interface Listing {
    entries: WantedFile[];
    names: VfsListEntry[];
    namespaceBytes?: number;
    cursor: Cursor | null;
    complete: boolean;
    reason: string | null;
}
export declare const messageOf: (e: unknown) => string;
export interface Transport {
    relist(supervisor: ResidentSupervisor | null | undefined, dir: string): Promise<void>;
    fetchFiles(supervisor: ResidentSupervisor, files: WantedFile[]): Promise<Fetched>;
    enumerate(supervisor: ResidentSupervisor): Promise<Listing>;
    lookupKeys(supervisor: ResidentSupervisor, keys: string[], contentBytes: number): Promise<boolean>;
    listDirectory(supervisor: ResidentSupervisor, dir: string): Promise<boolean>;
    listSubtree(supervisor: ResidentSupervisor, dir: string): Promise<boolean>;
}
export declare function createTransport(coherence: Coherence, admission: Admission, namespace: Namespace, cells: Cells): Transport;
//# sourceMappingURL=transport.d.ts.map