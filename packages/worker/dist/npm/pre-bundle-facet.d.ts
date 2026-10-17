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
import type { CredentialedVfs, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export type { PrebundleResult, PrebundleSpec, SlicedDir, SlicedFile, SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export type PrebundleReadFs = Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'access' | 'readdir' | 'readFile' | 'readFileString' | 'revision'> & {
    stat(path: string): Readonly<VfsStat>;
};
/** Only consulted answers guard a plan: sibling package/synthetic writes are not inputs. */
export declare class PrebundleInputs {
    private readonly vfs;
    readonly fs: PrebundleReadFs;
    private readonly checks;
    private readonly stats;
    private checkedRevision;
    constructor(vfs: PrebundleReadFs);
    private remember;
    private file;
    current(): boolean;
}
export interface SlicePlanEntry {
    path: string;
    slicePath: string;
    isDir: boolean;
    size: number;
}
export interface PrebundleSlicePlan {
    inputs: PrebundleInputs;
    entries: SlicePlanEntry[];
    totalBytes: number;
    allocationBytes: number;
}
export declare class PrebundlePlanChanged extends Error {
    constructor();
}
export declare function buildSliceForSpecifierWithCap(vfs: PrebundleReadFs, specifier: string, nmDir: string, capBytes: number): {
    slice: SliceEntry[];
    totalBytes: number;
} | null;
/** Discover names and sizes without retaining a slice; metadata parsing owns only its current input. */
export declare function planSliceForSpecifierWithCap(vfs: PrebundleReadFs, specifier: string, nmDir: string, capBytes: number, inputs?: PrebundleInputs): PrebundleSlicePlan | null;
/** A discovered scoped graph, including the same directories its old slice carried. */
export declare function planSliceFromPaths(vfs: PrebundleReadFs, paths: ReadonlyArray<{
    path: string;
    isDir: boolean;
}>, capBytes: number, inputs?: PrebundleInputs): PrebundleSlicePlan | null;
/** Synchronous and admitted by its caller: no parser/RPC wait can retain a partial slice. */
export declare function materializePrebundleSlice(vfs: PrebundleReadFs, plan: PrebundleSlicePlan): SliceEntry[];
//# sourceMappingURL=pre-bundle-facet.d.ts.map