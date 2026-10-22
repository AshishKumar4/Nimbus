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
 * NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusKVNamespace,
 * NimbusD1Binding and NimbusR2Bucket are public API of
 * the embedder's Worker: wrangler resolves them by class name
 * and ctx.exports auto-populates them by export name, so the embedder's entry
 * module re-exports them under exactly these names.
 *
 * Bundle-graph note: these classes must remain reachable from the embedder's
 * entry module for Wrangler to bundle the WorkerEntrypoint exports.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod/v4';
import type { HostRoute } from './composition.js';
import type { D1QueryRequest, D1QueryResponse, KvGetOptions, KvListOptions, KvPutOptions, KvPutValue, R2PutBody, R2WireGetOptions, R2WireListOptions, R2WirePutOptions } from './inner-storage-env.js';
import { type LoaderStoreRef } from './loader-store-client.js';
import { type FacetCodePolicy } from './facet-limits.js';
import { type SupervisorBindingProps } from './supervisor-props.js';
import type { WorkspaceEgress } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { WorkerCode, EntrypointOptions } from './vendor/types.js';
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
    getEntrypoint(name?: string, options?: EntrypointOptions): LoadedEntrypoint;
    getDurableObjectClass(name: string, options?: EntrypointOptions): DurableObjectClass;
}
/**
 * The OUTER `env.LOADER` these shims forward to. `load` is the unkeyed arm the
 * inner Worker asked for; `get` is the keyed arm every later hop re-enters in
 * its own request context. `get`'s callback answers with whatever the caller
 * assembled — a staged artifact's module map is the embedder's, so the fabric
 * does not name it (see {@link ./process-fabric.js} StagedBootAssembler).
 */
