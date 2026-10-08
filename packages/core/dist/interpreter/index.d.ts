import { type RuntimeFunctionKind } from '../_shared/runtime-function-source.js';
import { type ModuleCell } from './modules.js';
import type { HostOps, NativeFunction } from './host-ops.js';
import { type ModuleRequest } from './module-requests.js';
export type { HostOps } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export { replLineBody } from './repl-line.js';
export type { ModuleCell } from './modules.js';
export type { ModuleRequest } from './module-requests.js';
export interface InterpreterHost {
    /** `import(specifier, options)` from code whose module URL is `parentUrl`, for code compiled without an origin. */
    dynamicImport(parentUrl: string | undefined, specifier: unknown, options: unknown): Promise<unknown>;
    /**
     * LAUNCH_PRIMORDIALS of the primordials module the launch loaded at its
     * start: the interpreter must have loaded that same module, not a second
     * evaluation of it, which would capture what the program has replaced.
     */
    readonly primordials: object;
}
/**
 * Where compiled code comes from (commonjs-cell.ts, RUNTIME CODE): what its
 * import() calls, and the `Function` its free `Function` binding starts as.
 * An origin without a `Function` gives its code the global's, as code
 * compiled without an origin has; that code imports through the host
 * against its own module URL (none for a constructor's).
 */
export interface CodeOrigin {
    import(specifier: unknown, options: unknown): Promise<unknown>;
    /** Undefined, as an own property, for an origin without one. */
    readonly Function: unknown;
}
export interface Interpreter {
    /** The function `new <kind>Function(...params, body)` builds, from `origin`. */
    compileFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string, origin?: CodeOrigin): NativeFunction;
    /**
     * The module cell for a file's text: Node's wrapper function of
     * (exports, require, module, __filename, __dirname). CommonJS text runs as
     * that function's body; an ES module as esbuild lowers it to one.
     */
    compileModule(path: string, text: string, origin?: CodeOrigin): ModuleCell;
    /**
     * A function returning the value of the script `code` when it is one
     * expression (scriptExpression): vm.runInThisContext's code, as node-shims
     * hands it over and calls it, with the global object as `this` (a script's
     * `this` at its top level). Code of any other shape is refused
     * (UnsupportedSyntax).
     */
    compileExpression(code: string, origin?: CodeOrigin): NativeFunction;
    /** Run a script at global scope: its vars and functions become global object properties. */
    runScript(text: string): void;
}
/**
 * The modules a file's text asks for, as this parser reads it
 * (module-requests.ts programRequests: imports, import() and require() of a
 * string, a createRequire binding's calls, and a require wrapper's). Text the
 * parser cannot read (TypeScript, JSX, a syntax error) asks for nothing. The
 * import() prefetch (node-shims.ts) finds what to fetch with it.
 */
export declare function moduleRequests(path: string, text: string): ModuleRequest[];
/**
 * Where V8 would place a fatal error's report in `text`, a module's whole
 * text (a `{ cjs }` cell's wrapper included) as `goal` parses it, for the
 * process's fatal report (node-shims.ts __nimbusFatalArrow), which has a
 * frame's offset and not V8's message:
 *   - `offset` given: the innermost `throw` statement whose argument holds
 *     it, as [start, start + 1], V8's location of a throw; null for none;
 *   - `offset` -1: the syntax error that stops the parse, as [start, end]
 *     of the token it stops at; null when the text parses.
 */
export declare function fatalLocation(text: string, goal: 'script' | 'module', offset: number): [number, number] | null;
export declare function createInterpreter(hostOps: HostOps, host: InterpreterHost): Interpreter;
//# sourceMappingURL=index.d.ts.map