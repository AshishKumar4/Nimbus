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
}
export declare function parseViteConfigSource(source: string): ParsedViteConfig;
//# sourceMappingURL=vite-config-parser.d.ts.map