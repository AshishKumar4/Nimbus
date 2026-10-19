import type { ProcessView } from '../../../runtime/process-files.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { WordPart } from './types.js';
import { type ExpandContext } from './expander.js';
/**
 * What a test asks of the running command: the directory a relative path
 * operand is resolved against, and whether an fd is a terminal (-t). The
 * shell's builtin and the registry's `test`, run by name, both answer it.
 */
export interface TestContext {
    readonly cwd: string;
    isFdTerminal?(fd: number): boolean;
    /** `[[ =~ ]]`'s match, its text and each group's, or [] when there is none: BASH_REMATCH. */
    setRematch?(values: readonly string[]): void;
}
/**
 * Implementation of the `test` / `[` shell builtin (POSIX `test`), and of
 * `test` and `[` run by name (`command test`, `env [`, xargs).
 * `bracket` is true for `[`, whose last argument must be `]`.
 */
export declare function evaluateTest(args: string[], vfs: ProcessView, stderr: CommandOutputStream, context?: TestContext, bracket?: boolean): Promise<number>;
/**
 * `[[ ... ]]`, whose operands are expanded only when the expression actually
 * reaches them: `[[ $# = 2 && $2 = x ]]` must not touch `$2` under `set -u`.
 */
export declare function evaluateDoubleBracketWords(words: WordPart[][], expandCtx: ExpandContext, vfs: ProcessView, stderr: CommandOutputStream, context?: TestContext): Promise<number>;
//# sourceMappingURL=test-builtin.d.ts.map