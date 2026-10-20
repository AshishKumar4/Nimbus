import type { WordPart } from './types.js';
import type { ProcessView } from '../../../runtime/process-files.js';
import type { ShellOptions } from './state.js';
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
    vfs: ProcessView;
    options: ShellOptions;
    executeCapture?: (input: string) => Promise<CapturedCommand>;
    /**
     * Exit status of the most recent command substitution expanded through this
     * context, or undefined when there was none. A command made up only of
     * assignments — `out="$(cmd)"` — takes its own status from here, which is
     * what makes `out="$(cmd)" || die` and `set -e` see a failing `cmd`.
     */
    lastSubstitutionExitCode?: number;
    /**
     * Expanding a here-document's body, where `'` and `$'...'` are literal
     * text, inside a parameter's `-`, `+`, `=` and `?` words too.
     */
    hereDocument?: boolean;
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
 * A pattern word (a case pattern, `[[ ]]`'s right-hand side) expanded, as its
 * value and as the pattern globMatch reads: each character that came from
 * quotes, a quoted part or a quoted expansion, escaped so it matches only
 * itself, and an unquoted expansion's characters left as pattern characters.
 */
export declare function expandPatternWord(parts: WordPart[], ctx: ExpandContext): Promise<{
    value: string;
    pattern: string;
}>;
/**
 * `[[ =~ ]]`'s regex word expanded: an extended regular expression in which
 * each quoted character a regular expression reads specially is escaped, so
 * it matches only itself, and an unquoted expansion's characters stay the
 * expression's (bash's quote_string_for_globbing, QGLOB_REGEXP).
 */
export declare function expandRegexWord(parts: WordPart[], ctx: ExpandContext): Promise<string>;
/**
 * Expand a single word (e.g., for redirect targets and assignments).
 * No field splitting and no glob expansion.
 */
export declare function expandWord(parts: WordPart[], ctx: ExpandContext): Promise<string>;
/** A subscript is an arithmetic expression; a negative index counts from the end. */
export declare function evaluateSubscript(subscript: string, length: number, ctx: ExpandContext): Promise<number>;
/** A subscript's text once its expansions (`$i`, `$(…)`) are done, before its arithmetic. */
export declare function expandSubscript(subscript: string, ctx: ExpandContext): Promise<string>;
/** An expanded subscript's arithmetic, a blank one 0. */
export declare function subscriptArithmetic(expanded: string, ctx: ExpandContext): number;
//# sourceMappingURL=expander.d.ts.map