/**
 * pre-bundle-facet.ts — the supervisor's half of pre-bundling npm packages
 * (the `Pre-bundling N modules…` step in npm/installer.ts, and the Vite dev
 * server's on-demand /@modules/ bundles).
 *
 * Bundling runs in the Durable Object's build facet (facets/build-facet.ts:
 * `prebundle`, rolldown, core runtime/prebundle-slice.ts), never in the
 * supervisor: a bundle's working set (the engine's wasm memory plus the
 * input and output graph) would not fit beside the supervisor's own heap.
 *
 * File-slice strategy (zero per-read RPC)
 * ──────────────────────────────────────
 * A VFS plugin would naturally call back to the supervisor for every
 * resolve and load. With workerd's ~5–20 ms RPC latency and 50–200 reads
 * per bundle that is seconds of pure RPC overhead per install. Instead the
 * supervisor walks the spec's transitive non-external dependency tree once
 * (fast — direct VFS access) and ships the entire `{path → bytes}` slice as
 * part of the spec; the bundler reads from that in-memory map.
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export type { PrebundleResult, PrebundleSpec, SlicedDir, SlicedFile, SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export interface SlicePlanEntry {
    path: string;
    isDir: boolean;
    size: number;
}
export interface PrebundleSlicePlan {
    revision: number;
    fences: Array<{
        path: string;
        revision: number;
    }>;
    entries: SlicePlanEntry[];
    totalBytes: number;
    allocationBytes: number;
}
export declare class PrebundlePlanChanged extends Error {
    constructor();
}
export declare function buildSliceForSpecifierWithCap(vfs: CredentialedVfs, specifier: string, nmDir: string, capBytes: number): {
    slice: SliceEntry[];
    totalBytes: number;
} | null;
/** Discover names and sizes without retaining a slice; metadata parsing owns only its current input. */
export declare function planSliceForSpecifierWithCap(vfs: CredentialedVfs, specifier: string, nmDir: string, capBytes: number): PrebundleSlicePlan | null;
/** A discovered scoped graph, including the same directories its old slice carried. */
export declare function planSliceFromPaths(vfs: CredentialedVfs, paths: ReadonlyArray<{
    path: string;
    isDir: boolean;
}>, capBytes: number, roots?: readonly string[]): PrebundleSlicePlan | null;
/** Synchronous and admitted by its caller: no parser/RPC wait can retain a partial slice. */
export declare function materializePrebundleSlice(vfs: CredentialedVfs, plan: PrebundleSlicePlan): SliceEntry[];
//# sourceMappingURL=pre-bundle-facet.d.ts.map