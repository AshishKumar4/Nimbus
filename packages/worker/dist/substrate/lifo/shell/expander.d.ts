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
 * Expand all words for a command's arguments.
 * Handles variable expansion, tilde expansion, glob expansion, and command substitution.
 */
export declare function expandWords(words: WordPart[][], ctx: ExpandContext): Promise<string[]>;
/**
 * Expand a single word (e.g., for redirect targets).
 * No glob expansion.
 */
export declare function expandWord(parts: WordPart[], ctx: ExpandContext): Promise<string>;
//# sourceMappingURL=expander.d.ts.map