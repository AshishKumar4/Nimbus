import realm from 'node:process';
import { unavailable } from './unavailable.js';
/** vm's module classes, which Node has only under --experimental-vm-modules. */
const MODULE_CLASSES = new Set(['SourceTextModule', 'SyntheticModule', 'Module']);
/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's. Code it compiles reaches a module loader only through
 * `importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the
 * engine's own; there, the import goes through the program's loader instead
 * (`scripts` is told the code's filename, which the engine resolves it
 * against), so it loads the program's modules, not the host's. Code with no
 * absolute filename gives an import no referrer of the program's, and is
 * refused that loader; so is a context made with it, whose imports have no
 * script at all. Without `scripts` (no loader) the loader is refused
 * outright. A program's own callback is its own. vm's module classes are
 * absent, as in Node without --experimental-vm-modules.
 */
export function createVm(scripts) {
    const engine = realm.getBuiltinModule('node:vm');
    const loader = engine.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
    const serve = (options) => {
        if (typeof options !== 'object' || options.importModuleDynamically !== loader)
            return;
        if (scripts === null)
            unavailable('vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER');
        const { filename } = options;
        if (typeof filename !== 'string' || !filename.startsWith('/'))
            unavailable('vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER without an absolute filename');
        scripts(filename);
    };
    class Script extends engine.Script {
        constructor(code, options) {
            serve(options);
            super(code, options);
        }
    }
    return {
        ...Object.fromEntries(Object.entries(engine).filter(([name]) => !MODULE_CLASSES.has(name))),
        Script,
        createScript: (code, options) => new Script(code, options),
        createContext: (contextObject, options) => {
            if (options?.importModuleDynamically === loader)
                unavailable("vm.createContext's importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER");
            return engine.createContext(contextObject, options);
        },
        runInThisContext: (code, options) => { serve(options); return engine.runInThisContext(code, options); },
        runInContext: (code, context, options) => { serve(options); return engine.runInContext(code, context, options); },
        runInNewContext: (code, context, options) => { serve(options); return engine.runInNewContext(code, context, options); },
        compileFunction: (code, params, options) => { serve(options); return engine.compileFunction(code, params, options); },
    };
}
