import type { Env } from './runtime.js';
/** Code that evaluates to a T: run directly (`s`), or as a generator (`g`) when it suspends. */
export interface CodeOf<T> {
    readonly s: (env: Env) => T;
    readonly g: ((env: Env) => Generator<unknown, T, unknown>) | null;
}
export type Code = CodeOf<unknown>;
/** Code that never suspends. */
export declare function syncCode<T>(s: (env: Env) => T): CodeOf<T>;
/** The plain flavor of code that suspends: reaching it is a bug of the compiler. */
export declare function suspendedSync(): never;
export declare function suspendedBind(): never;
/** Code that suspends: its generator flavor only. */
export declare function genCode<T>(g: (env: Env) => Generator<unknown, T, unknown>): CodeOf<T>;
/** A generator that runs `c` in a suspending context. */
export declare function asGen<T>(c: CodeOf<T>): (env: Env) => Generator<unknown, T, unknown>;
//# sourceMappingURL=code.d.ts.map