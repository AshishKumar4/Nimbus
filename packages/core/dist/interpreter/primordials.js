/**
 * primordials.ts — the built-ins the interpreter calls, captured when a
 * launch starts, before any program code runs.
 *
 * The interpreter shares its realm with the program it runs and loads only
 * when the program first produces code its launch did not compile, by which
 * time the program may have replaced any built-in it can reach: a global
 * (`Array`, `TypeError`), a prototype method (`WeakMap.prototype.set`), the
 * array iterator. Had the interpreter captured them when it loads, such a
 * replacement would receive the interpreter's own objects (its environments,
 * the values of private fields), which no native code can reach. So the
 * launch's runtime loads this module first (RUNTIME CODE in
 * _shared/commonjs-cell.ts), and the interpreter (intrinsics.ts) reads its
 * built-ins only from here (tests/unit/primordials-audit.mjs checks).
 *
 * The captures are _shared/primordials.ts's, which the guest's module
 * loading shares. This module adds the answer Function.prototype.toString
 * gives for interpreted functions, which is installed now so that a program
 * replacing toString wraps it as it would the native one, and the module's
 * identity.
 */
import { dataDescriptor, objectCreate, objectFreeze, reflectApply, reflectDefineProperty, SafeWeakMap } from '../_shared/primordials.js';
export * from '../_shared/primordials.js';
/** Source text of every interpreted function, for Function.prototype.toString. */
const sources = new SafeWeakMap();
/** What Function.prototype.toString answers for `fn`: the source text it was compiled from. */
export function registerSource(fn, text) {
    sources.set(fn, text);
}
{
    const native = Function.prototype.toString;
    const replacement = {
        toString() {
            if (typeof this === 'function') {
                const source = sources.get(this);
                if (source !== undefined)
                    return source;
            }
            return reflectApply(native, this, []);
        },
    }.toString;
    sources.set(replacement, 'function toString() { [native code] }');
    reflectDefineProperty(Function.prototype, 'toString', dataDescriptor(replacement, true, false, true));
}
/**
 * This module's identity: the interpreter checks that the module it loaded
 * is the one the launch loaded at its start, not a second evaluation.
 */
export const LAUNCH_PRIMORDIALS = objectFreeze(objectCreate(null));
