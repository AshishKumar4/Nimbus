/**
 * pre-bundle-facet.ts — NimbusLoaderPool entry for esbuild pre-bundling.
 *
 * Why this exists
 * ───────────────
 * Pre-bundling npm packages (the `Pre-bundling N modules…` step in
 * src/npm-installer.ts:704) used to call `EsbuildService.build(...)`
 * inside the supervisor DO isolate. Each `esbuild.build` allocates
 * 30–80 MiB of WASM linear memory plus the input/output graph; against
 * the 128 MB DO heap cap this OOM-killed the supervisor on installs
 * touching large React libraries (motion, framer-motion, etc.). The
 * symptom was a banner re-print after `npm install` succeeded —
 * NimbusSession's constructor running again because workerd had killed
 * the previous isolate.
 *
 * The fix is to dispatch each per-specifier `esbuild.build` to a
 * NimbusLoaderPool isolate. Each facet has its own 128 MB budget and
 * stable-slot reuse keeps the warm-up cost amortized across the 8
 * concurrent specs of a typical install. Same pattern as
 * src/npm-install-facet.ts (tarball extraction).
 *
 * File-slice strategy (zero per-read RPC)
 * ──────────────────────────────────────
 * esbuild's VFS plugin would naturally call back to the supervisor for
 * every onLoad / onResolve hit. With workerd's ~5–20 ms RPC latency and
 * 50–200 reads per bundle × 8 specs that's 4–32 seconds of pure RPC
 * overhead per install — measurably worse than the current OOM-y path.
 *
 * Instead the supervisor walks the spec's transitive non-external
 * dependency tree once (fast — direct VFS access) and ships the
 * entire `{path → bytes}` slice as part of the spec. The facet's VFS
 * plugin reads from this in-memory map. Zero RPC during bundling.
 *
 * Stability invariants
 * ───────────────────
 * cloudflare-parallel serializes the function via `fn.toString()`.
 *   - No `this` references (arrow / anonymous async).
 *   - No free variables other than preamble names + explicit args.
 *   - Module-level constants the function references must come from
 *     the preamble (src/parallel/pre-bundle-preamble.ts) — see
 *     `ESBUILD_PRELOAD_PREAMBLE`.
 *
 * The supervisor RPC surface (env.SUPERVISOR) is available for emergency
 * fallbacks but the bundle path MUST NOT use it — slice-up-front is the
 * contract.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { ResolvedPackage } from './resolver.js';
import { BUNDLER_VERSION } from '../runtime/esbuild-service.js';
/**
 * One file inside a facet spec's slice. `bytes` is a Uint8Array — esbuild's
 * loader inferences (js/ts/css/binary) need raw bytes for binary entries
 * and TextDecoder produces lossless text for source code.
 *
 * RPC serialisation: workerd transmits Uint8Array via structured-clone with
 * zero-copy semantics across same-process isolates. Memory cost on the
 * facet side equals the spec's slice size; cost on the supervisor side is
 * the same (the slice was just built from VFS reads).
 */
