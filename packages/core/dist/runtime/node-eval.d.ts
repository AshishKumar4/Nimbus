/**
 * The code `node -e` and `node -p` run, as Node prepares it
 * (lib/internal/main/eval_string.js and eval_stdin.js, v22.22.3), for a
 * process that runs it as its entry module's body.
 *
 * `-p` prints the code's completion value: the value a script evaluates to,
 * which Node gets by running the code as a script (vm runInThisContext) and
 * prints with console.log when the process exits. An entry module's body
 * has no completion value, so the code is rewritten to hand it back: every
 * statement V8 would make the script's value assigns it to a variable
 * first, and the body returns that variable. Which statements those are is
 * V8's own rewrite, ported (src/parsing/rewriter.cc Processor): walking each
 * statement list backwards, the last value-producing statement assigns; a
 * statement that may complete without a value of its own (an `if` with no
 * value in one branch, a loop, a switch, a try) assigns `undefined` first;
 * past a `break` or `continue` the statements before it count again; and a
 * `finally` keeps the value it was entered with unless it breaks.
 *
 * Code Node runs as a module (`--input-type=module`, or its syntax: the
 * caller's mode, module-format.ts isEsModuleInput) is not a script:
 * Node refuses to print it (ERR_EVAL_ESM_CANNOT_PRINT), which the code
 * becomes. Nor is code with a `return` at its top, which Node refuses to
 * compile.
 */
/**
 * How Node evaluates eval code (eval_string.js, eval_stdin.js): as a module
 * (`--input-type=module`, or its syntax), as `--input-type=commonjs`'s
 * script (evalScript: compiled as it runs, after `--import`'s modules load),
 * or by default (evalTypeScript: compiled first, before they load).
 */
export type NodeEvalMode = 'module' | 'commonjs' | 'default';
/** The code an eval runs, and when Node refuses it. */
export interface NodeEvalProgram {
    code: string;
    /**
     * Node refuses the code before `--import`'s modules load, after `-r`'s
     * have run: `-p` of a module (evalModuleEntryPoint throws first), and, by
     * default, a syntax error (evalTypeScript compiles before run_main.js
     * imports them; `--input-type=commonjs` compiles after). Known for `-p`'s
     * code, which is parsed here; `-e`'s is not.
     */
    refusedBeforeImports: boolean;
}
/**
 * The entry code for `node -e <code>`, or `-p`: with `print`, a body that
 * returns the code's completion value. Node keeps the identifier `crypto`
 * its node:crypto module in eval code, for backward compatibility, by
 * wrapping code that names it (eval_string.js: the same test, the same
 * wrappers).
 */
export declare function nodeEvalProgram(code: string, print: boolean, mode: NodeEvalMode): NodeEvalProgram;
/** The entry code for `node -p` reading its code from stdin (eval_stdin.js: no `crypto` wrapper). */
export declare function nodeStdinPrintProgram(source: string, mode: NodeEvalMode): NodeEvalProgram;
//# sourceMappingURL=node-eval.d.ts.map