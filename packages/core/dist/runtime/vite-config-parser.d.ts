export interface ParsedViteConfig {
    root?: string;
    base?: string;
    outDir?: string;
    port?: number;
    injectBasename?: boolean;
    alias?: Record<string, string>;
    define?: Record<string, string>;
    devServer?: 'real' | 'real-vite' | 'cirrus' | 'shim' | 'auto' | string;
    importsVitePlugin?: boolean;
    /**
     * Specifiers behind every `plugins: [...]` entry, where resolvable —
     * e.g. `@sveltejs/kit/vite` for `plugins: [sveltekit()]` when
     * `sveltekit` was imported from it. Unresolvable entries contribute a
     * descriptive placeholder (`inline plugin 'x'`, local identifier name,
     * '(unresolved plugin expression)') so the list never under-reports:
     * a non-empty array always means "this config runs plugins".
     */
    plugins?: string[];
    /**
     * `esbuild`, as far as it is literal: false (Vite's esbuild plugin off),
     * or its statically readable values. Read for the dev server's transform
     * (vite-esbuild-options.ts).
     */
    esbuild?: Record<string, unknown> | false;
    /** The names under `esbuild` whose values are computed, left out of it (`esbuild` itself where it is). */
    esbuildComputed?: string[];
    /**
     * Each `plugins` entry that calls an imported factory: its import's
     * specifier, the statically readable values of its first argument, and the
     * names of those computed (left out).
     */
    pluginCalls?: Array<{
        specifier: string;
        options: Record<string, unknown>;
        computed: string[];
    }>;
}
/**
 * Read a `vite.config.ts` without a TypeScript transform where the transform
 * cannot change what this reader sees.
 *
 * On a fresh session the transform is the session's first: it starts the
 * transform facet (fetching and compiling its wasm), and `vite` waits on it
 * before it serves anything. Most
 * configs, the seeded one included, are plain JavaScript under a `.ts` name.
 *
 * The direct read is taken only for a source that parses as a JavaScript
 * module built solely from PASS_THROUGH_NODES: syntax esbuild's `ts` transform
 * leaves as it is. That rules out, by construction, the two ways a source can
 * mean something else to esbuild. Type syntax: annotations, casts and enums do
 * not parse as JavaScript, and a generic call such as `f<T>(x)` or
 * `f<A<B>>(x)` parses only as comparisons or shifts, which are not on the
 * list. And rewriting: esbuild folds constants (`'a' + 'b'`, `!0`,
 * `+"5173"`, `null || x`, `false && f()`, conditionals, templates with
 * substitutions), all of them operators that are not on the list either.
 * TypeScript (and esbuild) also drop an import none of whose bindings is
 * used, which changes `importsVitePlugin` and so the dev-server choice, so a
 * source with such an import, or one that declares a name an import binds,
 * goes through esbuild too. Anything else calls `eraseTypes`.
 */
export declare function parseViteConfigTypeScript(source: string, eraseTypes: (source: string) => Promise<string>): Promise<ParsedViteConfig>;
export declare function parseViteConfigSource(source: string): ParsedViteConfig;
/** Plugins a parsed config declares that the built-in build must refuse:
 *  the framework denylist only — everything else gets a warning and tries. */
export declare function viteBuildBlockingPlugins(config: ParsedViteConfig): string[];
/** Plugins a parsed config declares that the built-in server does not
 *  evaluate but that are not known-handled — the dev/build warning list. */
export declare function unhandledVitePlugins(config: ParsedViteConfig): string[];
//# sourceMappingURL=vite-config-parser.d.ts.map