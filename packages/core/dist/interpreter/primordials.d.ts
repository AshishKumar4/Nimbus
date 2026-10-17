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
export * from '../_shared/primordials.js';
/** What Function.prototype.toString answers for `fn`: the source text it was compiled from. */
export declare function registerSource(fn: object, text: string): void;
/**
 * This module's identity: the interpreter checks that the module it loaded
 * is the one the launch loaded at its start, not a second evaluation.
 */
export declare const LAUNCH_PRIMORDIALS: object;
//# sourceMappingURL=primordials.d.ts.map