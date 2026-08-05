/**
 * EsbuildService — TypeScript/JSX transform + bundling via esbuild-wasm.
 *
 * Architecture:
 *   - esbuild-wasm is imported directly in the supervisor bundle
 *   - WASM is compiled during module evaluation (startup phase) — allowed
 *   - transform() runs in the supervisor's isolate (fast, no facet needed)
 *   - build() also runs in supervisor with a VFS resolver plugin
 *
 * Why not a facet? The esbuild-wasm WASM binary needs to be compiled
 * during module startup (not request time). Dynamic workers created via
 * LOADER.load() have the same restriction. Since esbuild-wasm is bundled
 * into the supervisor, it initializes once at startup and stays warm.
 *
 * Memory: esbuild-wasm uses ~15-20MB heap. Within the DO's 128MB budget
 * this is acceptable for Phase 3. Phase 4+ can move it to a dedicated
 * facet once wasm module passing to dynamic workers is stable.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
/**
 * Bundler version tag. BUMP THIS whenever bundling semantics change —
 * the esbuild plugin's resolver logic, the shared-externals rules, the
 * post-processing pipeline, or anything that would invalidate cached
 * pre-bundles. The version is stored in pkg_esm_bundles.bundle_hash and
 * checked on read; cache entries with a different version are treated
 * as missing and rebuilt from scratch.
 *
 * History:
 *   v1 — initial pre-bundling
 *   v2 — shared React externals, CJS named exports
 *   v3 — Node subpath imports (#foo) support for vfile/unified ecosystem
 *   v4 — legacy flat-subpath resolution (pkg/sub without exports field);
 *        CDN fallback wrapper no longer crashes on modules without default
 *   v5 — normalize `../` segments in joined entry paths (react-remove-scroll-bar
 *        style: nested package.json with "module": "../dist/es2015/foo.js")
 *   v6 — externals enforced via plugin onResolve only (top-level `external:`
 *        dropped). Fixes dual-React-instance bug where jsx-runtime and
 *        react-dom/client were inlining their own copy of react because
 *        esbuild's entry-point external check rejected the externals when
 *        passed at the top level. v5 cache entries are wrong (contain
 *        embedded react copies) and must be invalidated.
 *   v7 — barrel-package bundles include a named-import signature in
 *        pkg_esm_bundles.input_hash. Prevents reusing a lucide-react
 *        bundle synthesized for one icon set after user source imports
 *        additional icons.
 *   v8 — pkg_esm_bundles now stores RAW esbuild output (base-independent);
 *        the module-URL rewrite that used to be baked in is applied per
 *        request at serve time so one bundle serves every mount base. v7
 *        rows hold post-rewrite text and must be re-bundled. user_module_
 *        transforms is likewise re-keyed by mount base.
 */
export declare const BUNDLER_VERSION = "v8";
/**
 * Returns the list of specifiers that must be marked `external` when bundling
 * `specifier` so that React / React-DOM / Scheduler share a single instance
 * across all /@modules/ bundles.
 *
 * Why: React uses an internal module-scoped singleton
 * (`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`) for current dispatcher,
 * owner, etc. If two bundles each contain their own embedded React, they each
 * have their own singleton, and `createRoot` from one bundle sees JSX elements
 * created by the other as "alien" — silent render failure (root stays empty).
 *
 * The fix: when bundling react-dom/*, mark react/* and scheduler as external.
 * The bundler leaves `import {...} from "react"` in the output; the browser
 * then fetches /preview/@modules/react, which is the SAME URL the jsx-runtime
 * bundle imports — so both react-dom and jsx-runtime share ONE React instance.
 *
 * Similarly for react/jsx-runtime and react/jsx-dev-runtime (they must share
 * react's internals), we externalize `react` (but not `scheduler` — jsx-runtime
 * doesn't need it).
 */
export declare function getSharedRuntimeExternals(specifier: string): string[];
/**
 * Detect top-level await in source. Used by `EsbuildService.transform`
 * to decide whether to async-IIFE-wrap CJS-target sources (see
 * transform()'s header comment).
 *
 * Token scan over a comment-and-string-stripped source. Tracks paren
 * depth AND function-body depth so a `{` inside a parameter list (a
 * default-value object literal — `async function f(opts = {})`) is NOT
 * mistaken for the function body. The earlier heuristic lacked the paren
 * guard: the `= {}` braces consumed the body-tracking slot, leaving the
 * real body untracked so an internal `await` read as top-level. That
 * wrongly routed such files (e.g. @bluwy/giget-core's
 * download-template.js, reached by create-astro) into the two-pass
 * ESM→require rewrite, whose assembled output still carried export/import
 * statements → "Cannot use import statement outside a module" at startup.
 *
 * Arrow bodies are distinguished from arrow expression bodies (the
 * `arrowPending` flag): only a `{` immediately following `=>` opens a
 * function scope. The idiomatic object-returning arrow `x => ({ ... })`
 * has its `{` at parenDepth 1, so it opens no body slot — otherwise the
 * leaked slot would be consumed by a later top-level `{ ... }` block,
 * making a real top-level `await` inside it read as non-TLA (false
 * negative) and routing genuine ESM-with-TLA into the wrong transform.
 *
 * A regex/token scan (not acorn) is kept here deliberately: pulling
 * acorn into the esbuild-service bundle chunk duplicates its ~15 KiB
 * Unicode identifier tables.
 */
