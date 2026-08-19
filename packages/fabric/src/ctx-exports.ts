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

/**
 * One entry of `ctx.exports`: a top-level entrypoint's loopback factory, which
 * mints a Service Binding stub for that entrypoint when called with props.
 *
 * The stub's RPC surface belongs to the entrypoint CLASS, which this leaf
 * cannot see — `Cloudflare.Exports` is derived from the embedder's own main
 * module, so for a library it evaluates to `{}`. A caller that knows the class
 * names the surface it expects (`factory<MySupervisorRpc>({ props })`); one
 * that does not gets `unknown` and has to narrow, same as
 * `DurableObjectNamespace<T>` and `RpcStub<T>` in @cloudflare/workers-types.
 */
export type EntrypointLoopbackFactory = <Stub = unknown>(options: { props: object }) => Stub;

/**
 * `ctx.exports` itself — one factory per top-level entrypoint export, keyed by
 * export name. Absent names read as undefined, which is how a caller finds out
 * the embedder's entry module does not re-export the class it needs.
 */
export type CtxExports = Record<string, EntrypointLoopbackFactory | undefined>;

let _ctxExports: CtxExports | null = null;

export function setCtxExports(value: CtxExports): void {
  if (_ctxExports) return; // first-write-wins, same as the prior inline impl
  _ctxExports = value;
}

export function getCtxExports(): CtxExports | null {
  return _ctxExports;
}

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
 * the held ctx.exports otherwise. Calling the result with props mints one
 * supervisor binding (`env.SUPERVISOR`) for one hosted program. Null when
 * either half is missing; the caller decides whether that degrades or throws.
 */
export function supervisorEntrypoint(exportsObj?: unknown): EntrypointLoopbackFactory | null {
  const exports = exportsObj ?? _ctxExports;
  if (!_supervisorEntrypointName) return null;
  if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) return null;
  const factory = (exports as Record<string, unknown>)[_supervisorEntrypointName];
  return typeof factory === 'function' ? (factory as EntrypointLoopbackFactory) : null;
}

/** The registered name, for error messages that point at the missing export. */
export function supervisorEntrypointName(): string | null {
  return _supervisorEntrypointName;
}
