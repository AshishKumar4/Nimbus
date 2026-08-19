/**
 * session/bindings.ts — Inner-Worker + assets binding shims (W10).
 *
 * `nimbus-wrangler dev` runs a USER worker as a child process. That
 * child needs working `env` bindings (env.ASSETS, env.LOADER, env.MY_DO,
 * etc.) but the DO's `env` belongs to the supervisor's contract — we
 * can't pass it through directly. Workerd's enable_ctx_exports
 * (compat date 2026-04-01+) auto-populates Service Bindings from
 * top-level WorkerEntrypoint classes; these classes ARE those entry
 * points. They forward each binding kind back to the supervisor DO via
 * RPC stub (`env.NIMBUS_SESSION.idFromString(doId).get()...`).
 *
 * The shims have NO interaction with NimbusSession internals except
 * through that RPC stub. Co-located here for grep-ability.
 *
 * NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker,
 * NimbusLoadedEntrypoint, NimbusDurableObjectNamespace and NimbusDOStub are
 * public API of the embedder's Worker: wrangler resolves them by class name
 * and ctx.exports auto-populates them by export name, so the embedder's entry
 * module re-exports them under exactly these names.
 *
 * Bundle-graph note: these classes must remain reachable from the embedder's
 * entry module for Wrangler to bundle the WorkerEntrypoint exports.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod/v4';
import type { WorkerCode } from './vendor/types.js';
/**
 * The supervisor DO namespace a shim resolves ONE stub from, by the id its
 * props carry. `Stub` is that DO's RPC surface as the calling shim uses it —
 * the supervisor class belongs to the embedder, so each shim names the methods
 * it calls rather than the class.
 */
interface SupervisorNamespace<Stub> {
    idFromString(id: string): DurableObjectId;
    get(id: DurableObjectId): Stub;
}
/**
 * A dynamic worker's entrypoint, as hop 3 relays to it. `fetch` is the
 * entrypoint contract every loaded worker answers; `handleHttpRequest` is the
 * fabric's own route target, which only a facet that serves ports exposes.
 */
interface LoadedEntrypoint {
    fetch(request: Request): Promise<Response>;
    handleHttpRequest?(request: Request): Promise<Response>;
}
/** A stub for one dynamically-loaded worker, as the shims hop across it. */
interface LoadedWorker {
    getEntrypoint(name?: string): LoadedEntrypoint;
    getDurableObjectClass(name: string): DurableObjectClass;
}
/**
 * The OUTER `env.LOADER` these shims forward to. `load` is the unkeyed arm the
 * inner Worker asked for; `get` is the keyed arm every later hop re-enters in
 * its own request context. `get`'s callback answers with whatever the caller
 * assembled — a staged artifact's module map is the embedder's, so the fabric
 * does not name it (see {@link ./process-fabric.js} StagedBootAssembler).
 */
interface OuterWorkerLoader {
    load(code: WorkerCode): LoadedWorker;
    get(id: string, getCode: () => Promise<object>): LoadedWorker;
}
/**
 * `env` for the three Worker-Loader hops. The depth var rides the env rather
 * than props because it is set on the OUTERMOST session and every nested
 * Nimbus inherits it.
 */
interface NimbusLoaderShimEnv {
    LOADER?: OuterWorkerLoader;
    NIMBUS_INNER_LOADER_DEPTH?: string;
}
/**
 * What the assets shim reads off the supervisor DO: the VFS bytes of one path,
 * or null when it holds no such file.
 */
interface AssetsSupervisorStub {
    _rpcReadFileBytes(path: string): Promise<ArrayBuffer | Uint8Array | null>;
}
/** `env` for the assets shim: the supervisor its VFS reads round-trip through. */
interface NimbusAssetsEnv {
    NIMBUS_SESSION?: SupervisorNamespace<AssetsSupervisorStub>;
}
/** Props the assets shim is minted with. */
interface NimbusAssetsProps {
    /** Project root in VFS (e.g. "home/user/myapp"). */
    vfsRoot?: string;
    /** Directory declared in wrangler.jsonc.assets.directory. */
    assetsDir?: string;
    /** Supervisor DO id whose VFS holds the assets. */
    doId?: string;
}
/**
 * Assets binding shim. The inner Worker calls `env.ASSETS.fetch(request)`
 * and we serve the file from VFS under `<vfsRoot>/<assetsDir>/<pathname>`.
 *
 * Props (passed via ctx.props when this binding is constructed):
 *   vfsRoot   — project root in VFS (e.g. "home/user/myapp")
 *   assetsDir — directory declared in wrangler.jsonc.assets.directory
 *               (e.g. "./public" → we trim the leading ./)
 *
 * The hostname on the incoming Request is irrelevant (Workers Assets
 * convention); only pathname matters. Path traversal (`..`) is clamped.
 * Directories resolve to their `index.html` child; missing files fall
 * back to the assetsDir root `index.html` (SPA convention), then 404.
 *
 * The VFS is read from the supervisor DO via the class property
 * `_nimbusVfsResolver` set by NimbusSession at construction. WorkerEntrypoint
 * instances don't have direct access to the supervisor's SqliteVFS, so we
 * reach it through the supervisor stub (env.NIMBUS_SESSION.idFromString).
 * For Phase 1, we use a simpler approach: the props carry a supervisor
 * DO id so we can round-trip through an RPC method that reads the file.
 */
