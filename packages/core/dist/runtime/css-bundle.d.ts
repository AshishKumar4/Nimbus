/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet,
 * by esbuild 0.24's rules (what the built-in `vite build` shipped before).
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands a chunk's CSS modules here in
 * the order the chunk's JavaScript first imports them. From there:
 *
 *   - Each file's `@import`s are inlined before it, recursively. A file
 *     imported more than once (by `@import`, or by JavaScript and `@import`)
 *     keeps its LAST place, as the cascade does, and a later import with
 *     fewer conditions makes an earlier conditional one redundant
 *     (esbuild's isConditionalImportRedundant). Each import's conditions wrap
 *     its rules, one level per import: `@media`, then `@supports`, then
 *     `@layer`, innermost import innermost.
 *   - An `@import` of a URL (`http:`, `https:`, `//`) stays an `@import`,
 *     hoisted to the top with its conditions; `@charset` becomes one
 *     `@charset "UTF-8";` first.
 *   - Every `url()` naming a file is resolved and loaded through the build's
 *     plugin (kind `url-token`); a `file` loader makes it an emitted asset,
 *     written as a path relative to the stylesheet, a `dataurl` loader a
 *     data URL; any other loader cannot be a URL, as in esbuild. `data:`,
 *     `http(s):`, `//` and `#` URLs are left alone.
 *   - `@import` paths resolve with kind `import-rule`. Paths go to the plugin
 *     as written: a bare `url(img/x.png)` is a package path there, as it was
 *     to esbuild under Nimbus's plugin.
 *
 * Legal comments (`/*!`, or naming `@license` or `@preserve`) move to the end
 * of the sheet, once each, as esbuild's `legalComments: 'eof'` does.
 *
 * Minifying removes the other comments and the whitespace
 * and last semicolons a stylesheet does not need; it does not rewrite values,
 * so a minified sheet is larger than esbuild's, never different in meaning.
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
export declare function bundleCss(modules: readonly CssModule[], plugin: EsbuildRemotePlugin, assets: CssAssets, { minify }: {
    minify: boolean;
}): Promise<string>;
/** CSS without comments, and without whitespace or last semicolons it does not need. */
export declare function minifyCss(css: string): string;
//# sourceMappingURL=css-bundle.d.ts.map