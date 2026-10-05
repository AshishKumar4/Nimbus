/**
 * prebundle-slice.ts — one npm specifier bundled to one browser ES module
 * from a slice of its package files, by any engine with esbuild's build
 * contract (EsbuildBuildHost's shape: esbuild options and a resolve/load
 * plugin). The build facet runs it on rolldown (rolldown-build.ts).
 *
 * The supervisor walks the specifier's transitive, non-external package
 * files once and ships them with the spec (worker npm/pre-bundle-facet.ts,
 * buildSliceForSpecifierWithCap): every resolve and load is answered from
 * that slice, so a pre-bundle makes no call back to the supervisor. Bare
 * specifiers resolve by Node's rules (package.json `exports` with
 * `require` or `import` conditions by the import's kind, `imports` for
 * `#name`, `module`/`main` otherwise); the shared runtime externals
 * (React and its kin) and anything the slice cannot answer stay external,
 * the latter with a warning.
 *
 * Self-contained but for the exports resolver: the build facet's runtime
 * bundles it (scripts/rolldown-facet/entry.mjs).
 */
import type { EsbuildBuildOutcome, EsbuildHostBuildOptions, EsbuildRemotePlugin } from './esbuild-service.js';
/**
 * One file inside a spec's slice: raw bytes, which a binary module keeps
 * whole and source code decodes losslessly.
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
/**
 * What a Vite dev server's modules read of their environment, as Vite's dev
 * values: `process.env.NODE_ENV` so React's CommonJS (and every other
 * package's `NODE_ENV` guard) takes its development branch, and `global` for
 * packages written for Node. `import.meta.env.BASE_URL` is per mount, so not
 * here.
 */
export declare const VITE_DEV_DEFINE: Readonly<Record<string, string>>;
/**
 * Every pre-bundle's define, the installer's and the Vite dev server's
 * alike, so either's row is the other's: Vite's dev values, base-neutral
 * (`BASE_URL` is `/`; a bundle is persisted once and served under every
 * mount). A project's vite.config `define` is not in it, as Vite's
 * dependency optimizer applies none of it either.
 */
export declare const PREBUNDLE_DEFINE: Readonly<Record<string, string>>;
/** A pre-bundle's build options, but its entry: what its output is a function of, beside its slice and externals. */
export declare function prebundleBuildOptions(define: Readonly<Record<string, string>> | undefined): {
    bundle: boolean;
    format: "esm";
    target: string;
    platform: "browser";
    conditions: string[];
    mainFields: string[];
    define: {
        [x: string]: string;
    } | undefined;
};
/** The files a slice holds: everything a bundle built from it can have read. */
export declare function sliceSources(slice: readonly SliceEntry[]): string[];
/** What the supervisor sends per pre-bundle. */
export interface PrebundleSpec {
    /** Bare specifier being bundled, e.g. "framer-motion" or "react/jsx-runtime". */
    specifier: string;
    /** VFS path of the entry point, e.g. "/home/user/example-app/node_modules/framer-motion/dist/es/index.mjs". */
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
    /** Stamp written into pkg_esm_bundles.bundle_hash (worker npm/cache-keys.ts). */
    bundlerVersion: string;
    /** The `define` map: PREBUNDLE_DEFINE, from the installer and the Vite dev server alike. */
    define?: Readonly<Record<string, string>>;
}
/** What a pre-bundle returns. */
export interface PrebundleResult {
    specifier: string;
    ok: boolean;
    /** ESM bundle output as a UTF-8 string. Empty when ok=false. */
    esmCode: string;
    /** First error message; populated when ok=false. */
    errorText?: string;
    /** Wall-clock ms of the pre-bundle (bundling only, excludes the RPC roundtrip). */
    elapsed: number;
    /** Non-fatal warnings the supervisor should surface. */
    warnings: string[];
}
/** One build with esbuild's contract: options and a resolve/load plugin. */
export type PrebundleBuild = (options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin) => Promise<EsbuildBuildOutcome>;
/** Bundle `spec.specifier` from its slice with `build`. Never throws: a failure is a result. */
export declare function prebundleSlice(spec: PrebundleSpec, build: PrebundleBuild): Promise<PrebundleResult>;
//# sourceMappingURL=prebundle-slice.d.ts.map