export declare class NimbusAssetsRPC extends WorkerEntrypoint<NimbusAssetsEnv, NimbusAssetsProps> {
    /**
     * Fetch a static asset. Called by the inner Worker as
     * `env.ASSETS.fetch(request)`. The request URL's pathname is used to
     * resolve a file under the configured assets directory.
     */
    fetch(request: Request): Promise<Response>;
}
declare const NimbusLoadedEntrypointPropsSchema: z.ZodObject<{
    key: z.ZodString;
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    depth: z.ZodOptional<z.ZodNumber>;
    supervisor: z.ZodOptional<z.ZodObject<{
        doId: z.ZodString;
        pid: z.ZodNumber;
        writerId: z.ZodString;
    }, z.core.$strip>>;
    stage: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
type NimbusLoadedEntrypointProps = z.infer<typeof NimbusLoadedEntrypointPropsSchema>;
/**
 * Diagnostic surface for /api/_diag/memory. Returns a snapshot of
 * the Map state — entry count, configured cap, eviction counter
 * since isolate boot. Pure read; no I/O.
 */
export declare function getLoadedCodesStats(): {
    entries: number;
    maxEntries: number;
    evictions: number;
};
/** Props every Worker-Loader hop carries: how deep this Nimbus already is. */
interface NimbusLoaderDepthProps {
    depth?: number;
}
/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export declare class NimbusLoaderRPC extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoaderDepthProps> {
    private _currentDepth;
    private _maxDepth;
    private _assertDepthOk;
    /**
     * Inner: env.LOADER.load(code). Stashes the CODE (not a stub — stubs
     * are I/O-bound to the calling request context) and returns a
     * NimbusLoadedWorker RPC stub. Each downstream call re-loads the
     * worker in its own request context via LOADER.get(key, cb).
     */
    load(code: WorkerCode): unknown;
    /**
     * Inner: env.LOADER.get(id, callback). The inner's callback returns
     * a code object; we treat `id` as the outer cache key (prefixed so
     * it doesn't collide with load()-generated keys).
     */
    get(id: string, callback: () => WorkerCode | Promise<WorkerCode>): Promise<unknown>;
}
/** Props hop 2 carries: the stashed code it re-loads, and its inherited depth. */
interface NimbusLoadedWorkerProps extends NimbusLoaderDepthProps {
    key?: string;
}
/** Hop 2: the returned "worker" stub. Exposes .getEntrypoint(). */
export declare class NimbusLoadedWorker extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedWorkerProps> {
    /**
     * Returns a NimbusLoadedEntrypoint stub that carries the code key +
     * entrypoint name forward. The actual outer-side load + fetch happens
     * inside NimbusLoadedEntrypoint.fetch() so all outer hops run in a
     * SINGLE outer request context (the cross-request-I/O limitation is
     * real — stubs created in one outer request can't be used by another).
     */
    getEntrypoint(name?: string): unknown;
    /**
     * Pass-through to outer worker.getDurableObjectClass(name). The
     * returned stub is tied to THIS method's outer request context; if
     * the caller (the inner worker) uses the class in a later request
     * it will fail the cross-request-I/O check. For Phase 3 DO binding
     * synthesis we resolve classes directly from nimbus-wrangler's own
     * request context (which is the build-time context), not through
     * this method.
     */
    getDurableObjectClass(name: string): DurableObjectClass;
}
/** Hop 3: a named-or-default entrypoint. Exposes .fetch(). */
export declare class NimbusLoadedEntrypoint extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedEntrypointProps> {
    _props(): NimbusLoadedEntrypointProps;
    _supervisorBinding(props: NimbusLoadedEntrypointProps): Promise<unknown>;
    _resolveEntrypoint(): Promise<LoadedEntrypoint>;
    /**
     * Relay the inner entrypoint's Response to the caller with a LIVE body.
     * The body streams through an identity pipe and the entrypoint stub is
     * disposed only once the body finishes — materializing (arrayBuffer) here
     * buffered every routed response to stream-end, which froze SSE/chunked
     * bodies (an agent server's /event live-sync, `curl -N` loopback, external
     * preview) until the facet closed the stream.
     */
    private _relayNestedRpcResponse;
    /**
     * Invoke the facet's HTTP handler.
     *
     * The call must be written as `ep.method(request)`. An RPC stub's method is a
     * JsRpcProperty, whose every property access is a WILDCARD that extends a
     * pipelined path (`JSG_WILDCARD_PROPERTY`, workerd api/worker-rpc.h) — so
     * `method.call(ep, request)` does NOT reach Function.prototype.call. It builds
     * the path `handleHttpRequest.call` and invokes it remotely with `ep` as its
     * first ARGUMENT. Serializing `ep` — an entrypoint to a dynamically-loaded
     * worker — is what workerd refuses:
     *
     *   DataCloneError: Entrypoints to dynamically-loaded workers cannot be
     *   transferred to other Workers
     *
     * (server.c++ `requireAllowsTransfer` → `throwDynamicEntrypointTransferError`).
     * The facet is never entered, because the failure is in serializing the
     * arguments, before the call is delivered.
     */
    private _callHttpHandler;
    handleHttpRequest(request: Request): Promise<Response>;
    /**
     * Forward fetch() to the outer worker's entrypoint. All three outer
     * hops (load → getEntrypoint → fetch) run in the same outer request
     * context (this method's invocation), which sidesteps the
     * cross-request-I/O limitation.
     */
    fetch(request: Request): Promise<Response>;
}
/** Props the synthesized namespace carries: which binding, on which supervisor. */
interface NimbusDoNamespaceProps {
    bindingName?: string;
    supervisorDoId?: string;
}
/**
 * `env.MY_DO` shim — a DurableObjectNamespace-like WorkerEntrypoint.
 *
 * Usage from inner Worker:
 *   const id   = await env.MY_DO.idFromName('x');   // AWAIT required
 *   const stub = env.MY_DO.get(id);
 *   await stub.fetch(request);
 *
 * IMPORTANT: unlike the real DurableObjectNamespace, idFromName /
 * newUniqueId / idFromString here return **Promises**, because they're
 * RPC-backed WorkerEntrypoint methods. The inner caller MUST `await`
 * them before passing the result to `.get()`. Workers RPC pipelining
 * does not currently allow passing an RpcPromise as a method argument
 * — the no-await form fails with:
 *     "Could not serialize object of type \"RpcPromise\"."
 *
 * Typical real-Worker code written for Cloudflare's synchronous
 * DurableObjectNamespace needs a one-word change (add `await`).
 *
 * idFromName produces prefix `name:` (deterministic FNV-style hash);
 * newUniqueId uses `uniq:` (random). The prefixes keep the two id
 * spaces distinct so a name-derived id can't collide with a random
 * one.
 */
export declare class NimbusDurableObjectNamespace extends WorkerEntrypoint<unknown, NimbusDoNamespaceProps> {
    /** Stable string id derived from a name. Hash is deterministic. */
    idFromName(name: string): string;
    /** Fresh random id (matches DurableObjectNamespace.newUniqueId()). */
    newUniqueId(): string;
    /** Accept-through for an already-formatted id. */
    idFromString(s: string): string;
    /** Return a stub bound to the given id. */
    get(id: string): unknown;
}
/**
 * What the DO shim reads off the supervisor: one inner-DO request, answered
 * from the facet the supervisor resolves in its own request context.
 */
interface InnerDoSupervisorStub {
    _rpcInnerDoFetch(request: {
        bindingName: string;
        id: string;
        method: string;
        url: string;
        headers: [string, string][];
        body: ArrayBuffer | null;
    }): Promise<{
        body: ArrayBuffer;
        status: number;
        statusText: string;
        headers: [string, string][];
    }>;
}
/** `env` for the DO shim: the supervisor that owns the facet. */
interface NimbusInnerDoEnv {
    NIMBUS_SESSION?: SupervisorNamespace<InnerDoSupervisorStub>;
}
/** Props the DO stub carries: which binding, which supervisor, which id. */
interface NimbusDoStubProps extends NimbusDoNamespaceProps {
    id?: string;
}
/**
 * A Durable-Object-namespace-stub for a specific id. Exposes fetch()
 * and will, if we later need it, forward RPC method calls through a
 * dispatch helper. The important invariant: EVERY call resolves the
 * inner DO class via getInnerDoClass() (./inner-do-registry.js) and
 * spins up / attaches to a facet via the supervisor's ctx.facets in
 * the SAME outer request context — never reusing stubs across requests.
 */
export declare class NimbusDOStub extends WorkerEntrypoint<NimbusInnerDoEnv, NimbusDoStubProps> {
    /**
     * Resolve the supervisor DO from env.NIMBUS_SESSION and route through
     * its _rpcInnerDoFetch RPC method, which runs ctx.facets.get(...) in
     * its own context and forwards the request.
     */
    fetch(request: Request): Promise<Response>;
}
export {};
//# sourceMappingURL=bindings.d.ts.map