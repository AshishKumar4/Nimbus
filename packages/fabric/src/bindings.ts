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
 * NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub,
 * NimbusKVNamespace, NimbusD1Binding and NimbusR2Bucket are public API of
 * the embedder's Worker: wrangler resolves them by class name
 * and ctx.exports auto-populates them by export name, so the embedder's entry
 * module re-exports them under exactly these names.
 *
 * Bundle-graph note: these classes must remain reachable from the embedder's
 * entry module for Wrangler to bundle the WorkerEntrypoint exports.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod/v4';
import { disposeRpcResource, useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostNamespace, stagedBootAssembler } from './composition.js';
import type { HostRoute } from './composition.js';
import { hostNamespaceBinding, hostOpDispatch, type HostOpDispatch } from './host-dispatch.js';
import { innerDoIdFromName } from './inner-do-env.js';
import type { D1QueryRequest, D1QueryResponse, D1QuerySql, KvCall, KvGetOptions, KvListOptions, KvPutOptions, KvPutValue, R2Call, R2PutBody, R2WireGetOptions, R2WireListOptions, R2WirePutOptions } from './inner-storage-env.js';
import { assertModuleMapWithinCodeLimit, LOADER_CODE_CREDIT_BYTES } from './budgets.js';
import { admitInTurn, admitNow, getKey, holdGetKey, keep, loadedCode, priceCode, withinCredit, withMissCode, type PricedCode } from './loader-heap.js';
import { loaderStore, STORE_READ_BYTES, storedModule, type LoaderStoreRef, type StoredModule } from './loader-store-client.js';
import { applyFacetLimits, facetLimits, guestFacetPolicy, effectiveFacetLimits, facetLoaderKey, FACET_LIMITS, type FacetCodePolicy, type FacetKind } from './facet-limits.js';
import { bindingSupervisor, egressMarker, workspaceOutbound, type SupervisorBindingProps } from './supervisor-props.js';
import type { WorkspaceEgress } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { EntrypointLoopbackFactory } from './composition.js';
import type { WorkerCode, EntrypointOptions } from './vendor/types.js';

/**
 * `ctx.exports` for the loopback hops: workerd mints one factory per top-level
 * entrypoint export, and only the three the hops hand onward are named. An
 * absent name is how a hop finds out the embedder's entry module does not
 * re-export the class it needs.
 */
interface ShimCtxExports {
  NimbusLoadedWorker?: EntrypointLoopbackFactory;
  NimbusLoadedEntrypoint?: EntrypointLoopbackFactory;
  NimbusDOStub?: EntrypointLoopbackFactory;
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

/**
 * `ctx.exports` — workerd's loopback bag, which the installed
 * @cloudflare/workers-types does not put on `ExecutionContext`. Probed rather
 * than declared, so a runtime that predates it reads as absent, which is also
 * what the module-level holder's fallback keys off.
 */
function ctxExportsOf(ctx: unknown): unknown {
  if (!ctx || typeof ctx !== 'object' || !('exports' in ctx)) return undefined;
  return ctx.exports;
}

/**
 * The loopback factories a hop may need. An absent bag reads as an empty set,
 * which each hop reports as the specific class it could not find.
 */
function shimCtxExports(ctx: unknown): ShimCtxExports {
  const exports = ctxExportsOf(ctx);
  if (!exports || typeof exports !== 'object') return {};
  // The bag workerd populated. Which names are in it is the hop's question,
  // and each hop answers it with its own error.
  return exports as ShimCtxExports;
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
export class NimbusAssetsRPC extends WorkerEntrypoint<object, NimbusAssetsProps> {
  /**
   * Fetch a static asset. Called by the inner Worker as
   * `env.ASSETS.fetch(request)`. The request URL's pathname is used to
   * resolve a file under the configured assets directory.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const props: NimbusAssetsProps = this.ctx.props || {};
    const vfsRoot = String(props.vfsRoot || '');
    const assetsDir = String(props.assetsDir || '').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const doId = String(props.doId || '');

    // Normalize pathname: no leading /, drop .. segments entirely.
    let clean = url.pathname.replace(/^\/+/, '');
    const parts = clean.split('/').filter((p) => p && p !== '..' && p !== '.');
    clean = parts.join('/');

    // Resolve the supervisor DO through the composed host namespace and
    // dispatch readFileBytes through its supervisorOp entrypoint — a host
    // forwards envelopes, not private _rpc* methods.
    if (!doId) {
      return new Response('ASSETS binding not wired: missing doId', { status: 500 });
    }
    let stub: DurableObjectStub | null = null;
    let dispatch: HostOpDispatch;
    try {
      const ns = hostNamespaceBinding(this.env, 'NimbusAssetsRPC', props.route);
      stub = ns.get(ns.idFromString(doId));
      dispatch = hostOpDispatch(stub, 'NimbusAssetsRPC', props.route);
    } catch (e) {
      disposeRpcResource(stub);
      return new Response(`ASSETS binding not wired: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }

    // Candidate VFS paths, tried in order. The assetsDir is relative to
    // the project root in VFS. Trailing-slash and bare dir → index.html.
    const base = (vfsRoot ? vfsRoot + '/' : '') + (assetsDir ? assetsDir + '/' : '');
    const candidates: string[] = [];
    if (clean) {
      candidates.push(base + clean);
      if (!clean.endsWith('.html') && !clean.includes('.')) {
        candidates.push(base + clean.replace(/\/+$/, '') + '/index.html');
      }
    } else {
      candidates.push(base + 'index.html');
    }
    // SPA fallback: any unmatched path serves the top-level index.html.
    candidates.push(base + 'index.html');

    try {
      for (const candidate of candidates) {
        try {
          const response = await useRpcResource(
            // As the process the host named; a binding minted with none reads as the session's user.
            dispatch({ op: 'readFileBytes', args: [candidate], ...(props.cred === undefined ? {} : { cred: props.cred }) }),
            (bytes) => {
              if (bytes === null) return null;
              const body = bytes instanceof ArrayBuffer ? bytes
                : bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
                  ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
              if (!body) return new Response('Nimbus: readFileBytes returned invalid bytes', { status: 502 });
              return new Response(body, {
                status: 200,
                headers: {
                  'Content-Type': mimeTypeForPath(candidate),
                  'Cache-Control': 'no-store',
                },
              });
            },
          );
          if (response) return response;
        } catch { /* try next */ }
      }
    } finally {
      disposeRpcResource(stub);
    }

    return new Response('Not found', { status: 404 });
  }
}

