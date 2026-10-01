/**
 * runtime-function-source.ts — the source text a Function constructor call
 * stands for, and when V8 refuses it. Shared by the module a staged call
 * becomes (commonjs-cell.ts) and the interpreter that runs an unstaged one.
 */
import { type FunctionExpression } from 'acorn';
/** The constructors whose text a program can hand in at runtime. */
export declare const RUNTIME_FUNCTION_HEADS: {
    readonly function: "function";
    readonly async: "async function";
    readonly generator: "function*";
    readonly asyncGenerator: "async function*";
};
export type RuntimeFunctionKind = keyof typeof RUNTIME_FUNCTION_HEADS;
export declare function isRuntimeFunctionKind(kind: string): kind is RuntimeFunctionKind;
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
export declare function runtimeFunctionSyntaxError(kind: RuntimeFunctionKind, params: readonly string[], body: string): string | null;
/**
 * The function literal a constructor call builds, parsed with the checks of
 * runtimeFunctionSyntaxError but the body parsed once: the parameters alone,
 * then the whole literal. V8's body-alone parse refuses nothing those two
 * accept, since with the parameters complete on their own the literal's
 * body is parsed as the body alone would be, in the parameters' context.
 * Throws the SyntaxError V8 would. `text` is what `node`'s offsets index.
 */
export declare function parseRuntimeFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string): {
    readonly node: FunctionExpression;
    readonly text: string;
};
//# sourceMappingURL=runtime-function-source.d.ts.map