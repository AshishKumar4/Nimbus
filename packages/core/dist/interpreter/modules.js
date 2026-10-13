import { reflectApply, resume, resumeThrowing, withElement } from './intrinsics.js';
import { ROOT_ENV } from './runtime.js';
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
/**
 * The export getters installed; each request required in order, its
 * namespace in its slot; then `export *`, but the names two of them reach
 * different bindings of (the loader's answer). Its graph's names were
 * checked before any of it ran, by whoever loads it (node-shims' late link
 * plan).
 */
function link(plan, env, requireArg, helpers, exportsObject, define) {
    const { exports, requests, stars } = plan;
    for (let i = 0; i < exports.length; i++) {
        const read = exports[i].read;
        reflectApply(define, undefined, [exports[i].name, () => read(env)]);
    }
    for (let i = 0; i < requests.length; i++) {
        const { source, type, module } = requests[i];
        const m = reflectApply(helpers.load, undefined, [requireArg, source, type]);
        if (module >= 0)
            env[module] = m;
    }
    if (stars.length === 0)
        return;
    const omitted = reflectApply(helpers.conflicts, undefined, [requireArg]);
    for (let i = 0; i < stars.length; i++)
        reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]], omitted]);
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