/**
 * Pick a sensible content-type from a filename. Conservative list; the
 * inner Worker can always override via the response it constructs
 * (which Workers Assets won't touch for env.ASSETS.fetch results).
 */
function mimeTypeForPath(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = path.slice(i + 1).toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'css':              return 'text/css; charset=utf-8';
    case 'js': case 'mjs':   return 'application/javascript; charset=utf-8';
    case 'json':             return 'application/json; charset=utf-8';
    case 'svg':              return 'image/svg+xml';
    case 'png':              return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp':             return 'image/webp';
    case 'gif':              return 'image/gif';
    case 'ico':              return 'image/x-icon';
    case 'woff':             return 'font/woff';
    case 'woff2':            return 'font/woff2';
    case 'txt':              return 'text/plain; charset=utf-8';
    case 'xml':              return 'application/xml; charset=utf-8';
    case 'wasm':             return 'application/wasm';
    case 'map':              return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/**
 * Worker Loader binding shim.
 *
 * Option A — return the raw WorkerStub from RPC — was attempted first
 * and failed at runtime with:
 *   "Could not serialize object of type \"WorkerStub\". This type does
 *    not support serialization."
 *
 * Option B — proxy the stub via chained WorkerEntrypoint classes — is
 * implemented here. The three classes below mirror the three hops a
 * caller makes:
 *
 *   env.LOADER.load(code)              → NimbusLoaderRPC.load     (returns NimbusLoadedWorker)
 *   .getEntrypoint(name?)              → NimbusLoadedWorker.getEntrypoint (returns NimbusLoadedEntrypoint)
 *   .fetch(request)                    → NimbusLoadedEntrypoint.fetch
 *
 * Each class is a WorkerEntrypoint, so Service Binding stubs for them
 * pass across the isolate boundary cleanly. The outer WorkerStub lives
 * at a module-level Map keyed by a random id that's carried in
 * ctx.props so subsequent hops can look it up from the outer side.
 *
 * Depth cap (ctx.props.depth) prevents infinite nesting: Nimbus-in-
 * Nimbus-in-Nimbus is fine; five levels deep is almost certainly a
 * runaway and we throw a clear error. Default limit is 4; overridable
 * via the NIMBUS_INNER_LOADER_DEPTH env var on the outermost session.
 */


const FacetLimitsSchema = z.object({ cpuMs: z.number().int().nonnegative(), subRequests: z.number().int().nonnegative() });
const FacetPolicySchema = z.object({
  kind: z.custom<FacetKind>(value => typeof value === 'string' && Object.hasOwn(FACET_LIMITS, value)),
  limits: FacetLimitsSchema,
});
const EntrypointOptionsSchema = z.object({
  props: z.record(z.string(), z.unknown()).optional(),
  limits: FacetLimitsSchema.partial().optional(),
}).passthrough();

const NimbusLoadedEntrypointPropsSchema = z.object({
  key: z.string().min(1),
  name: z.string().nullable().optional(),
  depth: z.number().int().nonnegative().optional(),
  policy: FacetPolicySchema.optional(),
  options: EntrypointOptionsSchema.optional(),
  /**
   * Staged-artifact spec, for a ONE-SHOT run (runOneShot). The module map —
   * ~23 MB for Nimbus's largest stage — is assembled HERE, in this stateless
   * entrypoint's isolate, on the Worker-Loader cache-miss path, so a one-shot
   * run never materializes the artifact sources anywhere else. Validated by
   * the registered assembler.
   */
  stage: z.unknown().optional(),
  /** The staged run's SUPERVISOR binding props, minted into its program here. */
  supervisor: z.custom<SupervisorBindingProps>((value) => typeof value === 'object' && value !== null).optional(),
  /** A nested load's network (NimbusLoaderDepthProps.egress). */
  egress: z.custom<WorkspaceEgress>((value) => (typeof value === 'object' && value !== null) || typeof value === 'function').optional(),
}).passthrough();

type NimbusLoadedEntrypointProps = z.infer<typeof NimbusLoadedEntrypointPropsSchema>;

async function materializeNestedRpcRequest(request: Request): Promise<Request> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: new Headers(request.headers),
    body: hasBody ? await request.arrayBuffer() : undefined,
  };
  if (hasBody) init.duplex = 'half';
  return new Request(request.url, init);
}

