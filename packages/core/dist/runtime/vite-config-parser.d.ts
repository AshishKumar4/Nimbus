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
}
export declare function parseViteConfigSource(source: string): ParsedViteConfig;
/** Plugins a parsed config declares that the built-in build must refuse:
 *  the framework denylist only — everything else gets a warning and tries. */
export declare function viteBuildBlockingPlugins(config: ParsedViteConfig): string[];
/** Plugins a parsed config declares that the built-in server does not
 *  evaluate but that are not known-handled — the dev/build warning list. */
export declare function unhandledVitePlugins(config: ParsedViteConfig): string[];
//# sourceMappingURL=vite-config-parser.d.ts.map