interface OuterWorkerLoader {
    /** Native, a stub; a shim's in nested Nimbus, an RPC promise of one, settled once it admitted the code. */
    load(code: WorkerCode): LoadedWorker | Promise<LoadedWorker>;
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
/** Props the assets shim is minted with. */
interface NimbusAssetsProps {
    /** Project root in VFS (e.g. "home/user/myapp"). */
    vfsRoot?: string;
    /** Directory declared in wrangler.jsonc.assets.directory. */
    assetsDir?: string;
    /** Supervisor DO id whose VFS holds the assets. */
    doId?: string;
    /** The way back to that DO, minted with the binding. */
    route?: HostRoute;
    /** The credential the assets are read as: the process that serves them, as the host minted it. */
    cred?: VfsCred;
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
export declare class NimbusAssetsRPC extends WorkerEntrypoint<object, NimbusAssetsProps> {
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
    policy: z.ZodOptional<z.ZodObject<{
        kind: z.ZodCustom<"build" | "esbuild" | "fanout" | "git" | "isolate" | "process" | "transform" | "worker", "build" | "esbuild" | "fanout" | "git" | "isolate" | "process" | "transform" | "worker">;
        limits: z.ZodObject<{
            cpuMs: z.ZodNumber;
            subRequests: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    options: z.ZodOptional<z.ZodObject<{
        props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        limits: z.ZodOptional<z.ZodObject<{
            cpuMs: z.ZodOptional<z.ZodNumber>;
            subRequests: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$loose>>;
    stage: z.ZodOptional<z.ZodUnknown>;
    supervisor: z.ZodOptional<z.ZodCustom<SupervisorBindingProps, SupervisorBindingProps>>;
    egress: z.ZodOptional<z.ZodCustom<WorkspaceEgress, WorkspaceEgress>>;
}, z.core.$loose>;
type NimbusLoadedEntrypointProps = z.infer<typeof NimbusLoadedEntrypointPropsSchema>;
/** Props every Worker-Loader hop carries: how deep this Nimbus already is, and whose network it loads into. */
interface NimbusLoaderDepthProps {
    depth?: number;
    /**
     * The egress of the process whose Worker holds this loader, when it has
     * one: every Worker loaded through it goes out through it too
     * (workspaceOutbound). With its network's id, so a keyed load under one
     * egress is never served under another.
     */
    egress?: WorkspaceEgress;
    networkId?: string;
    /**
     * Whose loader this is: an opaque name its minter makes once per owner and
     * load generation (a `wrangler dev` build), under which its keyed workers
     * (LOADER.get) are cached. Two owners in one isolate never share one.
     */
    namespace?: string;
    /** Where what it loads is kept durable (the session's loader code store), when its minter has one. */
    store?: LoaderStoreRef;
}
/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export declare class NimbusLoaderRPC extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoaderDepthProps> {
    /**
     * Inner: env.LOADER.load(code). Keeps the CODE (not a stub — stubs are
     * I/O-bound to the calling request context), bounded (loader-heap.ts), and
     * returns a NimbusLoadedWorker RPC stub. Each downstream call re-loads the
     * worker in its own request context via LOADER.get(key, cb). The argument
     * has already arrived: its whole live input is charged, and credited now or
     * refused, before it is validated or kept.
     */
    load(code: WorkerCode): Promise<unknown>;
    /**
     * Inner: env.LOADER.get(id, callback). The inner's callback returns a code
     * object, cached under this loader's owner, its network and `id`: an id is
     * reused within its owner, as the platform's LOADER.get reuses it, and
     * never across owners. (load() keys are random, and cannot collide.)
     */
    get(id: string, callback: () => WorkerCode | Promise<WorkerCode>): Promise<unknown>;
}
/** Props hop 2 carries: the stashed code it re-loads, and its inherited depth. */
interface NimbusLoadedWorkerProps extends NimbusLoaderDepthProps {
    key?: string;
    policy?: FacetCodePolicy;
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
    getEntrypoint(name?: string, options?: EntrypointOptions): unknown;
    /**
     * Pass-through to outer worker.getDurableObjectClass(name). The
     * returned stub is tied to THIS method's outer request context; if
     * the caller (the inner worker) uses the class in a later request
     * it will fail the cross-request-I/O check. For Phase 3 DO binding
     * synthesis we resolve classes directly from nimbus-wrangler's own
     * request context (which is the build-time context), not through
     * this method.
     */
    getDurableObjectClass(name: string, options?: EntrypointOptions): DurableObjectClass;
}
/**
 * The entrypoint `entry` (a NimbusLoadedEntrypoint) stands for: its loaded
 * worker's, re-loaded in this request's context. A function of the module,
 * not a method, so a guest holding `entry` cannot reach the raw entrypoint.
 */
export declare function resolveLoadedEntrypoint(entry: {
    ctx: {
        props?: unknown;
        exports?: unknown;
    };
    env: NimbusLoaderShimEnv;
}): Promise<LoadedEntrypoint>;
/** Hop 3: a named-or-default entrypoint. Exposes .fetch() and .handleHttpRequest(). */
export declare class NimbusLoadedEntrypoint extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedEntrypointProps> {
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
    /** The way back to the supervisor DO, minted with the binding. */
    route?: HostRoute;
}
/**
 * The binding the loader passes for `env.MY_DO` (a WorkerEntrypoint of the
 * session's isolate). The inner Worker does not use it as its namespace: a
 * DurableObjectNamespace's API is synchronous, and this one's answers are
 * RpcPromises, which cannot travel as arguments. The inner Worker replaces it
 * with a local namespace (inner-do-env.ts, inner-env.ts) that makes ids
 * and stubs itself, and relays each member a stub's caller reaches, its
 * fetch included, to `callOn` or `getOn`.
 */
export declare class NimbusDurableObjectNamespace extends WorkerEntrypoint<object, NimbusDoNamespaceProps> {
    /**
     * The member of object `id` at `path` (names from the object down), called
     * with `args`: its answer, or what it throws, as the object gave it.
     */
    callOn(id: string, path: string[], args: unknown[]): Promise<unknown>;
    /** The member of object `id` at `path`, read. */
    getOn(id: string, path: string[]): Promise<unknown>;
}
/** Props a storage binding is minted with: its store, and the way to the session that holds it. */
interface NimbusStorageProps {
    /** The session Durable Object whose storage holds the store. */
    doId?: string;
    /** The way back to that DO, minted with the binding. */
    route?: HostRoute;
    /** The project the binding is declared in. */
    root?: string;
    /** The store: a KV namespace's or R2 bucket's binding name, a D1 database's id. */
    store?: string;
    /** What a KV or R2 store's files are read and written as: the process that started the server. */
    cred?: VfsCred;
}
/** env.KV: a KV namespace, the methods of Cloudflare's API and nothing else. */
export declare class NimbusKVNamespace extends WorkerEntrypoint<object, NimbusStorageProps> {
    get(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
    getWithMetadata(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
    put(key: string, value: KvPutValue, options?: KvPutOptions): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(options?: KvListOptions): Promise<unknown>;
}
/** A D1 database's binding: D1's own binding contract, `query`, and nothing else. */
export declare class NimbusD1Binding extends WorkerEntrypoint<object, NimbusStorageProps> {
    /**
     * All of `request`'s queries, run in one transaction, answered with the
     * database's bookmark after them. The request's bookmark is not sent on:
     * the database has one copy, which every bookmark is already met by.
     */
    query(request: D1QueryRequest): Promise<D1QueryResponse>;
}
/** An R2 bucket's binding: the methods of Cloudflare's API, taking and answering the fields its objects are made of. */
export declare class NimbusR2Bucket extends WorkerEntrypoint<object, NimbusStorageProps> {
    head(key: string): Promise<unknown>;
    get(key: string, options: R2WireGetOptions): Promise<unknown>;
    put(key: string, value: R2PutBody, options: R2WirePutOptions): Promise<unknown>;
    delete(keys: string | string[]): Promise<unknown>;
    list(options: R2WireListOptions): Promise<unknown>;
}
export {};
//# sourceMappingURL=bindings.d.ts.map