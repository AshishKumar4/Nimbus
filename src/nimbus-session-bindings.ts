/**
 * nimbus-session-bindings.ts — W10 inner-Worker + assets binding shims.
 *
 * Top-level WorkerEntrypoint classes that workerd auto-populates as
 * Service Bindings via `ctx.exports` (enable_ctx_exports compat flag).
 * These classes have NO interaction with `NimbusSession` instances except
 * through RPC stubs (env.NIMBUS_SESSION.idFromString(doId).get()...) — they
 * are top-level exports for runtime wiring, colocated here for grep-ability.
 *
 * Originally lines 4934-5341 of pre-Phase-1 src/nimbus-session.ts (before
 * any refactor commits); lines 4513-4957 in the post-S1 source.
 * Per audit/sections/SESSION-REFACTOR-PLAN.md §B.3.9 + S2.
 *
 * Exports re-shipped from nimbus-session.ts so existing import paths work:
 *   NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker,
 *   NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub.
 *
 * **Bundle-graph note** (per plan §B.4 + §VI.9): these classes MUST remain
 * reachable from `src/index.ts`'s entry graph for wrangler to bundle them.
 * The re-export hub in nimbus-session.ts preserves that linkage.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

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
export class NimbusAssetsRPC extends WorkerEntrypoint {
  /**
   * Fetch a static asset. Called by the inner Worker as
   * `env.ASSETS.fetch(request)`. The request URL's pathname is used to
   * resolve a file under the configured assets directory.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const propsAny = (this.ctx as any).props || {};
    const vfsRoot = String(propsAny.vfsRoot || '');
    const assetsDir = String(propsAny.assetsDir || '').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const doId = String(propsAny.doId || '');

    // Normalize pathname: no leading /, drop .. segments entirely.
    let clean = url.pathname.replace(/^\/+/, '');
    const parts = clean.split('/').filter((p) => p && p !== '..' && p !== '.');
    clean = parts.join('/');

    // Resolve the supervisor DO stub so we can call its VFS read RPC.
    const ns = (this.env as any).NIMBUS_SESSION;
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

    for (const candidate of candidates) {
      try {
        const bytes = await stub._rpcReadFileBytes(candidate);
        if (bytes && bytes.byteLength !== undefined) {
          return new Response(bytes, {
            status: 200,
            headers: {
              'Content-Type': mimeTypeForPath(candidate),
              'Cache-Control': 'no-store',
            },
          });
        }
      } catch { /* try next */ }
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
 * Map entries live as long as the outer DO isolate; inner stubs that
 * reference them die with the DO, so GC isn't needed.
 */
const _NIMBUS_LOADED_CODES: Map<string, any> = new Map();

function _genStubId(): string {
  return 'ldr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Look up the stored code by key and create a fresh outer WorkerStub
 * in the CURRENT request context. Uses LOADER.get(id, cb) so repeated
 * calls reuse the same dynamic worker rather than spawning new ones.
 */
function _resolveStubInCurrentContext(outerLoader: any, key: string): any | null {
  const code = _NIMBUS_LOADED_CODES.get(key);
  if (!code) return null;
  return outerLoader.get(key, async () => code);
}

/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export class NimbusLoaderRPC extends WorkerEntrypoint {
  private _currentDepth(): number {
    const d = (this.ctx as any).props?.depth;
    return typeof d === 'number' && d >= 0 ? d : 0;
  }

  private _maxDepth(): number {
    const raw = (this.env as any)?.NIMBUS_INNER_LOADER_DEPTH;
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
  load(code: any): any {
    this._assertDepthOk();
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    // Validate by loading once in THIS context (fails fast on bad code).
    // The stub is discarded; downstream calls re-load fresh in their
    // own context.
    outerLoader.load(code);
    const key = _genStubId();
    _NIMBUS_LOADED_CODES.set(key, code);
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: (this.ctx as any).props?.depth || 0 },
    });
  }

  /**
   * Inner: env.LOADER.get(id, callback). The inner's callback returns
   * a code object; we treat `id` as the outer cache key (prefixed so
   * it doesn't collide with load()-generated keys).
   */
  async get(id: string, callback: () => any): Promise<any> {
    this._assertDepthOk();
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const key = 'get:' + id;
    if (!_NIMBUS_LOADED_CODES.has(key)) {
      const code = await callback();
      _NIMBUS_LOADED_CODES.set(key, code);
    }
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: (this.ctx as any).props?.depth || 0 },
    });
  }
}

