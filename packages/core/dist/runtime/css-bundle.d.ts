/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet,
 * by esbuild 0.24's rules (what the built-in `vite build` shipped before).
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands a chunk's CSS modules here
 * in the order the chunk's JavaScript imports them. Each sheet is read
 * through css-syntax.ts (css-tree), and the graph and cascade policy is
 * esbuild's linker, ported (internal/linker/linker.go at v0.24.2):
 *
 *   - Every sheet is resolved, loaded and parsed once per build, however
 *     often it is imported (each resolve and load is a call back to the
 *     session that owns the files).
 *   - The import order is esbuild's findImportedFilesInCSSOrder: depth-first,
 *     every `@import` evaluated each time it appears, a sheet already on the
 *     import stack skipped (a cycle); each import's conditions wrap all it
 *     imports. Layer names a sheet orders before its first `@import` come
 *     first; external imports (`http:`, `https:`, `//`, or resolved external)
 *     are hoisted to the top, keeping their importers' conditions (nested
 *     through `data:` stylesheet imports where one `@import` cannot carry them).
 *   - A sheet or external import that appears again later, under conditions
 *     that apply wherever the earlier ones did (isConditionalImportRedundant),
 *     keeps only its last place; the earlier place keeps the layer order it
 *     set (`@layer a;`), and redundant layer statements are dropped and
 *     adjacent ones merged, as esbuild does.
 *   - A sheet's `url()`s are resolved and loaded through the build's plugin
 *     (kind `url-token`): a `file` loader makes an emitted asset, written as
 *     a path relative to the stylesheet, a `dataurl` loader a data URL; any
 *     other loader cannot be a URL. `data:`, `http(s):`, `//` and `#` URLs
 *     are left alone. `@import` paths resolve with kind `import-rule`, and
 *     what they load must be CSS.
 *   - `@charset` becomes one `@charset "UTF-8";` first; legal comments move
 *     to the end, once each.
 *
 * Minifying prints rules as css-tree's generator does (no comments, no
 * whitespace a rule does not need); it does not rewrite values, so a sheet
 * is larger than esbuild's, never different in meaning.
 */
import type * as esbuild from 'esbuild-wasm';
import type { EsbuildRemotePlugin } from './esbuild-service.js';
export interface CssModule {
    /** The module's namespace and path, as the plugin resolved it. */
    namespace: string;
    path: string;
    /** Where its relative imports resolve from. */
    resolveDir: string;
    source: string;
}
/** What turns a `url()`'s module into a URL: emitted file names, data URLs. */
export interface CssAssets {
    /** Emit a `file`-loaded module; its URL relative to the stylesheet. */
    emit(module: {
        namespace: string;
        path: string;
    }, bytes: Uint8Array): Promise<string>;
    /** A data URL of a `dataurl`-loaded module. */
    dataUrl(path: string, bytes: Uint8Array): string;
}
export declare class CssError extends Error {
    readonly diagnostic: esbuild.Message;
    constructor(diagnostic: esbuild.Message);
}
/** A bundled stylesheet, and what esbuild would have warned about its sheets. */
export interface BundledCss {
    css: string;
    warnings: esbuild.Message[];
}
export declare function bundleCss(modules: readonly CssModule[], plugin: EsbuildRemotePlugin, assets: CssAssets, { minify }: {
    minify: boolean;
}): Promise<BundledCss>;
/** esbuild's EncodeStringAsShortestDataURL. */
export declare function shortestDataUrl(mimeType: string, text: string): string;
/** esbuild's EncodeStringAsPercentEscapedDataURL, for text that came from valid UTF-8. */
export declare function percentEscapedDataUrl(mimeType: string, text: string): string;
//# sourceMappingURL=css-bundle.d.ts.map