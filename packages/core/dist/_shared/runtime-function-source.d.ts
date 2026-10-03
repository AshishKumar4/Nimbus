/**
 * runtime-function-source.ts — the source text a Function constructor call
 * stands for, and when V8 refuses it. Shared by the module a staged call
 * becomes (commonjs-cell.ts) and the interpreter that runs an unstaged one.
 *
 * The interpreter runs this after a program may have replaced built-ins, so
 * nothing here names one: the caller's SourceRealm supplies what it needs
 * (the interpreter's, from the launch's start; commonjs-cell's, its own).
 */
import { type FunctionExpression, type Options } from 'acorn';
/** The constructors whose text a program can hand in at runtime. */
export declare const RUNTIME_FUNCTION_HEADS: {
    readonly function: "function";
    readonly async: "async function";
    readonly generator: "function*";
    readonly asyncGenerator: "async function*";
};
export type RuntimeFunctionKind = keyof typeof RUNTIME_FUNCTION_HEADS;
/** The built-ins this module's checks use, as the caller has them. */
export interface SourceRealm {
    readonly SyntaxError: new (message: string) => Error;
    /** The message of what the parser threw. */
    messageOf(error: unknown): string;
    /**
     * The parser's options for a script (`ecmaVersion: 'latest'`, `sourceType:
     * 'script'`). acorn reads one option of the object directly, so the
     * interpreter's inherits nothing.
     */
    readonly scriptOptions: Options;
}
/** The function literal V8 builds for `new <Kind>Function(...params, body)`. */
export declare function runtimeFunctionSource(kind: RuntimeFunctionKind, params: readonly string[], body: string): string;
/**
 * Why V8's constructor would refuse these arguments, or null when it would
 * build the function. V8 parses the parameters alone and requires them to end
 * where the list ends ("Arg string terminates parameters early"), the body
 * alone, and then the whole source, which must be exactly one function
 * literal ("Single function literal required"). Splicing unchecked text into
 * `(<head> anonymous(<params>\n) {\n<body>\n})` would otherwise let a body
 * such as `}, globalThis.x = 1, function () {` run code at module
 * evaluation that the constructor never would.
 */
export declare function runtimeFunctionSyntaxError(kind: RuntimeFunctionKind, params: readonly string[], body: string, realm: SourceRealm): string | null;
/**
 * The function literal a constructor call builds, parsed with the checks of
 * runtimeFunctionSyntaxError but the body parsed once: the parameters alone,
 * then the whole literal. V8's body-alone parse refuses nothing those two
 * accept, since with the parameters complete on their own the literal's
 * body is parsed as the body alone would be, in the parameters' context.
 * Throws the SyntaxError V8 would. `text` is what `node`'s offsets index.
 */
export declare function parseRuntimeFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string, realm: SourceRealm): {
    readonly node: FunctionExpression;
    readonly text: string;
};
/** Where a script's directive prologue ends and its one expression lies, in its text. */
export interface ScriptExpression {
    /** The end of the directive prologue (`'use strict';`), 0 when there is none. */
    readonly prologueEnd: number;
    readonly start: number;
    readonly end: number;
}
/**
 * The one expression a script is, after its directive prologue, for
 * vm.runInThisContext: node-shims hands the runtime-code service code it
 * cannot compile at request time, and the service runs it as a function
 * returning that expression's value (the script's completion value), its
 * directives the function's own. jiti's module wrapper
 * (`(function (exports, require, ...) { ... });`, Nuxt's config loader) and
 * vite-node's (`'use strict';(...) => { ... }`) are such scripts. A script
 * of directives alone (`"hello"`) completes with its last one's string: that
 * is the expression, and those before it the prologue. Throws the
 * SyntaxError V8 would for code that does not parse; null for a script of
 * another shape, whose completion value no function can stand in for.
 */
export declare function scriptExpression(code: string, realm: SourceRealm): ScriptExpression | null;
/** The body of the function that returns an expression's value, after a script's directive prologue. */
export declare function expressionFunctionBody(prologue: string, expression: string): string;
//# sourceMappingURL=runtime-function-source.d.ts.map