/** Hop 2: the returned "worker" stub. Exposes .getEntrypoint(). */
export class NimbusLoadedWorker extends WorkerEntrypoint {
  /**
   * Returns a NimbusLoadedEntrypoint stub that carries the code key +
   * entrypoint name forward. The actual outer-side load + fetch happens
   * inside NimbusLoadedEntrypoint.fetch() so all outer hops run in a
   * SINGLE outer request context (the cross-request-I/O limitation is
   * real — stubs created in one outer request can't be used by another).
   */
  getEntrypoint(name?: string): any {
    const propsAny = (this.ctx as any).props || {};
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedEntrypoint) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return ctxExports.NimbusLoadedEntrypoint({
      props: { key: propsAny.key, name: name || null, depth: propsAny.depth },
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
  getDurableObjectClass(name: string): any {
    const propsAny = (this.ctx as any).props || {};
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const outer = _resolveStubInCurrentContext(outerLoader, propsAny.key);
    if (!outer) throw new Error('Nimbus: loaded worker code missing (key=' + propsAny.key + ')');
    return outer.getDurableObjectClass(name);
  }
}

/** Hop 3: a named-or-default entrypoint. Exposes .fetch(). */
export class NimbusLoadedEntrypoint extends WorkerEntrypoint {
  /**
   * Forward fetch() to the outer worker's entrypoint. All three outer
   * hops (load → getEntrypoint → fetch) run in the same outer request
   * context (this method's invocation), which sidesteps the
   * cross-request-I/O limitation.
   */
  async fetch(request: Request): Promise<Response> {
    const propsAny = (this.ctx as any).props || {};
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) return new Response('Nimbus: outer env.LOADER missing', { status: 500 });
    const outer = _resolveStubInCurrentContext(outerLoader, propsAny.key);
    if (!outer) return new Response('Nimbus: loaded worker code missing', { status: 502 });
    const ep = propsAny.name ? outer.getEntrypoint(propsAny.name) : outer.getEntrypoint();
    return ep.fetch(request);
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
export class NimbusDurableObjectNamespace extends WorkerEntrypoint {
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
  get(id: string): any {
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusDOStub) throw new Error('Nimbus: ctx.exports.NimbusDOStub unavailable');
    const propsAny = (this.ctx as any).props || {};
    return ctxExports.NimbusDOStub({
      props: {
        bindingName: propsAny.bindingName,
        supervisorDoId: propsAny.supervisorDoId,
        id: String(id),
      },
    });
  }
}

/**
 * A Durable-Object-namespace-stub for a specific id. Exposes fetch()
 * and will, if we later need it, forward RPC method calls through a
 * dispatch helper. The important invariant: EVERY call resolves the
 * inner DO class via getInnerDoClass() (./inner-do-registry.js) and
 * spins up / attaches to a facet via the supervisor's ctx.facets in
 * the SAME outer request context — never reusing stubs across requests.
 */
export class NimbusDOStub extends WorkerEntrypoint {
  /**
   * Resolve the supervisor DO from env.NIMBUS_SESSION and route through
   * its _rpcInnerDoFetch RPC method, which runs ctx.facets.get(...) in
   * its own context and forwards the request.
   */
  async fetch(request: Request): Promise<Response> {
    const propsAny = (this.ctx as any).props || {};
    const ns = (this.env as any)?.NIMBUS_SESSION;
    if (!ns) return new Response('Nimbus: env.NIMBUS_SESSION unavailable', { status: 500 });
    const supervisorDoId = String(propsAny.supervisorDoId || '');
    if (!supervisorDoId) return new Response('Nimbus: supervisorDoId missing', { status: 500 });
    const bindingName = String(propsAny.bindingName || '');
    const id = String(propsAny.id || '');
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
    const res = await stub._rpcInnerDoFetch({
      bindingName,
      id,
      method: request.method,
      url: request.url,
      headers: headerList,
      body,
    });
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}
