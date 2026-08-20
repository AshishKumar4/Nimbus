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
import { disposeRpcResource, useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { supervisorEntrypoint, supervisorEntrypointName } from './ctx-exports.js';
import { requireStagedBootAssembler } from './process-fabric.js';
import { assertModuleMapWithinCodeLimit } from './budgets.js';
import type { EntrypointLoopbackFactory } from './ctx-exports.js';
import type { WorkerCode } from './vendor/types.js';

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

// ── Inner-Worker loopback bindings ────────────────────────────────────
//
// These WorkerEntrypoint classes are top-level exports so that ctx.exports
// auto-populates Service Bindings for them (enable_ctx_exports compat
// flag is already enabled via default compatibility_date 2026-04-01).
//
// They are re-exported from src/index.ts so wrangler detects them as
// reachable from the entry file and bundles their classes.
//
// Usage pattern (in nimbus-wrangler.ts):
//   ctx.exports.NimbusAssetsRPC({ props: { vfsRoot, assetsDir } })
// produces a Service Binding stub that can be placed in the inner
// Worker's `env` under whatever binding name the user declared in
// wrangler.jsonc's `assets.binding` (typically "ASSETS").

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
export class NimbusAssetsRPC extends WorkerEntrypoint<NimbusAssetsEnv, NimbusAssetsProps> {
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

    // Resolve the supervisor DO stub so we can call its VFS read RPC.
    const ns = this.env.NIMBUS_SESSION;
    if (!ns || !doId) {
      return new Response('ASSETS binding not wired: missing NIMBUS_SESSION or doId', { status: 500 });
    }
    const stub = ns.get(ns.idFromString(doId));

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
            stub._rpcReadFileBytes(candidate),
            (bytes: ArrayBuffer | Uint8Array | null) => {
              if (!bytes || bytes.byteLength === undefined) return null;
              return new Response(bytes, {
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

/**
 * Module-level map of loaded worker CODE (not stubs), keyed by a random
 * id. WorkerStubs are I/O objects tied to a request context, so they
 * can't be stashed for later use ("Cannot perform I/O on behalf of a
 * different request"). Storing the code instead lets each new outer
 * request re-load the worker in its own context via env.LOADER.get(id)
 * — workerd caches by id so repeated loads are essentially free.
 *
 * H7 (memory accounting cleanup). The pre-fix comment said "GC isn't
 * needed" because "inner stubs that reference them die with the DO."
 * That was true for STUBS but FALSE for these CODE entries: nothing
 * deletes them. `wrangler dev`'s rebuild-on-save loop calls load()
 * on every save, so the Map grows without bound until the supervisor
 * isolate is evicted (or hits the 128 MiB hard cap and crashes).
 *
 * Fix: hard-cap LRU. The Map's iteration order is insertion order;
 * we re-insert on every read AND eviction-on-overflow drops the
 * oldest entry. _LOADED_CODES_MAX is a documented architectural cap
 * (32 entries). Eviction count is observable via getLoadedCodesStats()
 * which the diag endpoint surfaces.
 *
 * Why 32? wrangler dev's typical rebuild burst is < 5 entries before
 * the user notices and stops typing. 32 covers a power user's
 * iteration cycle and a reasonable amount of `LOADER.get(id, cb)`
 * memoization without exposing more than a few MiB of code text in
 * the worst case (typical user-worker bundle: 50-300 KiB; 32 × 300 KiB
 * = ~10 MiB ceiling — well under the 64 MiB supervisor budget).
 */
const _NIMBUS_LOADED_CODES: Map<string, WorkerCode> = new Map();
const _LOADED_CODES_MAX = 32;
let _loadedCodesEvictions = 0;

const NimbusLoadedEntrypointPropsSchema = z.object({
  key: z.string().min(1),
  name: z.string().nullable().optional(),
  depth: z.number().int().nonnegative().optional(),
  supervisor: z.object({
    doId: z.string().min(1),
    pid: z.number().int().nonnegative(),
    writerId: z.string().uuid(),
  }).optional(),
  /**
   * Staged-artifact spec, for a ONE-SHOT run. The module map — ~23 MB for
   * Nimbus's largest stage — is assembled HERE, in this stateless
   * entrypoint's isolate, on the Worker-Loader cache-miss path, so a
   * one-shot run never materializes the artifact sources anywhere else.
   * Validated by the registered assembler.
   */
  stage: z.unknown().optional(),
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

/**
 * Insert OR refresh a key in the LRU. New keys may evict the oldest
 * entry if at the cap; existing keys are re-inserted to update their
 * recency.
 */
function _loadedCodesPut(key: string, code: WorkerCode): void {
  // If the key already exists, delete first so re-insertion lands at
  // the MRU end of the iteration order (LRU-style refresh).
  if (_NIMBUS_LOADED_CODES.has(key)) {
    _NIMBUS_LOADED_CODES.delete(key);
  } else if (_NIMBUS_LOADED_CODES.size >= _LOADED_CODES_MAX) {
    // Evict the LRU entry — the first key in insertion order.
    const oldest = _NIMBUS_LOADED_CODES.keys().next();
    if (!oldest.done) {
      _NIMBUS_LOADED_CODES.delete(oldest.value);
      _loadedCodesEvictions++;
    }
  }
  _NIMBUS_LOADED_CODES.set(key, code);
}

function _loadedCodesGet(key: string): WorkerCode | undefined {
  const v = _NIMBUS_LOADED_CODES.get(key);
  if (v === undefined) return undefined;
  // LRU-refresh on read so memoization-style usage (LOADER.get(id, cb)
  // re-hitting the same id repeatedly) keeps the entry warm.
  _NIMBUS_LOADED_CODES.delete(key);
  _NIMBUS_LOADED_CODES.set(key, v);
  return v;
}

/**
 * Diagnostic surface for /api/_diag/memory. Returns a snapshot of
 * the Map state — entry count, configured cap, eviction counter
 * since isolate boot. Pure read; no I/O.
 */
export function getLoadedCodesStats(): { entries: number; maxEntries: number; evictions: number } {
  return {
    entries: _NIMBUS_LOADED_CODES.size,
    maxEntries: _LOADED_CODES_MAX,
    evictions: _loadedCodesEvictions,
  };
}

function _genStubId(): string {
  return 'ldr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Look up the stored code by key and create a fresh outer WorkerStub
 * in the CURRENT request context. Uses LOADER.get(id, cb) so repeated
 * calls reuse the same dynamic worker rather than spawning new ones.
 */
function _resolveStubInCurrentContext(
  outerLoader: OuterWorkerLoader,
  key: string | undefined,
): LoadedWorker | null {
  if (key === undefined) return null;
  const code = _loadedCodesGet(key);
  if (!code) return null;
  return outerLoader.get(key, async () => code);
}

/** Props every Worker-Loader hop carries: how deep this Nimbus already is. */
interface NimbusLoaderDepthProps {
  depth?: number;
}

/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export class NimbusLoaderRPC extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoaderDepthProps> {
  private _currentDepth(): number {
    const d = this.ctx.props?.depth;
    return typeof d === 'number' && d >= 0 ? d : 0;
  }

  private _maxDepth(): number {
    const raw = this.env?.NIMBUS_INNER_LOADER_DEPTH;
    const parsed = raw ? parseInt(String(raw), 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  }

  private _assertDepthOk(): void {
    const depth = this._currentDepth();
    const max = this._maxDepth();
    if (depth >= max) {
      throw new Error(
        `Nimbus: refusing to spawn inner Worker Loader (depth=${depth + 1}, max=${max}). ` +
        `Set NIMBUS_INNER_LOADER_DEPTH to raise the cap or break the recursion.`,
      );
    }
  }

  /**
   * Inner: env.LOADER.load(code). Stashes the CODE (not a stub — stubs
   * are I/O-bound to the calling request context) and returns a
   * NimbusLoadedWorker RPC stub. Each downstream call re-loads the
   * worker in its own request context via LOADER.get(key, cb).
   */
  load(code: WorkerCode): unknown {
    this._assertDepthOk();
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    // Validate by loading once in THIS context (fails fast on bad code).
    // The stub is discarded; downstream calls re-load fresh in their
    // own context.
    outerLoader.load(code);
    const key = _genStubId();
    _loadedCodesPut(key, code);
    const ctxExports = shimCtxExports(this.ctx);
    if (!ctxExports.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: this.ctx.props?.depth || 0 },
    });
  }

  /**
   * Inner: env.LOADER.get(id, callback). The inner's callback returns
   * a code object; we treat `id` as the outer cache key (prefixed so
   * it doesn't collide with load()-generated keys).
   */
  async get(id: string, callback: () => WorkerCode | Promise<WorkerCode>): Promise<unknown> {
    this._assertDepthOk();
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const key = 'get:' + id;
    if (_loadedCodesGet(key) === undefined) {
      const code = await callback();
      _loadedCodesPut(key, code);
    }
    const ctxExports = shimCtxExports(this.ctx);
    if (!ctxExports.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: this.ctx.props?.depth || 0 },
    });
  }
}

/** Props hop 2 carries: the stashed code it re-loads, and its inherited depth. */
interface NimbusLoadedWorkerProps extends NimbusLoaderDepthProps {
  key?: string;
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
  getEntrypoint(name?: string): unknown {
    const props: NimbusLoadedWorkerProps = this.ctx.props || {};
    const ctxExports = shimCtxExports(this.ctx);
    if (!ctxExports.NimbusLoadedEntrypoint) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return ctxExports.NimbusLoadedEntrypoint({
      props: { key: props.key, name: name || null, depth: props.depth },
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
  getDurableObjectClass(name: string): DurableObjectClass {
    const props: NimbusLoadedWorkerProps = this.ctx.props || {};
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const outer = _resolveStubInCurrentContext(outerLoader, props.key);
    if (!outer) throw new Error('Nimbus: loaded worker code missing (key=' + props.key + ')');
    return outer.getDurableObjectClass(name);
  }
}

/** Hop 3: a named-or-default entrypoint. Exposes .fetch(). */
export class NimbusLoadedEntrypoint extends WorkerEntrypoint<NimbusLoaderShimEnv, NimbusLoadedEntrypointProps> {
  _props(): NimbusLoadedEntrypointProps {
    return NimbusLoadedEntrypointPropsSchema.parse(this.ctx.props || {});
  }

  async _supervisorBinding(props: NimbusLoadedEntrypointProps): Promise<unknown> {
    if (!props.supervisor) return undefined;
    const factory = supervisorEntrypoint(ctxExportsOf(this.ctx));
    if (!factory) {
      throw new Error(
        `Nimbus: ctx.exports.${supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`,
      );
    }
    return await factory({ props: props.supervisor });
  }

  async _resolveEntrypoint(): Promise<LoadedEntrypoint> {
    const props = this._props();
    const outerLoader = this.env?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    let outerStub: LoadedWorker;
    if (props.stage !== undefined) {
      // Staged artifact: assemble the full module map lazily, ONLY on a
      // loader miss, in THIS stateless isolate. The facet's SUPERVISOR
      // binding is created in this request context — the caller holds the
      // one-shot fetch open for the whole run, which keeps that context
      // alive.
      const stage = props.stage;
      outerStub = outerLoader.get(props.key, async () => {
        const assembled = await requireStagedBootAssembler()(this.env, stage);
        assertModuleMapWithinCodeLimit(
          (assembled as { modules?: Record<string, unknown> }).modules ?? {},
        );
        const supervisorBinding = await this._supervisorBinding(props);
        if (!supervisorBinding) return assembled;
        return { ...assembled, env: { SUPERVISOR: supervisorBinding } };
      });
    } else {
      // No spec in props: resolve the ALREADY-LOADED worker. First the inner
      // Worker Loader shim's code map (nimbus-in-nimbus), else the outer
      // loader's own cache. The cache-miss callback fails loud: a spec-free
      // stub is a handle on a worker someone else loaded — re-loading it from
      // code would boot an empty isolate, a silent wrong answer.
      outerStub = _resolveStubInCurrentContext(outerLoader, props.key)
        ?? outerLoader.get(props.key, async () => {
          throw new Error(`Nimbus: dynamic worker '${props.key}' is no longer loaded (evicted?)`);
        });
    }
    const outer = await outerStub;
    if (!outer) throw new Error('Nimbus: loaded worker code missing');
    return await (props.name ? outer.getEntrypoint(props.name) : outer.getEntrypoint());
  }

  /**
   * Relay the inner entrypoint's Response to the caller with a LIVE body.
   * The body streams through an identity pipe and the entrypoint stub is
   * disposed only once the body finishes — materializing (arrayBuffer) here
   * buffered every routed response to stream-end, which froze SSE/chunked
   * bodies (an agent server's /event live-sync, `curl -N` loopback, external
   * preview) until the facet closed the stream.
   */
  private _relayNestedRpcResponse(ep: unknown, response: unknown): Response {
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
    this.ctx.waitUntil(
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
  private _callHttpHandler(ep: LoadedEntrypoint, request: Request): Promise<Response> {
    return typeof ep.handleHttpRequest === 'function'
      ? ep.handleHttpRequest(request)
      : ep.fetch(request);
  }

  async handleHttpRequest(request: Request): Promise<Response> {
    const ep = await this._resolveEntrypoint();
    try {
      if (typeof ep.handleHttpRequest !== 'function' && typeof ep.fetch !== 'function') {
        disposeRpcResource(ep);
        return new Response('Nimbus: loaded worker entrypoint has no HTTP request handler', { status: 502 });
      }
      const response = await this._callHttpHandler(ep, await materializeNestedRpcRequest(request));
      return this._relayNestedRpcResponse(ep, response);
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
    const ep = await this._resolveEntrypoint();
    try {
      const response = await ep.fetch(await materializeNestedRpcRequest(request));
      return this._relayNestedRpcResponse(ep, response);
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
export class NimbusDurableObjectNamespace extends WorkerEntrypoint<unknown, NimbusDoNamespaceProps> {
  /** Stable string id derived from a name. Hash is deterministic. */
  idFromName(name: string): string {
    // Simple 64-bit-ish FNV-style hash → hex. Stable across runs;
    // distinct names → distinct strings; same name → same string.
    let h1 = 0xdeadbeef ^ name.length;
    let h2 = 0x41c6ce57 ^ name.length;
    for (let i = 0; i < name.length; i++) {
      const ch = name.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const high = (h1 >>> 0).toString(16).padStart(8, '0');
    const low = (h2 >>> 0).toString(16).padStart(8, '0');
    return 'name:' + high + low;
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
        id: String(id),
      },
    });
  }
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
export class NimbusDOStub extends WorkerEntrypoint<NimbusInnerDoEnv, NimbusDoStubProps> {
  /**
   * Resolve the supervisor DO from env.NIMBUS_SESSION and route through
   * its _rpcInnerDoFetch RPC method, which runs ctx.facets.get(...) in
   * its own context and forwards the request.
   */
  async fetch(request: Request): Promise<Response> {
    const props: NimbusDoStubProps = this.ctx.props || {};
    const ns = this.env?.NIMBUS_SESSION;
    if (!ns) return new Response('Nimbus: env.NIMBUS_SESSION unavailable', { status: 500 });
    const supervisorDoId = String(props.supervisorDoId || '');
    if (!supervisorDoId) return new Response('Nimbus: supervisorDoId missing', { status: 500 });
    const bindingName = String(props.bindingName || '');
    const id = String(props.id || '');
    const stub = ns.get(ns.idFromString(supervisorDoId));
    // Forward the full request (method, body, headers preserved) by
    // serializing what's needed and reconstructing on the other side.
    // The supervisor reconstitutes the Request from these fields and
    // invokes the facet.
    const body = request.method !== 'GET' && request.method !== 'HEAD'
      ? await request.arrayBuffer()
      : null;
    const headerList: [string, string][] = [];
    request.headers.forEach((v, k) => { headerList.push([k, v]); });
    try {
      return await useRpcResource(
        stub._rpcInnerDoFetch({
          bindingName,
          id,
          method: request.method,
          url: request.url,
          headers: headerList,
          body,
        }),
        (res) =>
          new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
      );
    } finally {
      disposeRpcResource(stub);
    }
  }
}
