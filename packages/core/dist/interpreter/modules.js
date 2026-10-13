import { SafeWeakSet, SyntaxError, reflectApply, reflectHas, resume, resumeThrowing, withElement } from './intrinsics.js';
import { ROOT_ENV, TDZ, tdzError } from './runtime.js';
import { initializeStack, popStack, pushStack, stampStack, suspendedStack } from './stack.js';
/** The wrapper function that runs `plan`. */
export function moduleCell(plan, ops, helpers) {
    const { frame, exportsSlot, requireSlot, moduleSlot, filenameSlot, dirnameSlot, instantiate, body } = plan;
    const bs = body.s;
    const bg = body.g;
    return (exportsArg, requireArg, moduleArg, filename, dirname) => {
        const env = withElement(frame, 0, ROOT_ENV);
        env[exportsSlot] = exportsArg;
        env[requireSlot] = requireArg;
        env[moduleSlot] = moduleArg;
        env[filenameSlot] = filename;
        env[dirnameSlot] = dirname;
        initializeStack(env, plan.stack, undefined, undefined, false);
        const exportsObject = ops.get(moduleArg, 'exports');
        const define = reflectApply(helpers.exports, undefined, [exportsObject]);
        // Instantiation, before any import is evaluated: an import that
        // imports this module back (a cycle) finds its function declarations
        // made, as a module's linking provides, and its exports published (link).
        if (instantiate !== null)
            instantiate(env);
        // The module is linked where the body runs: a module that suspends
        // (top-level await) rejects for a failure linking it, rather than
        // throwing.
        if (bg === null) {
            const previous = pushStack(env);
            try {
                link(plan, env, requireArg, helpers, exportsObject, define);
                bs(env);
                return undefined;
            }
            catch (error) {
                stampStack(error);
                throw error;
            }
            finally {
                popStack(previous);
            }
        }
        return drive(env, () => {
            link(plan, env, requireArg, helpers, exportsObject, define);
            return bg(env);
        });
    };
}
/** The exports objects of the modules whose link has finished: every name they export is there, `export *`'s too. */
const linked = new SafeWeakSet();
/**
 * The export getters installed; each request required in order, its interop
 * made; then the import namespaces, then `export *`. Then, before the body
 * runs, each name read of an ES module is checked to be one it exports, as
 * Node's linker checks it: a registry's namespace, or a module this
 * interpreter linked. One still linking (a cycle) is not yet complete, and a
 * CommonJS module's names are its source's (cjs-module-lexer's), not its
 * exports object's; neither is checked here.
 */
function link(plan, env, requireArg, helpers, exportsObject, define) {
    const { exports, requests, namespaces, stars } = plan;
    for (let i = 0; i < exports.length; i++)
        reflectApply(define, undefined, [exports[i].name, exportGetter(env, exports[i], helpers)]);
    for (let i = 0; i < requests.length; i++) {
        const { source, type, module, interop } = requests[i];
        const m = reflectApply(helpers.load, undefined, [requireArg, source, type]);
        if (module >= 0)
            env[module] = m;
        if (interop >= 0)
            env[interop] = reflectApply(helpers.interop, undefined, [m]);
    }
    for (let i = 0; i < namespaces.length; i++)
        env[namespaces[i].slot] = reflectApply(helpers.namespace, undefined, [env[namespaces[i].from]]);
    for (let i = 0; i < stars.length; i++)
        reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]]]);
    if (typeof exportsObject === 'object' && exportsObject !== null)
        linked.add(exportsObject);
    for (let i = 0; i < requests.length; i++) {
        const { source, module, names } = requests[i];
        if (module < 0 || names.length === 0)
            continue;
        const m = env[module];
        if (reflectApply(helpers.interop, undefined, [m]) !== m || typeof m !== 'object' || m === null)
            continue;
        if (!linked.has(m) && reflectHas(m, '__esModule'))
            continue;
        for (let j = 0; j < names.length; j++) {
            if (!reflectHas(m, names[j]))
                throw new SyntaxError(`The requested module '${source}' does not provide an export named '${names[j]}'`);
        }
    }
}
/** The getter of `entry` over one evaluation's frame. */
function exportGetter(env, entry, helpers) {
    if (entry.kind === 'read') {
        const read = entry.read;
        return () => read(env);
    }
    const { name, slot, from } = entry;
    return () => {
        if (env[slot] === undefined) {
            if (env[from] === TDZ)
                throw tdzError(name);
            env[slot] = reflectApply(helpers.namespace, undefined, [env[from]]);
        }
        return env[slot];
    };
}
/** Runs a module body's generator, made by `start`, as an async function would: one await per yielded value. */
async function drive(env, start) {
    let it;
    let r;
    let previous = pushStack(env);
    try {
        it = start();
        r = resume(it, undefined);
    }
    catch (error) {
        stampStack(error);
        throw error;
    }
    finally {
        suspendedStack(env);
        popStack(previous);
    }
    while (!r.done) {
        let value;
        let ok = true;
        try {
            value = await r.value;
        }
        catch (error) {
            ok = false;
            value = error;
        }
        previous = pushStack(env);
        try {
            r = ok ? resume(it, value) : resumeThrowing(it, value);
        }
        catch (error) {
            stampStack(error);
            throw error;
        }
        finally {
            suspendedStack(env);
            popStack(previous);
        }
    }
    return undefined;
}
