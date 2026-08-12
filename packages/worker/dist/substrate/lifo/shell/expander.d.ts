import type { WordPart } from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { ShellOptions } from './interpreter.js';
export interface ExpandContext {
    env: Record<string, string>;
    positionals?: readonly string[];
    lastExitCode: number;
    cwd: string;
    vfs: VFS;
    options: ShellOptions;
    executeCapture?: (input: string) => Promise<string>;
}
/**
 * A parameter expansion that aborts the command it belongs to: `set -u` on an
 * unset parameter, or an explicit `${var:?message}`.
 */
export declare class ExpansionError extends Error {
}
/**
 * Expand all words for a command's arguments: brace expansion, tilde,
 * parameter/arithmetic/command substitution, IFS field splitting, globbing.
 */
export declare function expandWords(words: WordPart[][], ctx: ExpandContext): Promise<string[]>;
/**
 * Expand a single word (e.g., for redirect targets and assignments).
 * No field splitting and no glob expansion.
 */
export declare function expandWord(parts: WordPart[], ctx: ExpandContext): Promise<string>;
//# sourceMappingURL=expander.d.ts.map