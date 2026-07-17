/**
 * real-vite-fs-shim.ts — Phase 1 VFS-backed fs shim for the real-vite facet.
 *
 * What this file exports:
 *
 *   generateFsShimModuleCode()  — returns the ESM source of the module the
 *                                 facet imports as `node:fs` (via
 *                                 the esbuild alias in
 *                                 scripts/bundle-real-vite.mjs).
 *   generateFsPromisesShimModuleCode()
 *                               — ditto for `node:fs/promises`.
 *   buildFsSnapshot(vfs, root)  — supervisor-side helper that walks the
 *                                 SqliteVFS and returns a `{path: content}`
 *                                 snapshot to seed the facet's sync-fs Map.
 *
 * Design notes:
 *
 *   workerd facets are **async-only** for RPC. But Vite's code (and its
 *   bundled deps like readdirp, picomatch, magic-string, etc.) calls a
 *   LOT of synchronous node:fs functions during module initialization
 *   and config resolution — readFileSync, existsSync, statSync,
 *   readdirSync. We can't block on SUPERVISOR.readFile() from a sync
 *   call site.
 *
 *   Solution: the supervisor pre-builds an in-memory snapshot of the
 *   project VFS (all text files + synthetic vite package.json +
 *   node_modules of known-useful packages) and passes it to the facet
 *   via a synthetic `synthetic.js` module that seeds
 *   globalThis.__cirrusRealSynthetic. Every sync fs call first checks
 *   that Map. Async fs.promises calls fall through to
 *   env.SUPERVISOR.readFile(), letting Vite's middleware read files
 *   modified after boot.
 *
 *   Writes (writeFile, writeFileSync, mkdir, mkdirSync, rename, unlink)
 *   update the facet-local Map immediately AND fire an async RPC to
 *   the supervisor. Sync writes are best-effort fire-and-forget — the
 *   supervisor eventually persists, but a sync writer that reads back
 *   what it just wrote will Just Work because the local Map is
 *   coherent.
 *
 *   Watch (fs.watch, fs.watchFile): the facet runs a long-poll loop
 *   against SUPERVISOR.waitForVfsEvents(), translating VFS events into
 *   chokidar-shaped callbacks. This module exposes a minimal FSWatcher
 *   class that Vite's bundled chokidar sees via the esbuild alias
 *   (chokidar → this module).
 *
 *   All this logic is emitted as a JS string and loaded into the
 *   facet via LOADER.load({ modules }). Keeping it here (in a .ts
 *   source file) instead of a .generated.ts means editor + typecheck
 *   can read it even though TypeScript doesn't compile it.
 */
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
/**
 * Build a LAZY snapshot of the project for the facet's sync-fs Map.
 *
 * What gets eagerly seeded:
 *   - Every file under the user project (outside node_modules) up to
 *     16 MB total.
 *   - Every package.json under node_modules/** (needed for Vite's
 *     resolver walk-ups and for __cirrusRealUserspaceRequire).
 *
 * What does NOT get eagerly seeded:
 *   - Everything else in node_modules (JS source, CSS, etc.).
 *
 * Not-eagerly-seeded files are fetched on demand via the
 * SUPERVISOR.readFile RPC from the facet's async fs-promises shim,
 * AND populate the in-facet Map the first time they're read so
 * subsequent sync reads hit local memory.
 *
 * This keeps the facet boot memory footprint bounded (typical real
 * React project: ~2 MB instead of 10+ MB) while still delivering
 * correctness — Vite reads deps lazily during the transform pipeline,
 * so async-first-then-cache is the natural fit.
 */
export declare function buildFsSnapshot(vfs: CredentialedVfs, projectRoot: string): {
    files: Record<string, string>;
    dirs: string[];
    existingPaths: string[];
    totalBytes: number;
    skipped: number;
    fileCount: number;
    packageJsonCount: number;
    pathIndexCount: number;
};
/**
 * ESM source of the fs-shim module. esbuild's bundler sees
 *   import * as fs from 'node:fs'
 * in vite's bundle and (thanks to the alias plugin in
 * scripts/bundle-real-vite.mjs) rewrites those imports to this
 * module. The shim exports every fs name Vite touches, routing them
 * through `globalThis.__cirrusRealFs` — which we populate before the
 * first import of vite.bundle.js in synthetic.js.
 *
 * The runtime lives in globalThis so it survives cross-module
 * lookups AND can be re-seeded on facet reload.
 */
export declare function generateFsShimModuleCode(): string;
/**
 * ESM source of the fs/promises shim. Thin wrapper around the main
 * fs shim so `import x from 'node:fs/promises'` picks up the
 * snapshot-backed impl.
 *
 * Uses a RELATIVE import to ./cirrus-fs.js (not 'node:fs') because
 * cirrus-fs-promises.js is loaded as a LOADER module alongside
 * cirrus-fs.js — bare 'node:fs' here would route through workerd's
 * real node:fs instead of our shim.
 */
export declare function generateFsPromisesShimModuleCode(): string;
/**
 * ESM source for synthetic.js — seeds the globalThis-backed
 * snapshot BEFORE vite.bundle.js evaluates. Takes the output of
 * buildFsSnapshot() plus a few hard-coded synthetic files (vite's
 * package.json + client assets) that the Phase 0 spike already
 * proved we need.
 *
 * The supervisor binding (env.SUPERVISOR) is exposed as a global
 * via the facet entrypoint — not here, because env access requires
 * an async boot step.
 */
export declare function generateSyntheticModuleCode(opts: {
    viteVersion: string;
    snapshotFiles: Record<string, string>;
    snapshotDirs: string[];
    /**
     * Path-only index of every file under node_modules (no content).
     * Populated by buildFsSnapshot.existingPaths. Drives existsSync /
     * statSync so Vite's resolver walks deep module trees correctly
     * without us eager-caching every file.
     */
    existingPaths?: string[];
    /**
     * Base64-encoded rollup wasm bindings.
     */
    rollupWasmBase64?: string;
    /**
     * Map from user-project CJS package file-path patterns to
     * pre-built ESM bundle code.
     */
    cjsPrebuiltBundles?: Record<string, string>;
    /**
     * Real vite client runtime (dist/client/client.mjs). Served to
     * the browser at /@vite/client. Without this the browser loads
     * a stub and HMR+env don't work.
     */
    viteClientMjs?: string;
    /**
     * Real vite env runtime (dist/client/env.mjs).
     */
    viteEnvMjs?: string;
}): string;
//# sourceMappingURL=real-vite-fs-shim.d.ts.map