/**
 * code.ts — what compile.ts turns each expression and statement into, and
 * what the runtime modules run: Code, in its plain and generator flavors.
 */
import { Error, safeGenerator } from './intrinsics.js';
/** Code that never suspends. */
export function syncCode(s) {
    return { s, g: null };
}
/** The plain flavor of code that suspends: reaching it is a bug of the compiler. */
export function suspendedSync() {
    throw new Error('interpreter: suspending code run synchronously');
}
export function suspendedBind() {
    throw new Error('interpreter: suspending pattern bound synchronously');
}
/** Code that suspends: its generator flavor only. */
export function genCode(g) {
    return { s: suspendedSync, g: safeGenerator(g) };
}
/** A generator that runs `c` in a suspending context. */
export function asGen(c) {
    if (c.g !== null)
        return c.g;
    const s = c.s;
    return safeGenerator(function* (env) { return s(env); });
}
