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
import type { TypeScriptRefusal } from './typescript-refusal.js';
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
 * returns the code's completion value, its `crypto` node:crypto's
 * (evalScriptSource).
 */
export declare function nodeEvalProgram(code: string, print: boolean, mode: NodeEvalMode): NodeEvalProgram;
/** The entry code for `node -p` reading its code from stdin (eval_stdin.js: no `crypto` wrapper). */
export declare function nodeStdinPrintProgram(source: string, mode: NodeEvalMode): NodeEvalProgram;
/**
 * `-e` code as Node's CommonJS eval takes it (eval_string.js): Node keeps
 * the identifier `crypto` its node:crypto module in eval code, for backward
 * compatibility, by wrapping code that names it (the same test, the same
 * wrappers). Its ES module branches (`--input-type=module` and
 * `module-typescript`) take the code as it is.
 */
export declare function evalScriptSource(code: string, print: boolean): string;
/**
 * The entry code for eval code as Node's eval has it (evalScriptSource's,
 * or stdin's): with `print`, a body that returns its completion value.
 * A script with a `return` at its top, which the entry would run as its
 * function's (illegalReturn).
 */
export declare function evalProgram(code: string, print: boolean, mode: NodeEvalMode): NodeEvalProgram;
/** What Node's eval runs for `-e` code or stdin, by `--input-type` and its TypeScript (execution.js). */
export interface NodeEvalInput {
    /** The code it runs: as given (evalScriptSource's, for a CommonJS branch), or with its types stripped. */
    code: string;
    /** An ES module: `--input-type=module`'s or `module-typescript`'s, or by its syntax where no input type is given. */
    esModule: boolean;
    /** How Node evaluates it (NodeEvalMode): a script that Node compiles before `--import`'s modules load (evalTypeScript) is 'default'. */
    mode: NodeEvalMode;
    /** Its types were stripped. */
    stripped: boolean;
    /** Its types were stripped, or amaro was asked to and refused (Node's parsing mode was read: --experimental-transform-types warns). */
    stripAttempted: boolean;
    /** A script Node compiles before `--import`'s modules load (evalTypeScript) that compiles neither as JavaScript nor as TypeScript: refused before they load. */
    refusedBeforeImports?: boolean;
    /**
     * amaro's message for code that compiles neither as JavaScript nor as
     * TypeScript, which Node's report of V8's SyntaxError adds: after a
     * script's arrow, a module's a line apart.
     */
    hint?: string;
    /** What Node throws instead, for code an input type says is TypeScript that amaro refuses. */
    refusal?: TypeScriptRefusal;
}
/** Eval code's types stripped as Node strips them (its file `[eval]`, kEvalTag), or amaro's refusal of it. */
export type EvalTypeScriptStrip = (code: string) => Promise<{
    code: string;
} | {
    refusal: TypeScriptRefusal;
}>;
/**
 * What Node runs for `-e` code or stdin (eval_string.js, eval_stdin.js),
 * `source` as given and `script` as its CommonJS branches take it
 * (evalScriptSource), by `--input-type` and, where type stripping is on
 * (`strip`), its TypeScript (execution.js):
 *   - `module`: an ES module, as it is;
 *   - `module-typescript` and `commonjs-typescript`: stripped first, then
 *     an ES module or a script; amaro's refusal is Node's error;
 *   - `commonjs`, or no input type with stripping off: a script, or an ES
 *     module by its syntax where no input type is given (evalScript);
 *   - no input type (evalTypeScript): an ES module by its syntax, compiled,
 *     else stripped; else a script, compiled, else stripped and an ES
 *     module by its stripped syntax, else a script; code amaro refuses too
 *     fails with V8's error and amaro's message (`hint`).
 * Without stripping, an input type of TypeScript names a script.
 */
export declare function nodeEvalInput(source: string, script: string, inputType: string | undefined, strip: EvalTypeScriptStrip | null): Promise<NodeEvalInput>;
//# sourceMappingURL=node-eval.d.ts.map