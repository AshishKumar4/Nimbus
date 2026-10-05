/**
 * vite-config-file.ts — a project's vite.config as the built-in Vite dev
 * server reads it: the first of VITE_CONFIG_NAMES in a directory, scraped
 * statically (core runtime/vite-config-parser.ts), never evaluated. `vite`
 * reads it at start (session/vite-command.ts); the dev server reads it again
 * when it changes, as Vite restarts on an edit of its config.
 */
import { type ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';
/** The names a vite.config is looked for under, in order. */
export declare const VITE_CONFIG_NAMES: readonly ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
/** What a vite.config is read through: a project's view, or the dev server's own. */
export interface ViteConfigReadFs {
    exists(path: string): boolean | Promise<boolean>;
    readFileString(path: string): string | Promise<string>;
}
export interface ViteConfigFile {
    /** The file read (`<dir>/<name>`), or null where `dir` has none. */
    path: string | null;
    config: ParsedViteConfig;
    /** Why the file found could not be read; its config is then empty. */
    error: string | null;
}
/**
 * The vite.config in `dir`. A .ts config needs `eraseTypes` only when it
 * holds type syntax (parseViteConfigTypeScript); a plain one is read as is.
 */
export declare function readViteConfigFile(fs: ViteConfigReadFs, dir: string, eraseTypes: (source: string) => Promise<string>): Promise<ViteConfigFile>;
/** Whether `path` (a VFS path, with or without its leading slash) names a vite.config in `dir`. */
export declare function isViteConfigPath(path: string, dir: string): boolean;
//# sourceMappingURL=vite-config-file.d.ts.map