import realm from 'node:process';
import { unavailable } from './unavailable.js';
/** vm's module classes, which Node has only under --experimental-vm-modules. */
const MODULE_CLASSES = new Set(['SourceTextModule', 'SyntheticModule', 'Module']);
/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's, given the program's options as they are. Code it compiles
 * reaches a module loader only through `importModuleDynamically:
 * constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the engine's own, which would
 * import the host's files at the program's paths: refused, at each compile
 * and context that names it. That is the program's module map kept whole,
 * not a boundary: a program that seeks the engine's loader reaches it
 * (import() in a Function body), as core's README says of a realm. A
 * program's own callback is its own. vm's module classes are absent, as in
 * Node without --experimental-vm-modules.
 */
export function createVm() {
    const engine = realm.getBuiltinModule('node:vm');
    const loader = engine.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
    const refuseLoader = (options) => {
        if (typeof options === 'object' && options !== null && options.importModuleDynamically === loader)
            unavailable('vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER');
    };
    class Script extends engine.Script {
        constructor(code, options) {
            refuseLoader(options);
            super(code, options);
        }
    }
    return {
        ...Object.fromEntries(Object.entries(engine).filter(([name]) => !MODULE_CLASSES.has(name))),
        Script,
        createScript: (code, options) => new Script(code, options),
        createContext: (contextObject, options) => { refuseLoader(options); return engine.createContext(contextObject, options); },
        runInThisContext: (code, options) => { refuseLoader(options); return engine.runInThisContext(code, options); },
        runInContext: (code, context, options) => { refuseLoader(options); return engine.runInContext(code, context, options); },
        runInNewContext: (code, context, options) => { refuseLoader(options); return engine.runInNewContext(code, context, options); },
        compileFunction: (code, params, options) => { refuseLoader(options); return engine.compileFunction(code, params, options); },
    };
}
