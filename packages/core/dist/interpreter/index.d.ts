import { type RuntimeFunctionKind } from '../_shared/runtime-function-source.js';
import { type ModuleCell } from './modules.js';
import type { HostOps, NativeFunction } from './host-ops.js';
export type { HostOps } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export { replLineBody } from './repl-line.js';
export type { ModuleCell } from './modules.js';
export interface InterpreterHost {
    /** `import(specifier, options)` from code whose module URL is `parentUrl`. */
    dynamicImport(parentUrl: string | undefined, specifier: unknown, options: unknown): Promise<unknown>;
    /**
     * LAUNCH_PRIMORDIALS of the primordials module the launch loaded at its
     * start: the interpreter must have loaded that same module, not a second
     * evaluation of it, which would capture what the program has replaced.
     */
    readonly primordials: object;
}
export interface Interpreter {
    /** The function `new <kind>Function(...params, body)` builds. */
    compileFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string): NativeFunction;
    /**
     * The module cell for a file's text: Node's wrapper function of
     * (exports, require, module, __filename, __dirname). CommonJS text runs as
     * that function's body; an ES module as esbuild lowers it to one.
     */
    compileModule(path: string, text: string): ModuleCell;
    /**
     * A function returning the value of the script `code` when it is one
     * expression (scriptExpression): vm.runInThisContext's code, as node-shims
     * hands it over and calls it, with the global object as `this` (a script's
     * `this` at its top level). Code of any other shape is refused
     * (UnsupportedSyntax).
     */
    compileExpression(code: string): NativeFunction;
    /** Run a script at global scope: its vars and functions become global object properties. */
    runScript(text: string): void;
}
/** One module a module's text asks for: by `import` (static, export-from or import()) or by `require`. */
export interface ModuleRequest {
    readonly specifier: string;
    readonly kind: 'import' | 'require';
}
/**
 * The modules a file's text asks for, as this parser reads it: import and
 * export-from sources, `import()` of a string, and `require()` of a string
 * (any call of a `require` binding, the module's own or one createRequire
 * made). A specifier spelled with escapes or in a template is read as the
 * language reads it; one in a comment or a string is not a request. Text the
 * parser cannot read (TypeScript, JSX, a syntax error) asks for nothing.
 * The import() prefetch (node-shims.ts) finds what to fetch with it.
 */
export declare function moduleRequests(path: string, text: string): ModuleRequest[];
export declare function createInterpreter(hostOps: HostOps, host: InterpreterHost): Interpreter;
//# sourceMappingURL=index.d.ts.map