export interface SlicedFile {
    path: string;
    bytes: Uint8Array;
    isDir: false;
}
export interface SlicedDir {
    path: string;
    isDir: true;
}
export type SliceEntry = SlicedFile | SlicedDir;
/** What the supervisor sends per pre-bundle dispatch. */
export interface PrebundleSpec {
    /** Bare specifier being bundled, e.g. "framer-motion" or "react/jsx-runtime". */
    specifier: string;
    /** VFS path of the entry point, e.g. "/home/user/app/node_modules/framer-motion/dist/es/index.mjs". */
    entryPath: string;
    /** External specifiers (from getSharedRuntimeExternals). */
    externals: string[];
    /**
     * Slice: every file/dir the bundler may need for this spec. Computed
     * supervisor-side via a transitive-dependency walk. Includes:
     *   - Every file under node_modules/<spec-pkg>/
     *   - Every file under node_modules/<dep>/ for each transitive dep
     *     NOT marked external by `externals`.
     */
    slice: SliceEntry[];
    /** Stamp written into pkg_esm_bundles.bundle_hash; matches BUNDLER_VERSION. */
    bundlerVersion: string;
    /** Optional esbuild `define` map. Used by the on-demand bundler path
     *  (vite-dev-server) to inject process.env.NODE_ENV, import.meta.env.*,
     *  global → globalThis, etc. The pre-bundle path leaves this undefined
     *  (browser-target build needs no define replacement). */
    define?: Record<string, string>;
}
/** What the facet returns. */
export interface PrebundleResult {
    specifier: string;
    ok: boolean;
    /** ESM bundle output as a UTF-8 string. Empty when ok=false. */
    esmCode: string;
    /** First esbuild error message; populated when ok=false. */
    errorText?: string;
    /** Wall-clock ms inside the facet (bundling only, excludes RPC roundtrip). */
    elapsed: number;
    /** Non-fatal warnings the supervisor should surface. */
    warnings: string[];
}
/**
 * Walk node_modules to collect every file the pre-bundle of `specifier`
 * may read. Runs in the supervisor (cheap — direct VFS access).
 *
 * Algorithm:
 *   1. Compute the externals via getSharedRuntimeExternals(specifier).
 *      These are the bare specifiers esbuild will leave external; their
 *      files do NOT need to be in the slice.
 *   2. Resolve the spec's package directory and add every file beneath
 *      it to the slice.
 *   3. Read its package.json `dependencies` and recurse into each one
 *      that is NOT in the externals set. Deps that walked up are
 *      visited at most once (visited set).
 *
 * Lives here (alongside the facet function) so changes to the slice
 * shape touch one file — the supervisor caller in npm-installer.ts is
 * a thin orchestrator.
 */
export interface BuildSliceOptions {
    /** Cap on total bytes shipped to the facet. 24 MiB leaves headroom under
     *  the 32 MiB workerd RPC cap. Returns `null` if the cap is exceeded so
     *  the caller can decide whether to bail or split (bf41d1c precedent).
     */
    maxBytes?: number;
}
export declare function buildSliceForSpecifier(vfs: SqliteVFS, specifier: string, nmDir: string): {
    slice: SliceEntry[];
    totalBytes: number;
} | null;
export declare function buildSliceForSpecifierWithCap(vfs: SqliteVFS, specifier: string, nmDir: string, capBytes: number): {
    slice: SliceEntry[];
    totalBytes: number;
} | null;
/**
 * Choose the externals list for a specifier, exported so the supervisor
 * can compute the same value when building the spec without re-pulling
 * the helper from esbuild-service.ts on the call site.
 */
export declare function externalsForSpecifier(specifier: string): string[];
/**
 * Bundle one specifier in a facet isolate. Returns the ESM bundle output
 * to the supervisor; bundle bytes flow through `pool.map`'s return value
 * (no RPC writeBatch — pkg_esm_bundles is supervisor-side SQLite, not VFS).
 *
 * Memory plan (verified by /api/_diag/memory after the rollout):
 *   - Slice retained in facet memory: ~3–10 MiB per typical React lib.
 *   - esbuild WASM linear memory: ~30–80 MiB during build.
 *   - Output bundle: usually <2 MiB.
 *   - Peak in the facet: ~100 MiB worst case (well under 128 MB cap).
 *
 * The supervisor never holds more than the spec arg + result return at
 * once, so its peak stays in the low tens of MiB during the entire
 * pre-bundle phase.
 */
export declare const prebundleOne: (spec: PrebundleSpec, _env: {
    SUPERVISOR: {
        readFile(p: string): Promise<string | null>;
    };
}) => Promise<PrebundleResult>;
export { BUNDLER_VERSION };
export type _ResolvedPackage = ResolvedPackage;
//# sourceMappingURL=pre-bundle-facet.d.ts.map