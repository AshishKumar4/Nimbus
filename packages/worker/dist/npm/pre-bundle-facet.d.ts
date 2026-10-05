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
import type { ResolvedPackage } from './resolver.js';
import type { SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export type { PrebundleResult, PrebundleSpec, SlicedDir, SlicedFile, SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export declare function buildSliceForSpecifierWithCap(vfs: CredentialedVfs, specifier: string, nmDir: string, capBytes: number): {
    slice: SliceEntry[];
    totalBytes: number;
} | null;
/**
 * Choose the externals list for a specifier, exported so the supervisor
 * can compute the same value when building the spec without re-pulling
 * the helper from esbuild-service.ts on the call site.
 */
export declare function externalsForSpecifier(specifier: string): string[];
export type _ResolvedPackage = ResolvedPackage;
//# sourceMappingURL=pre-bundle-facet.d.ts.map