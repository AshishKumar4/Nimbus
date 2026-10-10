import { reflectApply, resume, resumeThrowing, withElement } from './intrinsics.js';
import { ROOT_ENV, TDZ, tdzError } from './runtime.js';
/** The wrapper function that runs `plan`. */
export function moduleCell(plan, ops, helpers) {
    const { frame, exportsSlot, requireSlot, moduleSlot, filenameSlot, dirnameSlot, exports, instantiate, body } = plan;
    const bs = body.s;
    const bg = body.g;
    return (exportsArg, requireArg, moduleArg, filename, dirname) => {
        const env = withElement(frame, 0, ROOT_ENV);
        env[exportsSlot] = exportsArg;
        env[requireSlot] = requireArg;
        env[moduleSlot] = moduleArg;
        env[filenameSlot] = filename;
        env[dirnameSlot] = dirname;
        // A cell's module is always an ES module's: the next launch lowers
        // esModuleSource's text, which declares an export.
        const exportsObject = ops.get(moduleArg, 'exports');
        const define = reflectApply(helpers.exports, undefined, [exportsObject]);
        for (let i = 0; i < exports.length; i++)
            reflectApply(define, undefined, [exports[i].name, exportGetter(env, exports[i], helpers)]);
        // Instantiation, before any import is evaluated: an import that
        // imports this module back (a cycle) finds its exports published and
        // its function declarations made, as a module's linking provides.
        if (instantiate !== null)
            instantiate(env);
        // The imports are linked where the body runs: a module that suspends
        // (top-level await) rejects for a failure linking them, as its lowered
        // cell's async body does, rather than throwing.
        if (bg === null) {
            link(plan, env, requireArg, helpers, exportsObject, define);
            bs(env);
            return undefined;
        }
        return drive(() => {
            link(plan, env, requireArg, helpers, exportsObject, define);
            return bg(env);
        });
    };
}
/** Each request required in order, its interop made; then the import namespaces, then `export *`. */
function link(plan, env, requireArg, helpers, exportsObject, define) {
    const { requests, namespaces, stars } = plan;
    for (let i = 0; i < requests.length; i++) {
        const { source, module, interop } = requests[i];
        const m = reflectApply(requireArg, undefined, [source]);
        if (module >= 0)
            env[module] = m;
        if (interop >= 0)
            env[interop] = reflectApply(helpers.interop, undefined, [m]);
    }
    for (let i = 0; i < namespaces.length; i++)
        env[namespaces[i].slot] = reflectApply(helpers.namespace, undefined, [env[namespaces[i].from]]);
    for (let i = 0; i < stars.length; i++)
        reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]]]);
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
async function drive(start) {
    const it = start();
    let r = resume(it, undefined);
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
        r = ok ? resume(it, value) : resumeThrowing(it, value);
    }
    return undefined;
}
