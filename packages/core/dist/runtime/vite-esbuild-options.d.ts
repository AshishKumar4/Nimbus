/**
 * vite-esbuild-options.ts — what Vite's esbuild plugin (`vite:esbuild`, the
 * same in Vite 5.4, 6.4 and 7.3: `esbuildPlugin` and `transformWithEsbuild`
 * in vite/dist/node) passes esbuild for a module in `vite` (serve mode), for
 * the built-in Vite dev server to pass its transform:
 *
 * - `config.esbuild` as Vite 7.3's resolveConfig makes it: vite.config's
 *   `esbuild`, then what the project's plugins' config hooks merge into it
 *   (@vitejs/plugin-react, @preact/preset-vite), over `jsxDev: true`,
 *   `charset: 'utf8'` and `legalComments: 'none'`; `esbuild: false` turns
 *   the plugin off. (Vite 5.4 and 6.4 set charset in the plugin and leave
 *   legal comments in: neither changes what a module does.)
 * - the plugin's options: `target: 'esnext'`, the config's options over
 *   it, no minification, `keepNames` and `treeShaking` off, `supported`
 *   with `import()` and `import.meta` kept; `jsxInject`, `include` and
 *   `exclude` are its own.
 * - per module, its tsconfig's eleven meaningful compiler options (a .ts or
 *   .tsx module only; found and read by tsconfck, runtime/tsconfck.ts), the
 *   config's `tsconfigRaw.compilerOptions` over them, `useDefineForClassFields`
 *   false where neither sets it nor `target`, and the tsconfig's JSX options
 *   dropped where the options set their own.
 *
 * Recorded against real Vite 7.3.6 (and 6.4.3 and 5.4.21 beside it) in
 * tests/fixtures/vite-esbuild-reference.json.
 */
import type { ParsedViteConfig } from './vite-config-parser.js';
/** The compiler options a tsconfig gives esbuild through Vite: what changes a module's output. */
export declare const MEANINGFUL_TSCONFIG_FIELDS: readonly ["alwaysStrict", "experimentalDecorators", "importsNotUsedAsValues", "jsx", "jsxFactory", "jsxFragmentFactory", "jsxImportSource", "preserveValueImports", "target", "useDefineForClassFields", "verbatimModuleSyntax"];
/** What Vite keeps supported whatever the target: `import()` and `import.meta` stay as written. */
export declare const DEFAULT_ESBUILD_SUPPORTED: Readonly<Record<string, boolean>>;
/** What the dev server knows of a project's vite.config for the esbuild plugin. */
export interface ViteEsbuildSettings {
    /** `config.esbuild` as resolveConfig makes it in serve mode, or false (the plugin off). */
    esbuild: Readonly<Record<string, unknown>> | false;
    /** Whether a vite.config was read: without one the dev server keeps its own JSX defaults (vite-dev-server.ts). */
    hasConfig: boolean;
    /** What was left out, each said once: values vite.config computes, settings a plugin makes that are not esbuild's. */
    unread: string[];
}
/** Whether `value` is ViteEsbuildSettings, as a session kept it across hibernation. */
export declare function isViteEsbuildSettings(value: unknown): value is ViteEsbuildSettings;
/**
 * `config.esbuild` as Vite 7's resolveConfig makes it for `vite` from a
 * vite.config read statically: its `esbuild`, then each known plugin's
 * contribution merged over it in the order Vite runs their config hooks
 * (all of these are `enforce: 'pre'`, so in the order listed), over Vite's
 * defaults (jsxDev, charset, legalComments). `config` null: no vite.config.
 */
export declare function viteEsbuildSettings(config: ParsedViteConfig | null): ViteEsbuildSettings;
/** The esbuild plugin's transform options, from `config.esbuild` (esbuildPlugin). */
export declare function viteEsbuildPluginOptions(esbuild: Readonly<Record<string, unknown>>): Record<string, unknown>;
/** Whether the esbuild plugin transforms `id` with its default include and exclude. */
export declare function viteEsbuildTransforms(id: string): boolean;
/** The loader Vite gives `filename`: by extension, .mjs and .cjs as js, .mts and .cts as ts. */
export declare function viteLoader(filename: string): string;
/**
 * The options transformWithEsbuild gives esbuild for `filename`: the
 * plugin's `options`, its loader, and a tsconfigRaw made of `tsconfig`'s
 * meaningful compiler options (read only for a ts or tsx loader) under the
 * options' own `tsconfigRaw`, as Vite makes it.
 */
export declare function viteTransformOptions(filename: string, options: Readonly<Record<string, unknown>>, tsconfigCompilerOptions: Readonly<Record<string, unknown>> | undefined): Record<string, unknown>;
/** `code` with `jsxInject` before it, for a .jsx or .tsx module, as the plugin puts it. */
export declare function withJsxInject(code: string, id: string, jsxInject: unknown): string;
//# sourceMappingURL=vite-esbuild-options.d.ts.map