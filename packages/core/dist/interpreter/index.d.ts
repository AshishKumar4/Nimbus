import { type RuntimeFunctionKind } from '../_shared/runtime-function-source.js';
import { type ModuleCell } from './modules.js';
import type { HostOps, NativeFunction } from './host-ops.js';
export type { HostOps } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export { replLineBody } from './repl-line.js';
export type { ModuleCell } from './modules.js';
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
 * One module a module's text asks for, and how: `static` (an import or
 * export-from declaration), `dynamic` (import()) or `require`. The kind
 * decides the resolution, as the loader makes it: a static import is
 * evaluated through the module's scoped require (modules.ts), so it resolves
 * under require's conditions; import() resolves under import's.
 */
export interface ModuleRequest {
    readonly specifier: string;
    readonly kind: 'static' | 'dynamic' | 'require';
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