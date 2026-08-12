import type { WordPart } from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { ShellOptions } from './interpreter.js';
export interface ExpandContext {
    env: Record<string, string>;
    /**
     * Indexed arrays, sparse: a hole is an index that was never assigned, which
     * `${arr[@]}` skips and `${!arr[@]}` omits. A name lives here or in `env`,
     * never both, so `$arr` and `${arr[0]}` have one answer.
     */
    arrays?: ReadonlyMap<string, readonly (string | undefined)[]>;
    positionals?: readonly string[];
    lastExitCode: number;
    cwd: string;
    vfs: VFS;
    options: ShellOptions;
    executeCapture?: (input: string) => Promise<CapturedCommand>;
    /**
     * Exit status of the most recent command substitution expanded through this
     * context, or undefined when there was none. A command made up only of
     * assignments — `out="$(cmd)"` — takes its own status from here, which is
     * what makes `out="$(cmd)" || die` and `set -e` see a failing `cmd`.
     */
    lastSubstitutionExitCode?: number;
}
export interface CapturedCommand {
    output: string;
    exitCode: number;
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
/** A subscript is an arithmetic expression; a negative index counts from the end. */
export declare function evaluateSubscript(subscript: string, length: number, ctx: ExpandContext): Promise<number>;
//# sourceMappingURL=expander.d.ts.map