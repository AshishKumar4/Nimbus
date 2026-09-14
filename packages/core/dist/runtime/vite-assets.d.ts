/**
 * vite-assets.ts — Vite's asset import semantics, expressed as esbuild
 * loaders, for the built-in (`cirrus`) `vite build` path.
 *
 * Kept free of any esbuild/VFS imports so unit tests can exercise the map
 * without the wasm shim: the esbuild-service plugin consumes these pure
 * helpers, and the `vite` builtin in session/init.ts consumes the config
 * side via vite-config-parser.
 *
 * What Vite does that this models (see vite/src/node/plugins/asset.ts):
 *
 *   import url from './logo.svg'     → emitted file, default export is its URL
 *   import url from './logo.svg?url' → same, on any extension
 *   import txt from './data.txt?raw' → default export is the file's UTF-8 text
 *   import d   from './logo.svg?inline' → default export is a data: URL
 *
 * `?inline` on a `.css` file returns the stylesheet TEXT in real Vite (the
 * feature exists to inline CSS into JS), so that case maps to `text` rather
 * than `dataurl`.
 *
 * Deliberate divergence: real Vite inlines assets below `assetsInlineLimit`
 * (4 KiB) as data URLs instead of emitting files. The built-in build always
 * emits a hashed file — same observable contract (a URL string), simpler
 * output. Unknown `?` modifiers (`?worker`, `?sharedworker`, `?init`, …)
 * are rejected loudly by the caller instead of being silently dropped.
 */
/** Extensions Vite treats as static assets — imported JS receives a URL. */
export declare const VITE_FILE_LOADER_EXTS: Record<string, true>;
/** Import `?` modifiers the built-in build understands. */
export declare const VITE_ASSET_QUERY_SUFFIXES: Record<string, true>;
export type ViteAssetLoaderKind = 'file' | 'text' | 'dataurl' | 'base64';
/** Split `path` at its first `?` — returns `[bare, query]` (query may be ''). */
export declare function splitImportQuery(path: string): [string, string];
/**
 * esbuild loader for an imported file under Vite asset semantics, or
 * `undefined` when the path is not an asset and the caller's normal
 * extension→loader inference should apply.
 *
 * Keys on the EXTENSION and the `?` modifier only — never on file content.
 * The G4 bug was a `.svg` reaching the JS loader and being read as JSX; an
 * extension-keyed map cannot produce that failure.
 */
export declare function viteAssetLoader(path: string): ViteAssetLoaderKind | undefined;
//# sourceMappingURL=vite-assets.d.ts.map