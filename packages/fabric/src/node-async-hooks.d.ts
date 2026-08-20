/**
 * Minimal typing for the one node builtin fabric uses. The repo compiles
 * against workers-types only (no @types/node), and pulling all of
 * @types/node for one class would let untyped node surface leak into
 * workerd code. workerd ships AsyncLocalStorage under `nodejs_compat`
 * (probe-verified 2026-05-04, see core's real-node-imports.ts matrix);
 * bun and node ship it natively.
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
