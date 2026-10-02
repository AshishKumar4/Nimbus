/**
 * code.ts — what compile.ts turns each expression and statement into, and
 * what the runtime modules run: Code, in its plain and generator flavors.
 */
import { Error, safeGenerator } from './intrinsics.js';
import type { Env } from './runtime.js';

/** Code that evaluates to a T: run directly (`s`), or as a generator (`g`) when it suspends. */
export interface CodeOf<T> {
  readonly s: (env: Env) => T;
  readonly g: ((env: Env) => Generator<unknown, T, unknown>) | null;
}
export type Code = CodeOf<unknown>;

/** Code that never suspends. */
export function syncCode<T>(s: (env: Env) => T): CodeOf<T> {
  return { s, g: null };
}

/** The plain flavor of code that suspends: reaching it is a bug of the compiler. */
export function suspendedSync(): never {
  throw new Error('interpreter: suspending code run synchronously');
}

export function suspendedBind(): never {
  throw new Error('interpreter: suspending pattern bound synchronously');
}

/** Code that suspends: its generator flavor only. */
export function genCode<T>(g: (env: Env) => Generator<unknown, T, unknown>): CodeOf<T> {
  return { s: suspendedSync, g: safeGenerator(g) };
}

/** A generator that runs `c` in a suspending context. */
export function asGen<T>(c: CodeOf<T>): (env: Env) => Generator<unknown, T, unknown> {
  if (c.g !== null) return c.g;
  const s = c.s;
  return safeGenerator(function* (env) { return s(env); });
}
