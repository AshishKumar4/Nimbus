/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from the embedder's entry module so helpers (notably
 * loader-pool.ts) can read `ctx.exports` without transitively importing the
 * Durable Object classes. Keeping this a leaf (no imports) lets the pool be
 * unit-tested in a plain Node/Bun process.
 *
 * The embedder's fetch handler calls `setCtxExports(ctx.exports)` on the
 * first request; callers like the loader pool read via `getCtxExports()`.
 * If the pool is constructed before the first fetch (unlikely) it just gets
 * null — the caller decides how to degrade.
 */

let _ctxExports: any = null;

export function setCtxExports(value: any): void {
  if (_ctxExports) return; // first-write-wins, same as the prior inline impl
  _ctxExports = value;
}

export function getCtxExports(): any {
  return _ctxExports;
}

/**
 * The embedder's supervisor WorkerEntrypoint factory, as ctx.exports holds
 * it: calling it with props mints one supervisor binding (`env.SUPERVISOR`)
 * for one hosted program.
 */
export type SupervisorEntrypointFactory = (options: { props: object }) => unknown;

/**
 * The fabric mints supervisor bindings for the programs it hosts, but the
 * entrypoint class that answers them belongs to the embedder, so its
 * ctx.exports name is registered once at composition time rather than
 * hardcoded here. First-write-wins, same as the ctx.exports holder above.
 */
let _supervisorEntrypointName: string | null = null;

export function setSupervisorEntrypointName(name: string): void {
  if (_supervisorEntrypointName) return;
  _supervisorEntrypointName = name;
}

/**
 * Resolve the registered supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the held ctx.exports otherwise. Null when either half is missing; the
 * caller decides whether that degrades or throws.
 */
export function supervisorEntrypoint(exportsObj?: unknown): SupervisorEntrypointFactory | null {
  const exports = exportsObj ?? _ctxExports;
  if (!_supervisorEntrypointName) return null;
  if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) return null;
  const factory = (exports as Record<string, unknown>)[_supervisorEntrypointName];
  return typeof factory === 'function' ? (factory as SupervisorEntrypointFactory) : null;
}

/** The registered name, for error messages that point at the missing export. */
export function supervisorEntrypointName(): string | null {
  return _supervisorEntrypointName;
}
