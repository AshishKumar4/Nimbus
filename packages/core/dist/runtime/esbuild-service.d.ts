/**
 * EsbuildService — TypeScript/JSX transform + bundling.
 *
 * A host whose isolate is memory-constrained passes a `transformHost` and a
 * `buildHost` so both run in another isolate: the session's transforms run in
 * its transform facet on Nimbus's Oxc build (oxc-transform.ts, which keeps
 * esbuild's transform contract), its builds in the esbuild facet. Without
 * them, esbuild-wasm runs both here; its linear memory starts at ~28 MiB,
 * grows to fit the working set and cannot shrink. build()'s VFS resolver
 * plugin always runs here, over this service's view.
 */
import type { Awaitable } from '../vfs/vfs.js';
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
 *   v12 — pre-bundles built by rolldown in the build facet
 *        (runtime/prebundle-slice.ts) instead of esbuild-wasm; v11 rows hold
 *        esbuild's output.
 */
export declare const BUNDLER_VERSION = "v12";
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
 * The runtime's function a bound record calls for its package: the one the
 * module system serves (node-shims.ts), named apart from the module's own
 * `require`, which an ES module does not have (module-format.ts).
 */
export declare const PROVIDED_PACKAGE_HOOK = "__nimbusProvidedPackage";
/** Bind canonical esbuild/Bun CommonJS records to the runtime's provided packages. */
export declare function rewriteProvidedCommonJsModules(source: string): string;
/**
 * A large ES module (bundle-cell-transform.ts BUNDLED_ESM_REWRITE_MIN_BYTES)
 * lowered to CommonJS in the session, without the transform host: read a
 * statement at a time (readEsmRecords, bounded memory, imports live) and
 * emitted by the one emitter. Null for what it leaves to the host: top-level
 * await (its body is synchronous), an import.meta member it does not bind, a
 * module acorn cannot parse, and a source with no module syntax.
 */
export declare function rewriteBundledEsmToCjs(source: string, absoluteUrl: string, moduleFactory?: boolean): TransformResult | null;
import type * as esbuild from 'esbuild-wasm/esm/browser.js';
/** What an in-isolate engine offers: esbuild's transform and build, ready to call. */
export type EsbuildEngine = Pick<typeof esbuild, 'transform' | 'build'>;
export interface EsbuildTransformOptions {
    loader?: 'ts' | 'tsx' | 'jsx' | 'js' | 'css' | 'json';
    format?: 'esm' | 'cjs' | 'iife';
    target?: string;
    sourcemap?: boolean | 'inline' | 'external';
    minify?: boolean;
    jsx?: 'transform' | 'preserve' | 'automatic';
    jsxFactory?: string;
    jsxFragment?: string;
    jsxImportSource?: string;
    jsxDev?: boolean;
    /** A tsconfig's text or object, read as esbuild 0.24 reads it (runtime/tsconfig-raw.ts). */
    tsconfigRaw?: string | esbuild.TsconfigRaw;
    define?: Record<string, string>;
    /**
     * esbuild's `supported`, over what the options below decide: Vite's dev
     * server keeps `import()` and `import.meta` as written (`{ 'dynamic-import':
     * true, 'import-meta': true }`), where an ES module transform otherwise
     * empties `import.meta` and makes `import()` a `require`.
     */
    supported?: Record<string, boolean>;
    /** The module's name in diagnostics, source maps and jsxDEV's `fileName`. */
    sourcefile?: string;
    /**
     * The URL of the module being transformed, when its dynamic `import()`
     * calls are the process's (dynamic-import-rewrite.ts): esbuild keeps them
     * as written and each becomes a call of the process's ESM loader with this
     * parent. Unset, esbuild lowers them to `require`.
     */
    dynamicImportParent?: string;
    /** Only the dynamic `import()` rewrite: the code is already CommonJS. */
    rewriteOnly?: boolean;
    /** Bind compiler-produced import.meta references to the wrapper module. */
    moduleMetadata?: boolean;
}
export interface TransformResult {
    code: string;
    map: string;
    warnings: {
        text: string;
        location?: esbuild.Location | null;
    }[];
}
/**
 * One emitted output. `bytes` is authoritative (UTF-8 fidelity for the
 * `file`-loader assets `viteAssets` emits); `contents` is the lazy decoded
 * view, memoized exactly like esbuild's own `OutputFile.text`.
 */
