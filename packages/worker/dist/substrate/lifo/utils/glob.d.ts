import type { VFS } from '../kernel/vfs/index.js';
/**
 * Match a glob pattern against a text string.
 * Supports: * ? [abc] [!abc] [a-z]
 */
export declare function globMatch(pattern: string, text: string): boolean;
/**
 * Expand a glob pattern against the VFS.
 * Returns sorted matching paths, or [pattern] if no matches.
 */
export declare function expandGlob(pattern: string, cwd: string, vfs: VFS): string[];
//# sourceMappingURL=glob.d.ts.map