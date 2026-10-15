import realm from 'node:process';
import { unavailable } from './unavailable.js';
/** vm's module classes, which Node has only under --experimental-vm-modules. */
const MODULE_CLASSES = new Set(['SourceTextModule', 'SyntheticModule', 'Module']);
/**
 * The engine's vm, a program's: its contexts, scripts and functions are the
 * engine's. Code it compiles reaches a module loader only through
 * `importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, the
 * engine's own, which imports past the program's module map: refused, at
 * each compile and context that names it. Options are read once, and the
 * engine is given what was read, so what it compiles with is what was
 * refused or not. A program's own callback is its own. vm's module classes
 * are absent, as in Node without --experimental-vm-modules, and so is the
 * engine's Script: a program's Script holds one.
 */
export function createVm() {
    const engine = realm.getBuiltinModule('node:vm');
    const loader = engine.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
    const checked = (options) => {
        const read = { ...options };
        if (read.importModuleDynamically === loader)
            unavailable('vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER');
        return read;
    };
    const either = (options) => (typeof options === 'object' && options !== null ? checked(options) : options);
    class Script {
        #script;
        constructor(code, options) {
            this.#script = new engine.Script(code, either(options));
        }
        runInThisContext(options) { return this.#script.runInThisContext(options); }
        runInContext(context, options) { return this.#script.runInContext(context, options); }
        runInNewContext(context, options) { return this.#script.runInNewContext(context, options); }
        createCachedData() { return this.#script.createCachedData(); }
        get cachedDataRejected() { return this.#script.cachedDataRejected; }
        get sourceMapURL() { return this.#script.sourceMapURL; }
    }
    return {
        ...Object.fromEntries(Object.entries(engine).filter(([name]) => !MODULE_CLASSES.has(name))),
        Script,
        createScript: (code, options) => new Script(code, options),
        createContext: (contextObject, options) => engine.createContext(contextObject, options && checked(options)),
        runInThisContext: (code, options) => engine.runInThisContext(code, either(options)),
        runInContext: (code, context, options) => engine.runInContext(code, context, either(options)),
        runInNewContext: (code, context, options) => engine.runInNewContext(code, context, either(options)),
        compileFunction: (code, params, options) => engine.compileFunction(code, params, options && checked(options)),
    };
}
