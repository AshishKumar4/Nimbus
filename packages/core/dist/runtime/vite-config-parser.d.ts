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
/**
 * Plugin names from a parsed config that the built-in server cannot run —
 * every entry except the built-in React plugins. Framework scaffolds
 * (SvelteKit → `@sveltejs/kit/vite`, Vue → `@vitejs/plugin-vue`, Solid,
 * Astro) land here, as do inline/unresolved plugin expressions: the
 * built-in path evaluates no plugin at all.
 */
export declare function unsupportedVitePlugins(config: ParsedViteConfig): string[];
//# sourceMappingURL=vite-config-parser.d.ts.map