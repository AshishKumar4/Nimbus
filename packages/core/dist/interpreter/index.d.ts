import { type RuntimeFunctionKind } from '../_shared/runtime-function-source.js';
import { type ModuleCell, type ModuleHelpers, type ModuleLink } from './modules.js';
import type { HostOps, NativeFunction } from './host-ops.js';
import { type ModuleRequest } from './module-requests.js';
import type { ModuleBindings } from '../runtime/esm-interop.js';
import { type InterpretedFrame } from './stack.js';
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
    /** esm-interop.ts's helpers (ESM_MODULE_HELPERS), compiled with the launch's map as a lowered cell's are. */
    readonly moduleHelpers: ModuleHelpers;
    /** The launch's single stack path; absent in hosts with no Node stack formatter. */
    readonly stackCapture?: (error: object, frames: readonly InterpretedFrame[]) => void;
    readonly stackIsProxy?: (value: unknown) => boolean;
    readonly stackIsError?: (value: unknown) => boolean;
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
    captureStack(error: object, above?: unknown): void;
    stackFrames(error: object): readonly InterpretedFrame[] | null;
    /** The function `new <kind>Function(...params, body)` builds, from `origin`. */
    compileFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string, origin?: CodeOrigin): NativeFunction;
    /**
     * The module cell for a file's text: Node's wrapper function of
     * (exports, require, module, __filename, __dirname). CommonJS text runs as
     * that function's body; an ES module is linked as runtime/esm-interop.ts
     * says, with the host's moduleHelpers. Which one the text is, is
     * `format` where the loader knows it (an `.mjs`, a "type"), else its
     * syntax (Node's detection). `javaScript`: the text is JavaScript
     * whatever the path's extension (a TypeScript file's emit).
     */
    compileModule(path: string, text: string, origin?: CodeOrigin, javaScript?: boolean, format?: 'module' | 'commonjs'): ModuleCell;
    /**
     * Whether compileModule made `cell` an ES module by its syntax alone, given
     * no format: Node's detection, which warns of a package.json with no
     * "type" (node-shims' MODULE_TYPELESS_PACKAGE_JSON).
     */
    detectedModule(cell: unknown): boolean;
    /**
     * Whether compileModule made `cell` an ES module whose body awaits at its
     * top level: a require() refuses a graph that holds one, before any of it
     * runs (node-shims' require(esm)). False for any other cell.
     */
    moduleAwaits(cell: unknown): boolean;
    /**
     * The link of `cell`, an ES module's cell: its InitializeEnvironment, which
     * answers its ExecuteModule (modules.ts ModuleLink), for a host that
     * evaluates a module graph as ECMA-262 does (runtime/esm-graph.ts); null
     * for a CommonJS cell.
     */
    moduleLink(cell: ModuleCell): ModuleLink | null;
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
 * string, a createRequire binding's calls, and a require wrapper's), or why
 * it read none: the text does not parse ('syntax'), or is TypeScript or JSX,
 * which it does not read ('unparsed'). The import() prefetch (node-shims.ts)
 * finds what to fetch with the requests, reading what it can; a late
 * graph's link plan reads with the loader's parse goal (`goal`: the format
 * the loader gives the module, or 'detect' where its syntax decides, as
 * compileModule parses it), and loads a module it could not read as the
 * interpreter does, for its error. `javaScript`: the text is JavaScript
 * whatever the path's extension (a staged module's, as compileModule's).
 */
export declare function moduleRequests(path: string, text: string, javaScript?: boolean, goal?: 'module' | 'commonjs' | 'detect'): ModuleRequests;
/** moduleRequests' answer. */
export interface ModuleRequests {
    readonly requests: ModuleRequest[];
    /** Read with a parse goal, of a module: what its static requests must export, by their order, and what it exports. */
    readonly bindings?: ModuleBindings;
    /** Why the text asks for nothing that was read: absent where it was read. */
    readonly unread?: 'syntax' | 'unparsed';
}
export declare function createInterpreter(hostOps: HostOps, host: InterpreterHost): Interpreter;
//# sourceMappingURL=index.d.ts.map