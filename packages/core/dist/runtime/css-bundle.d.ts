/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet.
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands the chunk's CSS modules here,
 * in the chunk's module order (the order its imports run), to be joined as
 * esbuild joined them into the chunk's `.css` sidecar.
 *
 * A stylesheet that needs more than joining (`@import`, `url()`, minifying)
 * is refused by name until those are implemented to esbuild's rules: a
 * stylesheet that differs silently from the one esbuild produced is worse
 * than a loud error.
 */
import type { EsbuildRemotePlugin } from './esbuild-service.js';
export interface CssModule {
    /** The module's id in the build. */
    id: string;
    /** Its path, as the plugin resolved it. */
    path: string;
    source: string;
}
export declare function bundleCss(modules: readonly CssModule[], _plugin: EsbuildRemotePlugin, { minify }: {
    minify: boolean;
}): Promise<string>;
//# sourceMappingURL=css-bundle.d.ts.map