import { type RuntimeFunctionKind } from '../_shared/runtime-function-source.js';
import { type ModuleCell } from './compile.js';
import type { HostOps, NativeFunction } from './host-ops.js';
export { HOST_OPS_SOURCE, type HostOps } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export type { ModuleCell } from './compile.js';
export interface InterpreterHost {
    /** `import(specifier, options)` from code whose module URL is `parentUrl`. */
    dynamicImport(parentUrl: string | undefined, specifier: unknown, options: unknown): Promise<unknown>;
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
    /** Run a script at global scope: its vars and functions become global object properties. */
    runScript(text: string): void;
}
export declare function createInterpreter(hostOps: HostOps, host: InterpreterHost): Interpreter;
//# sourceMappingURL=index.d.ts.map