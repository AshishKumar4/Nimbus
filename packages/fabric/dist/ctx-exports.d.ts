/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from the embedder's entry module so helpers (notably
 * isolate-pool.ts) can read `ctx.exports` without transitively importing the
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
export type EntrypointLoopbackFactory = <Stub = unknown>(options: {
    props: object;
}) => Stub;
/**
 * `ctx.exports` itself — one factory per top-level entrypoint export, keyed by
 * export name. Absent names read as undefined, which is how a caller finds out
 * the embedder's entry module does not re-export the class it needs.
 */
export type CtxExports = Record<string, EntrypointLoopbackFactory | undefined>;
export declare function setCtxExports(value: CtxExports): void;
export declare function getCtxExports(): CtxExports | null;
export declare function setSupervisorEntrypointName(name: string): void;
/**
 * Resolve the registered supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the held ctx.exports otherwise. Calling the result with props mints one
 * supervisor binding (`env.SUPERVISOR`) for one hosted program. Null when
 * either half is missing; the caller decides whether that degrades or throws.
 */
export declare function supervisorEntrypoint(exportsObj?: unknown): EntrypointLoopbackFactory | null;
/** The registered name, for error messages that point at the missing export. */
export declare function supervisorEntrypointName(): string | null;
//# sourceMappingURL=ctx-exports.d.ts.map