export declare function hasTopLevelAwait(src: string): boolean;
export interface TransformResult {
    code: string;
    map: string;
    warnings: {
        text: string;
        location?: any;
    }[];
}
export interface BuildOutputFile {
    path: string;
    contents: string;
}
export interface BuildResult {
    outputFiles: BuildOutputFile[];
    errors: {
        text: string;
        location?: any;
    }[];
    warnings: {
        text: string;
        location?: any;
    }[];
}
export declare class EsbuildService {
    private vfs;
    private initialized;
    private initPromise;
    /** Resolved esbuild namespace — populated by ensureInit() after loadEsbuild(). */
    private _esbuild;
    constructor(vfs: SqliteVFS);
    /**
     * Initialize esbuild-wasm (lazy, on first use). Loads the namespace
     * via `loadEsbuild()` (which itself is deferred) and caches it on
     * `this._esbuild` so subsequent calls don't pay the dynamic-import
     * overhead. All call sites that previously used the top-level
     * `esbuild` namespace now use `this._esbuild!` after `await this.ensureInit()`.
     */
    private ensureInit;
    /**
     * Transform a single code string (TS→JS, JSX→JS, minify, etc.)
     *
     * Top-level await note (gap #2 in framework-gaps-fix):
     * ─────────────────────────────────────────────────────
     * esbuild rejects top-level await when output format is 'cjs' or
     * 'iife' — neither has a runtime primitive for it. Real Node
     * supports TLA only in ESM. Nimbus's facet wrapper executes the
     * transformed code via `new Function(...)` which is CJS-shaped.
     *
     * Several modern CLIs (nuxi, vite-cli, oclif's lazy-load bootstrap,
     * many ESM-only-by-default tools) use TLA at the entry point. With
     * format:'cjs' those would crash with "Top-level await is currently
     * not supported with the 'cjs' output format" — an esbuild
     * SyntaxError surfaced as a Nimbus diagnostic. The user can't
     * fix this without rewriting upstream.
     *
     * Fix: when caller asks for format 'cjs' AND the source has a
     * top-level await, wrap the source in an async IIFE and return its
     * Promise to the facet runner:
     *
     *     return (async () => {
     *       <original-source>
     *     })();
     *
     * Inside the IIFE, await is legal. Returning the Promise is required:
     * the facet runner awaits promise-returning entry functions so
     * sequential TLA execution cannot race process teardown or VFS flushes.
     *
     * ESM-imports-in-CJS note (nuxt-esm-in-cjs wave):
     * ─────────────────────────────────────────────────
     * The IIFE wrap above moves the user source INTO a function body.
     * Top-level ESM `import` statements are LEGAL only at module top
     * level — inside a function body they're a SyntaxError. Real-world
     * trigger: nuxi's `bin/nuxi.mjs` opens with `import { performance }
     * from "node:perf_hooks"` and ends with `const { runMain } = await
     * import("./dist/index.mjs"); runMain()` — both ESM imports AND TLA.
     * Pre-fix the IIFE wrap caused esbuild to fail with
     * `Unexpected "<binding>"` at line 3 of stdin.
     *
     * Fix: when TLA AND ESM imports coexist, run a two-stage transform:
     *   1. Pass 1: `esbuild.transform(code, { format: 'esm', ... })` —
     *      esbuild accepts TLA + imports cleanly when emitting ESM.
     *      Output is JS-canonicalised: multi-line imports collapsed,
     *      bindings normalised, etc.
     *   2. Extract top-level imports from the pass-1 output and rewrite
     *      them as `const X = require(...)` shims (see
     *      `convertEsmImportsToRequire` for the contract / shape).
     *   3. Wrap the remaining body in a returned async IIFE.
     *   4. Return the assembled string as the transform result.
     *
     * The require-shim emits the standard `__esModule` interop check
     * (matches what esbuild itself emits for ESM→CJS conversions), so
     * default-export binding semantics are preserved.
     *
     * If TLA but no ESM imports → existing single-pass IIFE wrap.
     * If ESM imports but no TLA → existing single-pass esbuild
     * format:cjs (it auto-converts ESM→CJS gracefully).
     *
     * This is bytes-stable for sources outside the TLA+ESM-imports
     * intersection.
     */
    transform(code: string, options?: {
        loader?: 'ts' | 'tsx' | 'jsx' | 'js' | 'css' | 'json';
        format?: 'esm' | 'cjs' | 'iife';
        target?: string;
        sourcemap?: boolean | 'inline' | 'external';
        minify?: boolean;
        jsx?: 'transform' | 'preserve' | 'automatic';
        jsxFactory?: string;
        jsxFragment?: string;
        tsconfigRaw?: string;
        define?: Record<string, string>;
    }): Promise<TransformResult>;
    /**
     * Bundle entry points from the VFS.
     */
    build(entryPoints: string[], options?: {
        bundle?: boolean;
        format?: 'esm' | 'cjs' | 'iife';
        target?: string;
        platform?: 'browser' | 'node' | 'neutral';
        outdir?: string;
        outfile?: string;
        sourcemap?: boolean | 'inline' | 'external';
        minify?: boolean;
        external?: string[];
        define?: Record<string, string>;
        globalName?: string;
        tsconfigRaw?: string;
        alias?: Record<string, string>;
        keepNames?: boolean;
    }): Promise<BuildResult>;
    /**
     * VFS resolver plugin for esbuild.
     * Reads directly from the SqliteVFS (synchronous, co-located — no snapshot needed).
     * Handles: absolute paths, relative paths, bare specifiers (node_modules).
     */
    private makeVfsPlugin;
    get isInitialized(): boolean;
}
//# sourceMappingURL=esbuild-service.d.ts.map