function _genStubId(): string {
  return 'ldr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * A fresh outer WorkerStub for the Worker the shim holds under `key`, in the
 * CURRENT request context. Uses LOADER.get(id, cb) so repeated calls reuse
 * the same dynamic worker rather than spawning new ones; on the loader's
 * miss, the code is re-created from the shim's heap (withMissCode), or fails
 * by name once the shim no longer holds it.
 */
function _resolveStubInCurrentContext(
  env: object,
  outerLoader: OuterWorkerLoader,
  key: string | undefined,
  network: Pick<NimbusLoaderDepthProps, 'egress'>,
  policy?: FacetCodePolicy,
): LoadedWorker | null {
  if (key === undefined) return null;
  const code = loadedCode(key);
  if (!code) return null;
  const carried = policy ?? guestFacetPolicy(code);
  return outerLoader.get(facetLoaderKey(carried.kind, key, carried.limits), () =>
    withMissCode(key, env, (missed) => applyFacetLimits(carried.kind, workspaceOutbound(missed, network), carried.limits)));
}

/**
 * The policy a loaded entrypoint runs under: the one its props carry, else
 * the one its stored code carries, else its route's kind (a staged boot is
 * a process; a handle on someone else's worker is a worker).
 */
function entrypointPolicy(props: NimbusLoadedEntrypointProps): FacetCodePolicy {
  if (props.policy !== undefined) return props.policy;
  const stored = loadedCode(props.key);
  if (stored !== undefined) return guestFacetPolicy(stored);
  const kind: FacetKind = props.stage !== undefined ? 'process' : 'worker';
  return { kind, limits: facetLimits(kind) };
}

function startOptions(policy: FacetCodePolicy, options?: EntrypointOptions): EntrypointOptions {
  const lower = effectiveFacetLimits(policy.kind, options?.limits);
  return { ...options, limits: {
    cpuMs: Math.min(policy.limits.cpuMs, lower.cpuMs),
    subRequests: Math.min(policy.limits.subRequests, lower.subRequests),
  } };
}

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

/** The network part of `props`, to carry to the next hop. */
function loaderNetwork(props: NimbusLoaderDepthProps | undefined): Pick<NimbusLoaderDepthProps, 'egress'> {
  return props?.egress === undefined ? {} : { egress: props.egress };
}

/*
 * The classes below are what a guest holds: every string-named method of
 * one is callable by whoever holds its stub, TypeScript's `private`
 * notwithstanding. So each keeps only its intended methods, and what they
 * share is functions of the module, which no stub reaches.
 */

/** Refuses a Worker Loader past the nesting the env allows (NIMBUS_INNER_LOADER_DEPTH, default 4). */
function assertLoaderDepthOk(props: NimbusLoaderDepthProps | undefined, env: NimbusLoaderShimEnv | undefined): void {
  const d = props?.depth;
  const depth = typeof d === 'number' && d >= 0 ? d : 0;
  const raw = env?.NIMBUS_INNER_LOADER_DEPTH;
  const parsed = raw ? parseInt(String(raw), 10) : NaN;
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  if (depth >= max) {
    throw new Error(
      `Nimbus: refusing to spawn inner Worker Loader (depth=${depth + 1}, max=${max}). ` +
      `Set NIMBUS_INNER_LOADER_DEPTH to raise the cap or break the recursion.`,
    );
  }
}

/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export class NimbusLoaderRPC extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoaderDepthProps> {
  /**
   * Inner: env.LOADER.load(code). Keeps the CODE (not a stub — stubs are
   * I/O-bound to the calling request context), bounded (loader-heap.ts), and
   * returns a NimbusLoadedWorker RPC stub. Each downstream call re-loads the
   * worker in its own request context via LOADER.get(key, cb). The argument
   * has already arrived: its whole live input is charged, and credited now or
   * refused, before it is validated or kept.
   */
  async load(code: WorkerCode): Promise<unknown> {
    assertLoaderDepthOk(this.ctx.props, this.env);
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const key = _genStubId();
    const priced = priceCode(code, key);
    const lease = admitNow(admissionCredit(this.ctx.props, priced));
    try {
      return await admitLoaded(this.ctx, this.env, outerLoader, key, priced);
    } finally {
      lease.release();
    }
  }

  /**
   * Inner: env.LOADER.get(id, callback). The inner's callback returns a code
   * object, cached under this loader's owner, its network and `id`: an id is
   * reused within its owner, as the platform's LOADER.get reuses it, and
   * never across owners. (load() keys are random, and cannot collide.)
   */
  async get(id: string, callback: () => WorkerCode | Promise<WorkerCode>): Promise<unknown> {
    assertLoaderDepthOk(this.ctx.props, this.env);
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const namespace = this.ctx.props?.namespace;
    if (typeof namespace !== 'string' || namespace === '') {
      throw new Error('Nimbus: this Worker Loader binding was minted without an owner namespace, so it has no keyed workers');
    }
    // Bounded before it is built, and held under the key allowance; the
    // code credit is waited for holding only that, then shrunk to the code.
    // A hit holds no credit; a miss holds its key and arguments under the key
    // allowance while it waits for its code reservation, then looks again (a
    // get of the same key may have been admitted meanwhile).
    const { key, charge } = getKey(namespace, this.ctx.props?.networkId ?? null, id);
    const hit = loadedCode(key);
    if (hit !== undefined) return loadedWorker(this.ctx, key, guestFacetPolicy(hit));
    const held = holdGetKey(charge);
    try {
      const lease = await admitInTurn(LOADER_CODE_CREDIT_BYTES, `LOADER.get(${JSON.stringify(String(id).slice(0, 64))})`);
      try {
        const kept = loadedCode(key);
        if (kept !== undefined) return loadedWorker(this.ctx, key, guestFacetPolicy(kept));
        const priced = priceCode(await callback(), key);
        lease.shrinkTo(withinCredit(admissionCredit(this.ctx.props, priced)));
        return await admitLoaded(this.ctx, this.env, outerLoader, key, priced);
      } finally {
        lease.release();
      }
    } finally {
      held.release();
    }
  }
}

/**
 * Validate `priced` through the outer loader, awaiting its answer (in nested
 * Nimbus that loader is itself a shim, whose admission can refuse), keep it,
 * and return its handle.
 */
async function admitLoaded(ctx: ExecutionContext<NimbusLoaderDepthProps>, env: object, outerLoader: OuterWorkerLoader, key: string, priced: PricedCode): Promise<unknown> {
  const policy = guestFacetPolicy(priced.code);
  await outerLoader.load(applyFacetLimits(policy.kind, workspaceOutbound(priced.code, loaderNetwork(ctx.props)), policy.limits));
  const ref = ctx.props?.store;
  if (ref === undefined) {
    keep(key, priced);
  } else {
    // Durable before its handle is returned: the heap is then only a cache of it.
    const stored = new Map<string, StoredModule>();
    for (const [name, content] of Object.entries(priced.code.modules)) stored.set(name, await storedModule(content));
    await loaderStore(env, ref).keep([...stored.values()]);
    keep(key, priced, { ref, modules: stored });
  }
  return loadedWorker(ctx, key, policy);
}

/**
 * An admission's credit: its whole live input, and with a store the bounded
 * working space of keeping it (an encoded slice, a put frame, and its
 * `{json}` modules' texts).
 */
function admissionCredit(props: NimbusLoaderDepthProps | undefined, priced: PricedCode): number {
  return Math.max(1, priced.charge + (props?.store === undefined ? 0 : 2 * STORE_READ_BYTES + priced.jsonText));
}

/** The NimbusLoadedWorker handle on `key`. */
function loadedWorker(ctx: ExecutionContext<NimbusLoaderDepthProps>, key: string, policy: FacetCodePolicy): unknown {
  const ctxExports = shimCtxExports(ctx);
  if (!ctxExports.NimbusLoadedWorker) {
    throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
  }
  return ctxExports.NimbusLoadedWorker({
    props: { key, policy, depth: ctx.props?.depth || 0, ...loaderNetwork(ctx.props) },
  });
}

/** Props hop 2 carries: the stashed code it re-loads, and its inherited depth. */
interface NimbusLoadedWorkerProps extends NimbusLoaderDepthProps {
  key?: string;
  policy?: FacetCodePolicy;
}

/** Hop 2: the returned "worker" stub. Exposes .getEntrypoint(). */
export class NimbusLoadedWorker extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedWorkerProps> {
  /**
   * Returns a NimbusLoadedEntrypoint stub that carries the code key +
   * entrypoint name forward. The actual outer-side load + fetch happens
   * inside NimbusLoadedEntrypoint.fetch() so all outer hops run in a
   * SINGLE outer request context (the cross-request-I/O limitation is
   * real — stubs created in one outer request can't be used by another).
   */
  getEntrypoint(name?: string, options?: EntrypointOptions): unknown {
    const props: NimbusLoadedWorkerProps = this.ctx.props || {};
    const ctxExports = shimCtxExports(this.ctx);
    if (!ctxExports.NimbusLoadedEntrypoint) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return ctxExports.NimbusLoadedEntrypoint({
      props: { key: props.key, name: name || null, depth: props.depth, policy: props.policy, options, ...loaderNetwork(props) },
    });
  }

  /**
   * Pass-through to outer worker.getDurableObjectClass(name). The
   * returned stub is tied to THIS method's outer request context; if
   * the caller (the inner worker) uses the class in a later request
   * it will fail the cross-request-I/O check. For Phase 3 DO binding
   * synthesis we resolve classes directly from nimbus-wrangler's own
   * request context (which is the build-time context), not through
   * this method.
   */
  getDurableObjectClass(name: string, options?: EntrypointOptions): DurableObjectClass {
    const props: NimbusLoadedWorkerProps = this.ctx.props || {};
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const outer = _resolveStubInCurrentContext(this.env, outerLoader, props.key, loaderNetwork(props), props.policy);
    const code = props.key === undefined ? undefined : loadedCode(props.key);
    if (!outer || !code) throw new Error(`Nimbus: dynamic worker '${props.key}' is no longer loaded: the shim's cache evicted it`);
    return outer.getDurableObjectClass(name, startOptions(props.policy ?? guestFacetPolicy(code), options));
  }
}

/** A loaded entrypoint's props, as it was minted with them. */
function loadedEntrypointProps(ctx: { props?: unknown }): NimbusLoadedEntrypointProps {
  return NimbusLoadedEntrypointPropsSchema.parse(ctx.props || {});
}

/**
 * The entrypoint `entry` (a NimbusLoadedEntrypoint) stands for: its loaded
 * worker's, re-loaded in this request's context. A function of the module,
 * not a method, so a guest holding `entry` cannot reach the raw entrypoint.
 */
export async function resolveLoadedEntrypoint(
  entry: { ctx: { props?: unknown; exports?: unknown }; env: NimbusLoaderShimEnv },
): Promise<LoadedEntrypoint> {
  const { ctx, env } = entry;
  const props = loadedEntrypointProps(ctx);
  const outerLoader = env?.LOADER;
  if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
  const policy = entrypointPolicy(props);
  let outerStub: LoadedWorker;
  if (props.stage !== undefined) {
    // Staged artifact: assemble the full module map lazily, ONLY on a
    // loader miss, in THIS stateless isolate. Its SUPERVISOR is a binding
    // minted here, in this request's context, which its host holds open
    // for the whole run: a stub of the host's carried through this hop
    // into the program reset the host mid-run.
    const { stage, supervisor } = props;
    outerStub = outerLoader.get(facetLoaderKey(policy.kind, props.key, policy.limits), async () => {
      const assembled = await stagedBootAssembler()(env, stage) as WorkerCode & { modules: Record<string, unknown> };
      assertModuleMapWithinCodeLimit(assembled.modules);
      if (!supervisor) return applyFacetLimits(policy.kind, assembled, policy.limits);
      const SUPERVISOR = bindingSupervisor(supervisor, ctxExportsOf(ctx));
      return applyFacetLimits(policy.kind, workspaceOutbound({ ...assembled, env: { ...assembled.env, SUPERVISOR, ...egressMarker(supervisor) } }, supervisor), policy.limits);
    });
  } else {
    // No spec in props: resolve the ALREADY-LOADED worker. First the inner
    // Worker Loader shim's code map (nimbus-in-nimbus), else the outer
    // loader's own cache. The cache-miss callback fails loud: a spec-free
    // stub is a handle on a worker someone else loaded — re-loading it from
    // code would boot an empty isolate, a silent wrong answer.
    outerStub = _resolveStubInCurrentContext(env, outerLoader, props.key, loaderNetwork(props), policy)
      ?? outerLoader.get(facetLoaderKey(policy.kind, props.key, policy.limits), async () => {
        throw new Error(`Nimbus: dynamic worker '${props.key}' is no longer loaded (evicted?)`);
      });
  }
  const outer = await outerStub;
  if (!outer) throw new Error('Nimbus: loaded worker code missing');
  return await outer.getEntrypoint(props.name ?? undefined, startOptions(policy, props.options));
}

/**
 * Relay the inner entrypoint's Response to the caller with a LIVE body.
 * The body streams through an identity pipe and the entrypoint stub is
 * disposed only once the body finishes — materializing (arrayBuffer) here
 * buffered every routed response to stream-end, which froze SSE/chunked
 * bodies (an agent server's /event live-sync, `curl -N` loopback, external
 * preview) until the facet closed the stream.
 */
function relayNestedRpcResponse(ctx: { waitUntil(promise: Promise<unknown>): void }, ep: unknown, response: unknown): Response {
  if (!(response instanceof Response)) {
    disposeRpcResource(response);
    disposeRpcResource(ep);
    return new Response('Nimbus: loaded worker entrypoint returned a non-Response value', { status: 502 });
  }
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
  if (!response.body) {
    disposeRpcResource(ep);
    return new Response(null, init);
  }
  const { readable, writable } = new IdentityTransformStream();
  ctx.waitUntil(
    response.body
      .pipeTo(writable)
      .catch(() => {})
      .finally(() => disposeRpcResource(ep)),
  );
  return new Response(readable, init);
}

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
function callHttpHandler(ep: LoadedEntrypoint, request: Request): Promise<Response> {
  return typeof ep.handleHttpRequest === 'function'
    ? ep.handleHttpRequest(request)
    : ep.fetch(request);
}

/** Hop 3: a named-or-default entrypoint. Exposes .fetch() and .handleHttpRequest(). */
export class NimbusLoadedEntrypoint extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedEntrypointProps> {
  async handleHttpRequest(request: Request): Promise<Response> {
    const ep = await resolveLoadedEntrypoint({ ctx: this.ctx, env: this.env });
    try {
      if (typeof ep.handleHttpRequest !== 'function' && typeof ep.fetch !== 'function') {
        disposeRpcResource(ep);
        return new Response('Nimbus: loaded worker entrypoint has no HTTP request handler', { status: 502 });
      }
      const response = await callHttpHandler(ep, await materializeNestedRpcRequest(request));
      return relayNestedRpcResponse(this.ctx, ep, response);
    } catch (e) {
      disposeRpcResource(ep);
      throw e;
    }
  }

  /**
   * Forward fetch() to the outer worker's entrypoint. All three outer
   * hops (load → getEntrypoint → fetch) run in the same outer request
   * context (this method's invocation), which sidesteps the
   * cross-request-I/O limitation.
   */
  async fetch(request: Request): Promise<Response> {
    const ep = await resolveLoadedEntrypoint({ ctx: this.ctx, env: this.env });
    try {
      // Cancelled with the request it forwards (a staged run its host ended).
      const forwarded = new Request(await materializeNestedRpcRequest(request), { signal: request.signal });
      const response = await ep.fetch(forwarded);
      return relayNestedRpcResponse(this.ctx, ep, response);
    } catch (e) {
      disposeRpcResource(ep);
      throw e;
    }
  }
}

// ── Durable Object binding synthesis ────────────────────────────────────
//
// The inner-DO class registry was extracted to ./inner-do-registry.ts in
// Arc A Phase 3 to break the import cycle:
//   index.ts -> nimbus-session.ts -> nimbus-wrangler.ts -> nimbus-session.ts
// nimbus-wrangler.ts now consumes registerInnerDoClass/clearInnerDoClasses
// directly from the leaf, and this file consumes getInnerDoClass via the
// imports at the top. The Map identity is preserved across the isolate
// (still process-scoped module-level state).
//
// Inner Worker code:
//   const stub = env.MY_DO.get(env.MY_DO.idFromName('x'));
//   await stub.fetch(req);
// We synthesize env.MY_DO as a NimbusDurableObjectNamespace
// WorkerEntrypoint stub. Its .get() returns a NimbusDOStub that — on
// fetch() — resolves the class from the registry and invokes
// ctx.facets.get(facetName, {class, id}).fetch(req) in the same outer
// request context.

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
 *
 * `idFromName`, `newUniqueId`, `idFromString` and `get` answer as before, for
 * a caller that awaits them. idFromName produces prefix `name:` (a
 * deterministic hash, innerDoIdFromName); newUniqueId uses `uniq:`; the
 * prefixes keep the two id spaces distinct.
 */
export class NimbusDurableObjectNamespace extends WorkerEntrypoint<object, NimbusDoNamespaceProps> {
  /** Stable string id derived from a name. Hash is deterministic. */
  idFromName(name: string): string {
    return innerDoIdFromName(name);
  }

  /** Fresh random id (matches DurableObjectNamespace.newUniqueId()). */
  newUniqueId(): string {
    return 'uniq:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Accept-through for an already-formatted id. */
  idFromString(s: string): string {
    return s;
  }

  /** Return a stub bound to the given id. */
  get(id: string): unknown {
    const ctxExports = shimCtxExports(this.ctx);
    if (!ctxExports.NimbusDOStub) throw new Error('Nimbus: ctx.exports.NimbusDOStub unavailable');
    const props: NimbusDoNamespaceProps = this.ctx.props || {};
    return ctxExports.NimbusDOStub({
      props: {
        bindingName: props.bindingName,
        supervisorDoId: props.supervisorDoId,
        route: props.route,
        id: String(id),
      },
    });
  }

  /**
   * The member of object `id` at `path` (names from the object down), called
   * with `args`: its answer, or what it throws, as the object gave it.
   */
  callOn(id: string, path: string[], args: unknown[]): Promise<unknown> {
    return innerDoMember(this.env, { ...(this.ctx.props || {}), id: String(id) }, path, args);
  }

  /** The member of object `id` at `path`, read. */
  getOn(id: string, path: string[]): Promise<unknown> {
    return innerDoMember(this.env, { ...(this.ctx.props || {}), id: String(id) }, path, null);
  }
}

/** Props the DO stub carries: which binding, which supervisor, which id. */
interface NimbusDoStubProps extends NimbusDoNamespaceProps {
  id?: string;
}

/**
 * The session Durable Object, through the composed host namespace, and its
 * one supervisorOp entrypoint: a host forwards envelopes, not private _rpc*
 * methods. Throws when the binding cannot reach it; `release` drops the stub.
 */
function supervisorOf(env: object | undefined, props: NimbusDoStubProps): { dispatch: HostOpDispatch; release(): void } {
  const supervisorDoId = String(props.supervisorDoId || '');
  if (!supervisorDoId) throw new Error('supervisorDoId missing');
  let stub: DurableObjectStub | null = null;
  try {
    const ns = hostNamespaceBinding(env ?? {}, 'NimbusDOStub', props.route);
    stub = ns.get(ns.idFromString(supervisorDoId));
    const held = stub;
    return { dispatch: hostOpDispatch(stub, 'NimbusDOStub', props.route), release: () => disposeRpcResource(held) };
  } catch (e) {
    disposeRpcResource(stub);
    throw e;
  }
}

/** What the session's innerDoFetch answers: the object's response, as fields. */
export interface InnerDoFetchAnswer {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

function isInnerDoFetchAnswer(value: unknown): value is InnerDoFetchAnswer {
  return value !== null && typeof value === 'object'
    && 'status' in value && typeof value.status === 'number'
    && 'statusText' in value && typeof value.statusText === 'string'
    && 'headers' in value && Array.isArray(value.headers)
    && 'body' in value && (value.body === null || value.body instanceof ArrayBuffer);
}

/**
 * The inner object's fetch: the request forwarded whole (method, body,
 * headers) as fields the session reconstructs, and its response rebuilt here
 * from the fields the session answers. A binding that cannot reach the
 * session answers 500.
 */
async function innerDoFetch(env: object | undefined, props: NimbusDoStubProps, request: Request): Promise<Response> {
  let supervisor: ReturnType<typeof supervisorOf>;
  try {
    supervisor = supervisorOf(env, props);
  } catch (e) {
    return new Response(`Nimbus: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
  try {
    const body = request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : null;
    const headerList: [string, string][] = [];
    request.headers.forEach((v, k) => { headerList.push([k, v]); });
    return await useRpcResource(
      supervisor.dispatch({
        op: 'innerDoFetch',
        args: [{ bindingName: String(props.bindingName || ''), id: String(props.id || ''), method: request.method, url: request.url, headers: headerList, body }],
      }),
      (res) => {
        if (!isInnerDoFetchAnswer(res)) {
          return new Response('Nimbus: innerDoFetch returned an invalid result', { status: 502 });
        }
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
      },
    );
  } finally {
    supervisor.release();
  }
}

/**
 * A member of the inner object, called with `args` or read (`args` null): the
 * session reaches it on the object's facet and answers what it answered (a
 * stub, function or stream travels as one) or rejects with what it threw,
 * type and message kept.
 */
async function innerDoMember(env: object | undefined, props: NimbusDoStubProps, path: string[], args: unknown[] | null): Promise<unknown> {
  const supervisor = supervisorOf(env, props);
  try {
    return await supervisor.dispatch({
      op: 'innerDoCall',
      args: [{ bindingName: String(props.bindingName || ''), id: String(props.id || ''), path, args }],
    });
  } finally {
    supervisor.release();
  }
}

/**
 * A Durable-Object-namespace-stub for a specific id, for a caller of the
 * binding's own `get`: its fetch. The important invariant: EVERY call
 * resolves the inner DO class via getInnerDoClass() (./inner-do-registry.js)
 * and spins up / attaches to a facet via the supervisor's ctx.facets in the
 * SAME outer request context — never reusing stubs across requests.
 */
export class NimbusDOStub extends WorkerEntrypoint<object, NimbusDoStubProps> {
  async fetch(request: Request): Promise<Response> {
    return innerDoFetch(this.env, this.ctx.props || {}, request);
  }
}

// ── KV, D1 and R2 bindings ──────────────────────────────────────────────────
//
// Inner Worker code:
//   await env.KV.put('k', 'v');
//   await env.DB.prepare('SELECT ?').bind(1).first();
//   await (await env.BUCKET.get('k')).text();
// Each binding is minted by the session for one store of one project: a KV
// namespace or an R2 bucket (its files under the project's .nimbus, read
// and written as the process that started the server) or a D1 database
// (a facet of the session, its own SQLite). The props name that store and
// nothing a guest supplies does, so a binding reaches its own store only.
// Each call is a supervisor op the session serves (kvCall, d1Query,
// r2Call). The D1 and R2 bindings are not the Worker's env.DB and
// env.BUCKET as they are: inner-storage-env.ts makes those over them.

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

/** The ops a storage binding sends, each with the call it carries. */
type StorageOp =
  | { op: 'kvCall'; call: KvCall }
  | { op: 'r2Call'; call: R2Call }
  | { op: 'd1Query'; call: D1QuerySql[] };

/**
 * `op` sent to the session for the binding's own store, as the props name
 * it: the session's answer, or what it threw.
 */
async function storageOp(env: object, props: NimbusStorageProps | undefined, usage: string, { op, call }: StorageOp): ReturnType<HostOpDispatch> {
  const doId = props?.doId;
  const root = props?.root;
  const store = props?.store;
  if (!doId || root === undefined || !store) throw new Error(`Nimbus: this ${usage} binding was minted without its store`);
  let stub: DurableObjectStub | null = null;
  try {
    const ns = hostNamespaceBinding(env, usage, props?.route);
    stub = ns.get(ns.idFromString(doId));
    return await hostOpDispatch(stub, usage, props?.route)({
      op,
      args: [{ root, store }, call],
      ...(props?.cred === undefined ? {} : { cred: props.cred }),
    });
  } finally {
    disposeRpcResource(stub);
  }
}

/** env.KV: a KV namespace, the methods of Cloudflare's API and nothing else. */
export class NimbusKVNamespace extends WorkerEntrypoint<object, NimbusStorageProps> {
  get(key: string | string[], options?: string | KvGetOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusKVNamespace', { op: 'kvCall', call: { method: 'get', key, options } });
  }

  getWithMetadata(key: string | string[], options?: string | KvGetOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusKVNamespace', { op: 'kvCall', call: { method: 'getWithMetadata', key, options } });
  }

  put(key: string, value: KvPutValue, options?: KvPutOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusKVNamespace', { op: 'kvCall', call: { method: 'put', key, value, options } });
  }

  delete(key: string) {
    return storageOp(this.env, this.ctx.props, 'NimbusKVNamespace', { op: 'kvCall', call: { method: 'delete', key } });
  }

  list(options?: KvListOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusKVNamespace', { op: 'kvCall', call: { method: 'list', options } });
  }
}

/** A D1 database's binding: D1's own binding contract, `query`, and nothing else. */
export class NimbusD1Binding extends WorkerEntrypoint<object, NimbusStorageProps> {
  /**
   * All of `request`'s queries, run in one transaction, answered with the
   * database's bookmark after them. The request's bookmark is not sent on:
   * the database has one copy, which every bookmark is already met by.
   */
  async query(request: D1QueryRequest): Promise<D1QueryResponse> {
    const queries = Array.isArray(request?.queries) ? request.queries : [];
    const answer = await storageOp(this.env, this.ctx.props, 'NimbusD1Binding', { op: 'd1Query', call: queries });
    if (!isD1QueryResponse(answer)) throw new Error('Nimbus: d1Query returned an invalid result');
    return answer;
  }
}

function isD1QueryResponse(value: unknown): value is D1QueryResponse {
  return value !== null && typeof value === 'object' && 'success' in value
    && (value.success === true ? 'results' in value : 'error' in value);
}

/** An R2 bucket's binding: the methods of Cloudflare's API, taking and answering the fields its objects are made of. */
export class NimbusR2Bucket extends WorkerEntrypoint<object, NimbusStorageProps> {
  head(key: string) {
    return storageOp(this.env, this.ctx.props, 'NimbusR2Bucket', { op: 'r2Call', call: { method: 'head', key } });
  }

  get(key: string, options: R2WireGetOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusR2Bucket', { op: 'r2Call', call: { method: 'get', key, options } });
  }

  put(key: string, value: R2PutBody, options: R2WirePutOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusR2Bucket', { op: 'r2Call', call: { method: 'put', key, value, options } });
  }

  delete(keys: string | string[]) {
    return storageOp(this.env, this.ctx.props, 'NimbusR2Bucket', { op: 'r2Call', call: { method: 'delete', keys } });
  }

  list(options: R2WireListOptions) {
    return storageOp(this.env, this.ctx.props, 'NimbusR2Bucket', { op: 'r2Call', call: { method: 'list', options } });
  }
}