export interface BuildOutputFile {
    path: string;
    bytes: Uint8Array;
    readonly contents: string;
}
export interface BuildResult {
    outputFiles: BuildOutputFile[];
    /** esbuild's diagnostics, with their notes; never \`detail\` (serializableMessage). */
    errors: esbuild.Message[];
    warnings: esbuild.Message[];
    /** esbuild metafile — populated because build() always enables it so
     *  callers can identify entry-point outputs (`entryPoint`, `cssBundle`)
     *  instead of guessing from output ordering. */
    metafile?: esbuild.Metafile;
}
type EsbuildBuildApi = Pick<typeof esbuild, 'build'>;
/**
 * One esbuild build in which `plugin` resolves and loads every module: an
 * EsbuildService without a build host builds this way in its own isolate,
 * the esbuild facet so for a build whose rolldown binding died (serialized
 * into it: self-contained), and the build differentials use it as the
 * reference.
 */
export declare function buildWithEsbuild(esbuildApi: EsbuildBuildApi, options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<EsbuildBuildOutcome>;
/** Source the esbuild facet evaluates next to esbuild: its build helpers. */
export declare function generateEsbuildFacetRuntimeSource(): string;
/**
 * Source the transform facet evaluates next to its engine: one transform
 * request, run against anything with esbuild's `transform()` contract
 * (oxc-transform.ts's in the facet).
 */
export declare function generateTransformFacetRuntimeSource(): string;
/** One transform a {@link EsbuildTransformHost} runs. */
export interface EsbuildTransformRequest {
    code: string;
    options?: EsbuildTransformOptions;
}
/**
 * A host's answer for one request: the output, or why esbuild rejected the
 * module. A `transient` error is no verdict on the source: the host could not
 * run the transform this time.
 */
/**
 * A transform's answer. `transient` marks a failure that is no verdict on the
 * source (retry); `stackExhausted` one where the engine ran out of native
 * stack on the module's nesting, which another engine may still answer
 * (oxc-transform.ts's driver sets it from the RangeError it caught, never
 * from message text).
 */
export type EsbuildTransformOutcome = TransformResult | {
    error: string;
    transient?: true;
    stackExhausted?: true;
};
/**
 * Runs transforms in another isolate: one call per batch, outcomes positional.
 * A transform engine's wasm memory grows to the working set of the largest
 * module it transforms and is never released, so an isolate that is
 * memory-constrained (a session supervisor) hands its transforms to one of
 * these.
 */
export type EsbuildTransformHost = (requests: EsbuildTransformRequest[]) => Promise<EsbuildTransformOutcome[]>;
/** esbuild's arguments to a resolve callback, as data another isolate can carry. */
export interface EsbuildRemoteResolveArgs {
    path: string;
    importer: string;
    namespace: string;
    resolveDir: string;
    kind: esbuild.ImportKind;
    with: Record<string, string>;
}
/** esbuild's arguments to a load callback, as data another isolate can carry. */
export interface EsbuildRemoteLoadArgs {
    path: string;
    namespace: string;
    suffix: string;
    with: Record<string, string>;
}
/**
 * A plugin's resolve and load callbacks, answered where the plugin runs while
 * esbuild runs elsewhere. `null` leaves the module to esbuild.
 */
export interface EsbuildRemotePlugin {
    /** The plugin's own name, which esbuild's diagnostics cite. */
    name: string;
    resolve(args: EsbuildRemoteResolveArgs): Promise<esbuild.OnResolveResult | null>;
    load(args: EsbuildRemoteLoadArgs): Promise<esbuild.OnLoadResult | null>;
}
/** Build options another isolate can carry: no plugins, and nothing written to disk. */
export type EsbuildHostBuildOptions = Omit<esbuild.BuildOptions, 'plugins' | 'write'>;
/** What one build produced, as data another isolate can carry. */
export interface EsbuildBuildOutcome {
    outputFiles: Array<{
        path: string;
        contents: Uint8Array;
    }>;
    errors: BuildResult['errors'];
    warnings: BuildResult['warnings'];
    metafile?: esbuild.Metafile;
    /** esbuild's message for a build that failed: `errors` hold its diagnostics as data, which a thrown failure loses across RPC. */
    failure?: string;
}
/**
 * Runs a build in another isolate. Every module is resolved and loaded
 * through `plugin`, which stays with the caller and its filesystem view,
 * while the bundler's wasm memory, which grows with the module graph and is
 * never released, lives in the host.
 */
export type EsbuildBuildHost = (options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin) => Promise<EsbuildBuildOutcome>;
export interface EsbuildServiceOptions {
    /** Where transform() and transformMany() run. Absent: this isolate, on `engine`. */
    transformHost?: EsbuildTransformHost;
    /** Where build() runs. Absent: this isolate, on `engine`. */
    buildHost?: EsbuildBuildHost;
    /**
     * The engine a call without a host runs on in this isolate, loaded on the
     * first such call (a test's esbuild-wasm or Oxc, a tool's own). Absent:
     * such a call rejects.
     */
    engine?: () => Promise<EsbuildEngine>;
    /**
     * The transform host's code identity, given with the host: equal ids
     * transform equal requests to equal outcomes. It is what lets a launch keep
     * its results (bundle-cell-transform.ts): a store bound to one id never
     * serves another's. Absent: the host's results are not kept.
     */
    transformHostId?: string;
}
/** The workspace paths a build read, from its metafile (`build` always asks for one). */
export declare function vfsBuildInputs(metafile: esbuild.Metafile | undefined): string[];
/**
 * What a build reads modules through: a view of the namespace as some
 * credential, each call answered at once (the engine, a synchronous
 * NamespaceFs) or awaited (a command's ProcessView over a mount).
 */
export interface EsbuildReadFs {
    exists(path: string): Awaitable<boolean>;
    isDirectory(path: string): Awaitable<boolean>;
    readFile(path: string): Awaitable<Uint8Array>;
    readFileString(path: string): Awaitable<string>;
}
/**
 * Source bytes and files one transform host call carries. Bounds CPU work as
 * well as source retention per invocation: in live pi launch profiles the
 * 1 MiB/256-file slice beginning at export-html/index.js exceeded the guest
 * CPU budget even though its first 4 MiB rewrite-only chunk had completed.
 * Smaller independent calls preserve every input and result, while preventing
 * many small full transforms sharing one budget. It is also the unit a paced
 * launch spends its turns in, so no one turn waits on more than a slice.
 */
export declare const TRANSFORM_SLICE_SOURCE_BYTES: number;
export declare const TRANSFORM_SLICE_FILES = 32;
/**
 * `items` in order, cut into transform slices: each at most
 * TRANSFORM_SLICE_FILES items and TRANSFORM_SLICE_SOURCE_BYTES of source,
 * except that an item larger than the byte bound travels alone.
 */
export declare function transformSlices<T>(items: readonly T[], sourceBytes: (item: T) => number): T[][];
export declare class EsbuildService {
    private vfs;
    private readonly transformHost;
    private readonly buildHost;
    /** See EsbuildServiceOptions.transformHostId. */
    readonly transformHostId: string | null;
    private initialized;
    private initPromise;
    /** The in-isolate engine, populated by ensureInit() from `engine`. */
    private _esbuild;
    private readonly engine;
    /** Build reads use the caller-supplied view, or the one a build names; omit it for transform-only use. */
    constructor(vfs?: EsbuildReadFs, options?: EsbuildServiceOptions);
    /** Whether transforms run in this isolate (on its engine): true unless a transform host was given. */
    get transformsInIsolate(): boolean;
    /** Load the in-isolate engine (lazy, on the first call without a host). */
    private ensureInit;
    /**
     * Transform a single code string (TS→JS, JSX→JS, minify, etc.)
     *
     * Top-level await: esbuild emits no CommonJS for it, and a node cell is
     * CommonJS. Modern CLI entries use it (nuxi's `bin/nuxi.mjs`, serve 14's
     * `build/main.js`), so when esbuild rejects `format: 'cjs'` for that
     * reason, the module is emitted as ESM and lowered by lowerAsyncModule:
     * imports become requires above a returned async IIFE holding the rest,
     * exports become `module.exports` assignments. The runner awaits the
     * returned promise, so the awaits cannot race process teardown or VFS
     * flushes. Every other source takes esbuild's own CommonJS output.
     */
    transform(code: string, options?: EsbuildTransformOptions): Promise<TransformResult>;
    /** One transform on the in-isolate engine, of source the provided-module pre-pass has seen. */
    private transformInIsolate;
    /**
     * Transform many modules in one round trip to the transform host (or in
     * this isolate when there is none). Outcomes are positional, and a module
     * the provided-module pre-pass or esbuild rejects is an `{ error }` outcome
     * rather than a rejection, so one bad module never costs the others their
     * output.
     */
    transformMany(requests: readonly EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]>;
    /**
     * Bundle entry points from the VFS. The VFS plugin runs here over this
     * service's view either way; esbuild itself runs in the build host when
     * one was given.
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
        /** esbuild's JSX options; a tsconfigRaw's JSX settings apply over them, as in esbuild. */
        jsx?: 'transform' | 'preserve' | 'automatic';
        jsxFactory?: string;
        jsxFragment?: string;
        jsxImportSource?: string;
        jsxDev?: boolean;
        /** A tsconfig's text or object, read as esbuild 0.24 reads it (runtime/tsconfig-raw.ts). */
        tsconfigRaw?: string | esbuild.TsconfigRaw;
        alias?: Record<string, string>;
        keepNames?: boolean;
        entryNames?: string;
        chunkNames?: string;
        /** Output-name template for `file`-loader assets, e.g.
         *  'assets/[name]-[hash]'. Only consulted by the viteAssets path. */
        assetNames?: string;
        /**
         * Vite build semantics for imported assets: `import './x.png'`
         * yields a URL string for an emitted `[name]-[hash]` file, `?url`
         * does the same on any extension, `?raw` yields the file text,
         * `?inline` a data: URL, and `url()` references inside `.css`
         * modules emit + rewrite the same way (esbuild's `file` loader).
         * See runtime/vite-assets.ts. Off by default: non-Vite bundling
         * callers (one-shot node, pre-bundle) keep the generic loaders.
         */
        viteAssets?: boolean;
        /**
         * Absolute path of the project `public/` directory. With
         * `viteAssets`, absolute imports like `import '/favicon.svg'`
         * resolve here first and bundle to the literal public URL
         * (`export default "/favicon.svg"`), matching Vite's public-dir
         * semantics — the file is served verbatim, never emitted hashed.
         */
        vitePublicDir?: string;
        /** The view this build reads through, in place of the service's own (a command's, as its credential). */
        fs?: EsbuildReadFs;
    }): Promise<BuildResult>;
    private requireVfs;
    /**
     * VFS resolver plugin for esbuild.
     * Reads through the build's view, or the service's (a caller's credentialed
     * view, answered at once or awaited; no snapshot needed).
     * Handles: absolute paths, relative paths, bare specifiers (node_modules),
     * and — with `viteAssets` — Vite's asset/`?suffix` import semantics.
     */
    private makeVfsPlugin;
    get isInitialized(): boolean;
}
export {};
//# sourceMappingURL=esbuild-service.d.ts.map