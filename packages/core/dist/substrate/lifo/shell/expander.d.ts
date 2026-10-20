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
    /** Write `diagnostic` where the shell reports an error met expanding: its stderr then (bash writes before it discards). */
    report(diagnostic: string): Promise<void>;
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
 * An arithmetic error (a constant past its base, a base out of range, a
 * variable whose value refers to itself without end): as bash's evalerror
 * words it, the expression to the end of the token in error, then why, then
 * the token. Met expanding, it is reported and the line discarded
 * (arithmeticValue); in `[[ ]]` it makes its comparison false.
 */
export declare class ArithmeticError extends Error {
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
/** A subscript's text once its expansions (`$i`, `$(…)`) are done, before its arithmetic. */
export declare function expandSubscript(subscript: string, ctx: ExpandContext): Promise<string>;
/** An expanded word's arithmetic (a subscript's, a `[[ -eq ]]` operand's): a blank one is 0. Throws ArithmeticError. */
export declare function arithmeticOf(expanded: string, ctx: ExpandContext): number;
/** arithmeticOf as an expansion meets it: an error is reported, and the rest of the line discarded (bash's evalerror). */
export declare function arithmeticValue(expanded: string, ctx: ExpandContext): Promise<number>;
//# sourceMappingURL=expander.d.ts.map