/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: full EventEmitter
 *   - stream: real Readable/Writable/Transform/Duplex with backpressure
 *   - crypto: createHash (FNV-1a sync, SubtleCrypto async), randomBytes/UUID
 *   - zlib: real gzip/gunzip/deflate via CompressionStream/DecompressionStream
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, util, url, querystring, string_decoder, readline, tty, timers
 *
 * VFS access: sync reads use __vfsBundle (pre-bundled by FacetManager);
 * async reads use the supervisor bridge as their source of truth whenever it
 * is available. Sync writes stay in __vfsWrites until an async observation or
 * process completion flushes them to the supervisor.
 */
/**
 * Generate the shared shim block that goes inside both the DO-facet and
 * entrypoint runner code.  The returned string is raw JS (no wrapping).
 *
 * At runtime the following variables must exist in scope:
 *   - __vfsBundle: Record<string, string>  (path→utf8 content)
 *   - __vfsWrites: Record<string, string | Uint8Array> (sync writes / failed async writes)
 *   - __vfsDirs:   Record<string, boolean> (dirs created)
 *   - the shared VFS write ledger source evaluated in the same scope
 *   - cwd: string
 *   - argv, env, filename, dirname: from args
 *   - stdout, stderr, exitCode: capture variables
 */
import { generateStreamsCode } from '@nimbus-sh/core/runtime/streams.js';
import { generateSqliteShimCode } from './sqlite-shim.js';
import { generateUndiciShimCode } from '@nimbus-sh/core/runtime/undici-shim.js';
import { getExportsResolverJS } from '@nimbus-sh/core/_shared/exports-resolver.js';
import { getTypescriptSpecifiersJS } from '@nimbus-sh/core/_shared/typescript-specifiers.js';
import { NIMBUS_AI_CREDENTIAL_HEADERS, NIMBUS_AI_TOKEN_ENV } from '@nimbus-sh/core/_shared/ai-egress.js';
import { FACET_PROVIDED_PACKAGES, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES, MAX_RPC_SAFE_PAYLOAD_BYTES, NIMBUS_AI_GATEWAY_PORT, NODE_VERSION, NODE_VERSIONS, } from '@nimbus-sh/core/constants.js';
const STREAMS_CODE = generateStreamsCode();
const SQLITE_SHIM_CODE = generateSqliteShimCode();
const UNDICI_SHIM_CODE = generateUndiciShimCode();
const FACET_PROVIDED_PACKAGES_LITERAL = JSON.stringify(FACET_PROVIDED_PACKAGES);
const EXPORTS_RESOLVER_JS = getExportsResolverJS();
const TYPESCRIPT_SPECIFIERS_JS = getTypescriptSpecifiersJS();
// Node version fingerprint. Single source of truth in constants.ts.
// Interpolated as JS literals into the emitted process shim. See
// constants.ts for the rationale (create-astro preflight, etc.).
const NODE_VERSION_LITERAL = JSON.stringify(NODE_VERSION);
const NODE_VERSIONS_LITERAL = JSON.stringify(NODE_VERSIONS);
// AI-egress mediation policy, interpolated for the same reason: the emitted
// shim is a string and cannot import, so the constants it decides with come
// from _shared/ai-egress.ts at build time rather than being written twice.
const AI_TOKEN_ENV_LITERAL = JSON.stringify(NIMBUS_AI_TOKEN_ENV);
const AI_CREDENTIAL_HEADERS_LITERAL = JSON.stringify(NIMBUS_AI_CREDENTIAL_HEADERS);
export function generateShimsCode() {
    return `
// ═══════════════════════════════════════════════════════════════════════
// ──  Format helper ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
function __fmt(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function __nimbusDisposeRpcResult(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") { try { dispose.call(value); } catch {} }
}

// ═══════════════════════════════════════════════════════════════════════
// ──  in-flight async operations ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Node keeps a process alive for its ACTIVE REQUESTS — a pending fetch, a
// pending fs call, a running child — not for pending promises. The facet's
// entry drain cannot learn that by watching promises: \`await\` resolves
// through PerformPromiseThen, which never calls the patched
// Promise.prototype.then, so a floating \`(async () => { await fetch(u);
// console.log(x); })()\` looks finished the instant its synchronous part
// returns and the rest of the program is dropped on the floor.
//
// Every external operation a facet can start crosses one of two seams:
// globalThis.fetch (network, in-session loopback, AI egress — plus reading
// the body of the Response it returns) and the supervisor RPC helper below
// (fs, child_process, ports, stdio). Counting there is the honest liveness
// signal, and it is what globalThis.__nimbusPendingOps reports.
const __nimbusOrigThen = Promise.prototype.then;
if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
function __nimbusTrackOp(promise) {
  if (!promise || typeof promise.then !== "function") return promise;
  globalThis.__nimbusPendingOps++;
  const settled = () => { globalThis.__nimbusPendingOps--; };
  try { __nimbusOrigThen.call(promise, settled, settled); }
  catch { settled(); }
  return promise;
}

async function __nimbusUseRpcResult(promise, use) {
  globalThis.__nimbusPendingOps++;
  try { return await __nimbusUseRpcResultUnref(promise, use); }
  finally { globalThis.__nimbusPendingOps--; }
}
// Facet infrastructure that long-polls the supervisor for as long as the
// facet lives — the attached-process stdin pump — is the analogue of an
// unref'd handle: real I/O, but never a reason to keep the program alive.
async function __nimbusUseRpcResultUnref(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { __nimbusDisposeRpcResult(value); }
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fetch default User-Agent ───────────────────────────────────────
// workerd's global fetch sends no User-Agent by default, but Node's
// undici fetch adds \`User-Agent: node\`. Servers that require a UA
// (notably GitHub's API, used by giget/create-* template downloaders)
// answer 403 to a UA-less request. Match Node by injecting the default
// UA only when the caller supplied none, preserving any explicit value.
// This also covers the http/https \`request\`/\`get\` shims, which route
// through this same global fetch.
(() => {
  if (typeof globalThis.fetch !== "function" || globalThis.__nimbusFetchUaInstalled) return;
  globalThis.__nimbusFetchUaInstalled = true;
  const __origFetch = globalThis.fetch.bind(globalThis);
  const __hasUa = (h) => {
    if (!h) return false;
    if (typeof h.get === "function") return h.get("user-agent") != null;
    if (Array.isArray(h)) return h.some((p) => String(p?.[0]).toLowerCase() === "user-agent");
    return Object.keys(h).some((k) => k.toLowerCase() === "user-agent");
  };
  const __loopbackHosts = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
  const __fetchUrl = (input) => {
    try {
      const href = typeof input === "string" ? input
        : (input && typeof input === "object" && input.url) ? input.url : String(input);
      return new URL(href);
    } catch { return null; }
  };
  // Read one header off whatever the caller passed without constructing a
  // Request: \`new Request(existing)\` marks the original's body disturbed, and a
  // request we inspect but do not claim must still be sendable by real fetch.
  // \`init.headers\` replaces a Request's own headers, so it is consulted first.
  const __headerOf = (input, init, name) => {
    const h = (init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : null);
    if (!h) return null;
    if (typeof h.get === "function") return h.get(name);
    if (Array.isArray(h)) {
      for (const pair of h) if (String(pair?.[0]).toLowerCase() === name) return String(pair?.[1]);
      return null;
    }
    for (const key of Object.keys(h)) if (key.toLowerCase() === name) return String(h[key]);
    return null;
  };
  // Strip the caller's AbortSignal before the RPC hop: workerd JSRPC does not
  // serialize Request.signal ("AbortSignal serialization is not enabled"), and
  // the opencode SDK stamps timeout signals on its startup requests — which
  // made 4/5 attach boot calls fail. Cancellation across the hop is advisory;
  // an aborted caller simply drops the response.
  const __supervisorRequest = (url, input, init) => (
    (typeof Request !== "undefined" && input instanceof Request)
      ? new Request(input, { ...(init || {}), signal: null })
      : new Request(url.href, { ...(init || {}), signal: null })
  );
  // In-session loopback: a facet's fetch to 127.0.0.1/localhost:<port> is routed
  // to the facet that owns <port> through the supervisor's port registry (the
  // same routing the shell curl/node loopback uses), so a facet can reach another
  // facet's server in-session (opencode attach reaching opencode serve). Returns
  // the target's Response (streamed over RPC, so SSE flows). Anything non-
  // loopback, or when no supervisor is bound, falls through to real fetch.
  const __maybeRouteLoopback = (url, input, init) => {
    if (!__loopbackHosts.has(url.hostname)) return null;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if (!Number.isFinite(port) || port <= 0) return null;
    return Promise.resolve(__supervisor.routeLoopback(port, __supervisorRequest(url, input, init)));
  };
  // AI-egress mediation: a request addressed anywhere on the network that
  // presents this session's AI capability token is inference the session owns,
  // so it is served by the session's own gateway (supervisor loopback port
  // ${NIMBUS_AI_GATEWAY_PORT}) instead of being sent out. That is how a tool holding a baked-in
  // vendor base URL — one that never reads OPENAI_BASE_URL — still reaches the
  // session's models with no configuration of its own.
  //
  // The match is on the credential, never on the destination: a request
  // carrying anything else (the user's own real provider key) is not ours, is
  // left alone, and goes to that provider. See _shared/ai-egress.ts.
  const __aiCredentialHeaders = ${AI_CREDENTIAL_HEADERS_LITERAL};
  const __maybeRouteAiEgress = (url, input, init) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let token = "";
    try { token = (env && env[${AI_TOKEN_ENV_LITERAL}]) || ""; } catch { return null; }
    if (!token) return null;
    for (const name of __aiCredentialHeaders) {
      const raw = __headerOf(input, init, name);
      if (!raw) continue;
      if (String(raw).trim().replace(/^bearer\\s+/i, "") !== token) continue;
      return Promise.resolve(__supervisor.routeLoopback(${NIMBUS_AI_GATEWAY_PORT}, __supervisorRequest(url, input, init)));
    }
    return null;
  };
  const __dispatch = (input, init) => {
    try {
      if (__supervisor && typeof __supervisor.routeLoopback === "function") {
        const url = __fetchUrl(input);
        const routed = url && (__maybeRouteLoopback(url, input, init) || __maybeRouteAiEgress(url, input, init));
        if (routed) return routed;
      }
    } catch { /* fall through to real fetch */ }
    const reqHasUa = typeof Request !== "undefined" && input instanceof Request && __hasUa(input.headers);
    if (reqHasUa || __hasUa(init && init.headers)) return __origFetch(input, init);
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    headers.set("user-agent", "node");
    return __origFetch(input, { ...(init || {}), headers });
  };
  // Coherence at the outbound-fetch boundary (§0.2 witness 2 of the VFS
  // coherence protocol). A facet's fetch does not go through the supervisor:
  // the facet inherits the parent worker's network, so the response resumes
  // user code with no supervisor message an invalidation could ride on, and
  // an external third party can carry a happens-before edge between two
  // facets that never touches the authority.
  //
  // Both halves are sited here:
  //   RELEASE — this facet's parked writes are flushed before the request
  //     leaves, so nothing outside can observe an effect of a write the
  //     authority has not got yet.
  //   ACQUIRE — performed when the response lands, before the awaiting user
  //     code runs.
  //
  // ACQUIRE has to be AFTER the response, and the earlier design saying it
  // could ride concurrently with the request — free, hidden under the network
  // — was wrong, which a test caught rather than an argument. A concurrent
  // ACQUIRE is serviced at request time, so it reports the world as of when
  // the request left. The whole anomaly is that the RESPONSE encodes "the
  // write happened", so an ACQUIRE older than the response is exactly the one
  // that cannot see the write it is there to catch. That costs a real
  // supervisor round trip per outbound request, not a hidden one. It is the
  // price of the guarantee.
  //
  // The barriers live on globalThis because the fs module installs them and
  // is evaluated after this one; a facet with no supervisor bound has none,
  // and there is nothing to be coherent with.
  const __resumeCoherent = async (pending) => {
    const value = await pending;
    const acquire = globalThis.__nimbusVfsAcquireBarrier;
    if (typeof acquire === "function") await acquire();
    return value;
  };
  const __barriered = async (input, init) => {
    const release = globalThis.__nimbusVfsReleaseBarrier;
    if (typeof release === "function") await release();
    return __resumeCoherent(__dispatch(input, init));
  };
  globalThis.fetch = function fetch(input, init) {
    return __nimbusTrackOp(__barriered(input, init));
  };
  // A fetch settles once the headers arrive; reading the body is a SECOND
  // in-flight operation on the same connection, and \`const r = await
  // fetch(u); const j = await r.json()\` is the shape most programs use.
  // It is also a second resumption from the network, so it takes the same
  // ACQUIRE: a program that reads a file after parsing a response body is no
  // less entitled to current bytes than one that reads after the headers.
  for (const __name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const __orig = Response.prototype[__name];
    if (typeof __orig !== "function") continue;
    try {
      Response.prototype[__name] = function(...args) {
        return __nimbusTrackOp(__resumeCoherent(__orig.apply(this, args)));
      };
    } catch { /* host object is sealed — the drain still sees the fetch itself */ }
  }
})();

let __nimbusLiveStdinPump = null;
let __nimbusProcessExitReported = false;
let __nimbusProcessExitResolve = null;
let __nimbusProcessExitCode = null;
const __nimbusProcessExitPromise = new Promise((resolve) => {
  __nimbusProcessExitResolve = resolve;
});

// ═══════════════════════════════════════════════════════════════════════
// ──  path module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __pathMod = (() => {
  function normalize(p) {
    const parts = p.split("/");
    const out = [];
    for (const s of parts) {
      if (s === "..") { if (out.length && out[out.length-1] !== "..") out.pop(); else out.push(s); }
      else if (s !== "." && s !== "") out.push(s);
    }
    return (p.startsWith("/") ? "/" : "") + out.join("/");
  }
  function join(...p) { return normalize(p.join("/")); }
  function resolve(...p) {
    let r = "";
    for (let i = p.length - 1; i >= 0; i--) {
      r = p[i] + (r ? "/" + r : "");
      if (r.startsWith("/")) break;
    }
    if (!r.startsWith("/")) r = (cwd || "/home/user") + "/" + r;
    return normalize(r);
  }
  function dirname(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.substring(0, i) : i === 0 ? "/" : "."; }
  function basename(p, ext) { const b = p.split("/").pop() || ""; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; }
  function extname(p) { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.substring(i) : ""; }
  function isAbsolute(p) { return p.startsWith("/"); }
  function relative(from, to) {
    const f = resolve(from).split("/").filter(Boolean);
    const t = resolve(to).split("/").filter(Boolean);
    let c = 0;
    while (c < f.length && c < t.length && f[c] === t[c]) c++;
    return [...Array(f.length - c).fill(".."), ...t.slice(c)].join("/") || ".";
  }
  function parse(p) {
    const str = String(p);
    const root = str.startsWith("/") ? "/" : "";
    const dir = dirname(str);
    const base = basename(str);
    const ext = extname(str);
    const name = ext ? base.slice(0, base.length - ext.length) : base;
    return { root, dir: dir === "." && !str.includes("/") ? "" : dir, base, ext, name };
  }
  function format(obj) {
    const o = obj || {};
    const dir = o.dir || o.root || "";
    const base = o.base || ((o.name || "") + (o.ext || ""));
    if (!dir) return base;
    if (dir === o.root) return dir + base;
    return dir + "/" + base;
  }
  function toNamespacedPath(p) { return p; }
  function matchesGlob() { return false; }
  return { join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, parse, format, toNamespacedPath, matchesGlob, sep: "/", delimiter: ":", posix: null, win32: null };
})();
__pathMod.posix = __pathMod;
// X.5-Z5 §3 follow-on: enhanced-resolve (transitive via @tailwindcss/vite
// → vite → enhanced-resolve) reads path.win32.normalize / .dirname at
// import time. We have no real win32 paths in workerd's VFS, so the
// posix implementation is functionally correct for any path content the
// workers will ever see. Aliasing posix to win32 satisfies the structural
// contract without spawning a separate code path. See
__pathMod.win32 = __pathMod;

// ═══════════════════════════════════════════════════════════════════════
// ──  Buffer shim ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __BufferMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();
  // The unwrapped view helper. Buffer methods are installed as own
  // properties on each instance, so \`this.subarray\` is the Buffer-returning
  // override — internal slicing must reach past it to avoid re-wrapping
  // throwaway views.
  const _view = Uint8Array.prototype.subarray;

  function from(d, encoding) {
    if (typeof d === "string") {
      if (encoding === "base64") {
        const bin = atob(d); const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return _wrap(a);
      }
      if (encoding === "hex") {
        const a = new Uint8Array(d.length / 2);
        for (let i = 0; i < a.length; i++) a[i] = parseInt(d.substr(i*2, 2), 16);
        return _wrap(a);
      }
      return _wrap(_enc.encode(d));
    }
    if (d instanceof Uint8Array) return _wrap(new Uint8Array(d));
    if (d instanceof ArrayBuffer) return _wrap(new Uint8Array(d));
    if (Array.isArray(d)) return _wrap(new Uint8Array(d));
    return _wrap(new Uint8Array(0));
  }

  function alloc(n, fill) { const a = new Uint8Array(n); if (fill !== undefined) a.fill(typeof fill === "number" ? fill : 0); return _wrap(a); }
  function allocUnsafe(n) { return _wrap(new Uint8Array(Number(n) || 0)); }
  function isBuffer(o) { return o instanceof Uint8Array && typeof o.toString === "function" && o.__isBuffer; }
  function concat(bufs, len) {
    const total = len ?? bufs.reduce((s, b) => s + b.length, 0);
    const r = new Uint8Array(total); let off = 0;
    for (const b of bufs) { r.set(_view.call(b, 0, Math.min(b.length, total - off)), off); off += b.length; if (off >= total) break; }
    return _wrap(r);
  }
  function byteLength(value, encoding) {
    if (typeof value === "string") {
      if (encoding === "base64") {
        try { return from(value, "base64").byteLength; } catch { return 0; }
      }
      if (encoding === "hex") return Math.floor(value.length / 2);
      return _enc.encode(value).length;
    }
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (value instanceof Uint8Array) return value.byteLength;
    return 0;
  }
  function compare(a, b) {
    const aa = from(a);
    const bb = from(b);
    const n = Math.min(aa.length, bb.length);
    for (let i = 0; i < n; i++) {
      if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
    }
    if (aa.length === bb.length) return 0;
    return aa.length < bb.length ? -1 : 1;
  }
  function isEncoding(enc) {
    if (!enc) return false;
    return ["utf8", "utf-8", "base64", "hex", "ascii", "latin1", "binary"].includes(String(enc).toLowerCase());
  }
  function _wrap(u8) {
    u8.__isBuffer = true;
    u8.toString = function(encoding) {
      if (!encoding || encoding === "utf8" || encoding === "utf-8") return _dec.decode(this);
      if (encoding === "base64") { let s = ""; for (const b of this) s += String.fromCharCode(b); return btoa(s); }
      if (encoding === "hex") { let s = ""; for (const b of this) s += b.toString(16).padStart(2, "0"); return s; }
      return _dec.decode(this);
    };
    u8.write = function(str, off, len, enc) { const b = _enc.encode(str); this.set(_view.call(b, 0, len || b.length), off || 0); return Math.min(b.length, len || b.length); };
    // Node's Buffer#subarray returns a Buffer over the same memory, and
    // Buffer#slice is documented as its alias. Without the override a slice
    // came back as a bare Uint8Array whose toString() is the comma-joined
    // byte list — silent corruption for anything that slices then stringifies.
    u8.subarray = function(s, e) { return _wrap(_view.call(this, s, e)); };
    u8.slice = u8.subarray;
    u8.copy = function(t, tOff, sOff, sEnd) { t.set(_view.call(this, sOff || 0, sEnd), tOff || 0); };
    u8.equals = function(o) { if (this.length !== o.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; };
    u8.toJSON = function() { return { type: "Buffer", data: Array.from(this) }; };
    u8.indexOf = function(v) { if (typeof v === "number") return Uint8Array.prototype.indexOf.call(this, v); const b = typeof v === "string" ? _enc.encode(v) : v; outer: for (let i = 0; i <= this.length - b.length; i++) { for (let j = 0; j < b.length; j++) if (this[i+j] !== b[j]) continue outer; return i; } return -1; };
    return u8;
  }
  const B = Object.assign(from, {
    from,
    alloc,
    allocUnsafe,
    allocUnsafeSlow: allocUnsafe,
    isBuffer,
    concat,
    byteLength,
    compare,
    isEncoding,
    poolSize: 8192,
  });
  return B;
})();

/**
 * What the resident set holds under a directory prefix — the ONE question the
 * shims ask of it that a plain object cannot answer cheaply.
 *
 * The resident set is two things: a plain object on the heap, where the only
 * way to ask is to walk every key, and a table in the facet's own SQLite, where
 * the paths ARE a PRIMARY KEY index and the answer is a range scan. Asking the
 * object way against the table is what made a single \`existsSync\` of a
 * directory cost the whole filesystem — a \`for..in\` over the Proxy pulls every
 * key AND, through the descriptor trap, every file's bytes. Measured at pi
 * scale (19,470 files / 95 MiB): 222 ms, 17,821 chunk queries and 87 MiB of
 * content read and thrown away, PER CALL, against 1 ms and no content read for
 * the range scan. Node's module resolution does that lookup constantly, so the
 * two ways are not a style choice — one of them exhausts the process's CPU
 * budget on its own.
 *
 * Every prefix site in the shims goes through these, so the store's index is
 * reached from one place rather than nine, and the heap fallback stays the
 * literal walk it always was.
 */
function __residentUnder(prefix) {
  if (typeof __residentKeysUnder === "function") return __residentKeysUnder(prefix);
  const out = [];
  if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) out.push(bk);
  return out;
}

/** Whether ANYTHING is held under a prefix. The hot half — never materializes. */
function __residentAnyUnder(prefix) {
  if (typeof __residentHasUnder === "function") return __residentHasUnder(prefix);
  if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fs shim (VFS-backed) ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __fsMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ── byte-shape helpers (binary-fs wave) ──
  // __vfsWrites + __vfsBundle now carry \`Uint8Array | string\`. Strings
  // are the hot path (module source, package.json, user JS); bytes are
  // the binary-fs path (wasm modules, images, binary protocol payloads).
  // Pre-fix the Uint8Array branch UTF-8-decoded the bytes to a string,
  // which mangled every byte ≥ 0x80 to U+FFFD (3-byte EF BF BD on the
  // re-encode), corrupting all binary fs writes. See
  function _isBytes(v) { return v instanceof Uint8Array; }
  // Length in bytes regardless of shape — used by statSync's size field
  // and the bundle-cap accounting on the host side.
  function _byteLen(v) {
    if (_isBytes(v)) return v.byteLength;
    if (typeof v === "string") return _enc.encode(v).length;
    return 0;
  }
  // Coerce to bytes for binary-write paths. Strings are UTF-8-encoded
  // (lossless for valid Unicode); bytes pass through.
  function _asBytes(v) {
    if (_isBytes(v)) return v;
    if (typeof v === "string") return _enc.encode(v);
    return new Uint8Array(0);
  }
  // Coerce to string for text-read paths. Bytes are UTF-8-decoded
  // (lossy for invalid sequences — same caveat as Node's
  // \`Buffer.toString('utf8')\`); strings pass through.
  function _asString(v) {
    if (typeof v === "string") return v;
    if (_isBytes(v)) return _dec.decode(v);
    return "";
  }

  // ── helpers ──
  function _strip(p) { return String(p).replace(/^\\/+/, ""); }
  function _resolve(p) {
    // X.5-O: WHATWG-URL → POSIX path coercion. Pre-fix String(p) on
    // a URL instance or 'file://' string produced 'file:///package.json';
    // that failed the startsWith('/') guard below and got misrouted via
    // path.resolve(cwd, 'file:///…') → corrupt path → ENOENT (verify-90993b3
    // §3 bucket O: vite). Strip 'file://' and unwrap URL instances first.
    let s;
    if (p && typeof p === "object" && p.protocol === "file:" && typeof p.pathname === "string") {
      // URL instance — pathname is already a POSIX path with leading /
      try { s = decodeURIComponent(p.pathname); } catch { s = p.pathname; }
    } else {
      s = String(p);
      if (s.startsWith("file://")) {
        // 'file:///abs' → '/abs', 'file://host/abs' → '/abs'
        const tail = s.slice(7);
        const slashIdx = tail.indexOf("/");
        const pathPart = tail.startsWith("/") ? tail : (slashIdx >= 0 ? tail.slice(slashIdx) : "/" + tail);
        try { s = decodeURIComponent(pathPart); } catch { s = pathPart; }
      }
    }
    if (s.startsWith("/")) return __pathMod.normalize(s);
    return __pathMod.resolve(cwd || "/home/user", s);
  }

  // ── VFS bundle lookup (fast path — in-memory) ──
  function _bundleLookup(absPath) {
    const k = _strip(absPath);
    if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
    // Also check writes
    if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
    return undefined;
  }

  // __vfsMetadata is not declared in every embedding of these shims, so the
  // one guarded reference lives here and every other reader goes through it.
  function _metadataTable() {
    return (typeof __vfsMetadata !== "undefined" && __vfsMetadata) ? __vfsMetadata : null;
  }

  // Same guard, same reason: the SQLite resident store is spliced into the
  // resident-process body only. The one-shot exec path runs in a stateless
  // loaded worker with no facet storage at all, so these shims must still work
  // with the resident set on the heap and this is the single place that asks.
  function _residentStorePresent() {
    return typeof __residentAdmit === "function" && typeof __residentReady !== "undefined" && __residentReady;
  }

  function _metadata(absPath) {
    const table = _metadataTable();
    return table ? table[_strip(absPath)] : undefined;
  }

  function _denialCode(cell) {
    return cell && typeof cell === "object" && !(cell instanceof Uint8Array) &&
      typeof cell.error === "string" ? cell.error : null;
  }

  // Removal retracts the path from the sync existence view — __vfsMetadata
  // (spawn-time stat records) and __vfsManifest (directory shape). Without
  // it, existsSync keeps reporting a file this process already deleted and
  // the sync read path reports that file as merely non-resident.
  function _forgetSyncPath(k) {
    _announcedDirs.delete(k);
    const metadata = _metadataTable();
    if (metadata) delete metadata[k];
    if (!__vfsManifest) return;
    delete __vfsManifest[k];
    const slash = k.lastIndexOf("/");
    const parent = slash >= 0 ? k.slice(0, slash) : "";
    const name = slash >= 0 ? k.slice(slash + 1) : k;
    const siblings = __vfsManifest[parent];
    if (!siblings) return;
    const at = siblings.indexOf(name);
    if (at !== -1) siblings.splice(at, 1);
  }

  /**
   * Put a path into the sync EXISTENCE view — the inverse of _forgetSyncPath.
   *
   * A content cell is not existence. An invalidation drops content and is
   * documented to leave the name behind so existsSync cannot fabricate an
   * ENOENT for a file that was merely rewritten — but a file this process just
   * created has no manifest entry and no spawn-time stat record, so its cell
   * WAS the name, and evicting it retracted a file the program had written
   * itself. Recording the name where every other name lives is what makes that
   * documented asymmetry true.
   *
   * The parent's listing is the right home for it. Where the parent has no
   * listing the entry is created only for a directory this process made, since
   * that is the only case in which it knows the whole contents and calling the
   * directory enumerated is honest.
   */
  function _announceSyncPath(k) {
    if (!__vfsManifest || k === "") return;
    const slash = k.lastIndexOf("/");
    const parent = slash >= 0 ? k.slice(0, slash) : "";
    const name = slash >= 0 ? k.slice(slash + 1) : k;
    let siblings = __vfsManifest[parent];
    if (!Array.isArray(siblings)) {
      if (!__vfsDirs || !(parent in __vfsDirs)) return;
      siblings = __vfsManifest[parent] = [];
    }
    if (siblings.indexOf(name) === -1) siblings.push(name);
  }

  /**
   * Park a synchronous mutation: the cell the program reads back, the record
   * that the path is there, and the retirement of any revision stamp the old
   * content carried. One place, because every sync mutation owes all three.
   */
  function _parkWrite(k, cell) {
    __vfsWrites[k] = cell;
    if (__vfsBundle) __vfsBundle[k] = cell;
    delete __vfsBundleRevisions[k];
    _announceSyncPath(k);
  }

  function _forgetSyncTree(k) {
    const prefix = k + "/";
    for (const dir of _announcedDirs) if (dir.startsWith(prefix)) _announcedDirs.delete(dir);
    const metadata = _metadataTable();
    if (metadata) {
      for (const mk of Object.keys(metadata)) if (mk.startsWith(prefix)) delete metadata[mk];
    }
    if (__vfsManifest) {
      for (const dk of Object.keys(__vfsManifest)) if (dk.startsWith(prefix)) delete __vfsManifest[dk];
    }
    _forgetSyncPath(k);
  }

  /**
   * The honest error for a sync read the resident view cannot serve. A facet
   * has no synchronous I/O primitive, so a sync read is limited to content
   * staged into this process — but the sync existence view (__vfsMetadata +
   * __vfsManifest) knows far more paths than the content bundle carries.
   * ENOENT is only correct when the path is unknown there too; for a path
   * that demonstrably exists it sends the caller hunting for a missing file
   * instead of awaiting the read that would return it.
   */
  function _notResidentError(absPath, displayPath, syscall, asyncForm) {
    const st = _statLadder(absPath);
    if (st === undefined) {
      if (!_absenceIsKnown(absPath)) _recordUnmapped(absPath, syscall);
      return _fsErr("ENOENT", syscall, displayPath);
    }
    if (st.isDirectory()) return _fsErr("EISDIR", syscall, displayPath);
    _recordResidencyMiss(absPath);
    const err = _fsErr("EAGAIN", syscall, displayPath);
    err.message += " — '" + String(displayPath) + "' exists but its content is not " +
      "resident in this facet, and synchronous I/O cannot block to fetch it" +
      // The async form only reaches the live VFS when a supervisor is bound;
      // without one it re-enters this same resident view, so promising that
      // it would return the bytes would be its own lie.
      (_supervisor() ? "; " + asyncForm + " reads it from the live filesystem" : "");
    return err;
  }

  /**
   * Every path a synchronous access asked for and did not get.
   *
   * EAGAIN is the honest code, and it is still one no program branches on:
   * it cannot arise from a read of a real POSIX regular file, so no library
   * has a handler for it. Whatever catch block does receive it was written
   * for a file that is missing, and the reader carries on with the answer it
   * prepared for that — a wrong answer, silently. Throwing alone therefore
   * cannot be the whole behaviour; the miss is recorded too, and two
   * consumers read the record for different reasons:
   *
   *   - The runner, at exit: an entry that survived to the end was never
   *     answered, so the program's result rests on a read that failed. It
   *     names the files and exits non-zero rather than let that report
   *     success.
   *   - The supervisor, from the exit envelope: the next bundle built for
   *     the same entry stages exactly these paths, so the miss stops
   *     recurring. Observation, not a guess about what a program will read.
   *
   * An entry clears only when the PROGRAM is handed the bytes for that path.
   * Residency repaired behind its back does not un-answer the access that
   * already failed.
   */
  const _residencyMisses = globalThis.__nimbusVfsResidencyMisses
    || (globalThis.__nimbusVfsResidencyMisses = new Set());

  function _recordMiss(k) {
    if (k === "" || _residencyMisses.has(k)) return;
    _residencyMisses.add(k);
    _stats.misses++;
  }

  /**
   * Repairs already issued, so each one costs one round trip.
   *
   * Kept apart from the ledger above because the two answer different
   * questions and a path can need both: the same file can be refused first
   * for being unmapped, which is repaired by fetching its parent's listing,
   * and then for having no resident content, which is repaired by fetching
   * the file. Sharing one set let the second repair be swallowed by the
   * first, and the read never became answerable.
   */
  const _faulted = new Set();
  function _faultOnce(kind, k) {
    const token = kind + ":" + k;
    if (_faulted.has(token)) return false;
    _faulted.add(token);
    return true;
  }

  /**
   * Paths the authority did not have when the access was refused.
   *
   * What the exit report asks is whether the program's result rests on a read
   * that failed, and that is not the same question as whether the path is
   * there NOW. A program told there is no config writes one, so by the time
   * the run ends the file exists — authored by the program itself, out of the
   * very branch the not-found answer sent it down. Nothing was withheld from
   * it. Measured: create-next-app's update notifier reads /tmp/update-check,
   * does not find it, writes it, and the whole scaffold was failed over a file
   * that had never existed; c3 does the same with its wrangler metrics file.
   *
   * So the repair records what it saw, and it asks with a stat rather than a
   * read. A read flushes this facet's pending writes to the authority before
   * issuing, so it would hand back the bytes the program had just parked and
   * report the path as one that was there all along.
   */
  const _observedAbsent = new Set();

  function _recordResidencyMiss(absPath) {
    const k = _strip(absPath);
    _recordMiss(k);
    _faultIn(k);
  }

  function _residencySatisfied(absPath) {
    if (_residencyMisses.size === 0) return;
    _residencyMisses.delete(_strip(absPath));
  }

  /**
   * Fault the page in.
   *
   * The access that missed cannot be served — no continuation exists to
   * suspend — but the bytes can be resident before the next one. A program
   * that retries, a later phase that reaches the same file, a second module
   * reading the same data: all of those are refused a second time for a
   * reason that was already repairable after the first.
   *
   * One round trip per path, ever: the ledger above is the dedupe, so a read
   * loop over a non-resident file costs one fetch rather than one per turn.
   *
   * Nothing awaits the fill, but it rides the same RPC accounting every other
   * read does, so the drain settles it before teardown. That is the behaviour
   * to want: an isolate torn down mid-fetch leaves the repair undone, and the
   * cost of not doing so is one read the program was going to need anyway.
   */
  function _faultIn(k) {
    if (!_supervisor() || !_faultOnce("content", k)) return;
    // Swallowed here rather than at the settle: a repair nobody asked for
    // must not surface as an unhandled rejection, and a failed one is simply
    // a path that stays unanswered and stays in the ledger.
    try { _repairs.push(_observeThenFill(k).catch(() => {})); }
    catch { /* the fill is speculative */ }
  }

  /**
   * Ask what the authority has, then fetch it if there is anything to fetch.
   *
   * The stat is not an extra round trip on balance: where the path is absent —
   * which is most refusals, since module resolvers and config lookups probe
   * far more paths than exist — it replaces a content read that could only
   * have failed, and it is the one observation that settles whether the run
   * was denied anything.
   */
  async function _observeThenFill(k) {
    const supervisor = _supervisor();
    const absPath = "/" + k;
    if (typeof supervisor.stat === "function") {
      let meta;
      // A thrown stat is the authority failing to answer, not an answer:
      // nothing is learned, and the miss stands.
      try { meta = await __nimbusUseRpcResult(supervisor.stat(absPath), (r) => r); }
      catch { return; }
      if (meta === null || meta === undefined) { _observedAbsent.add(k); return; }
      if (meta.type === "directory") return;
    }
    await _liveReadFile(absPath, undefined);
  }

  /**
   * Repairs in flight, and the wait the exit report owes them.
   *
   * A refusal and the fetch that answers it are one event seen from two
   * sides, so a program that ends between them has not been denied anything
   * yet — it simply has not waited. Deciding the run was dishonest at that
   * moment reports a failure the very next turn would have retracted, which
   * for a short command is most of them. So the ledger is read only after
   * every outstanding repair has landed and every proven absence has been
   * retired. Published on globalThis because the runner that reports is
   * outside this closure, the same way the resumption barriers are.
   */
  const _repairs = [];
  globalThis.__nimbusVfsResidencySettle = async () => {
    // One boundary listing can move the boundary a level deeper rather than
    // settle the question outright, and which directory to ask for next is
    // only knowable once the previous answer has landed. So drain, settle,
    // and go round again while the settle is still asking for listings. It
    // terminates: every round enumerates a directory that was unknown, each
    // directory is fetched at most once (_faultOnce), and the paths in the
    // ledger have finitely many components.
    for (;;) {
      while (_repairs.length > 0) {
        await Promise.allSettled(_repairs.splice(0));
      }
      _settleProvenAbsences();
      if (_repairs.length === 0) return;
    }
  };

  /**
   * Has this directory's content been enumerated, or merely mentioned?
   *
   * __vfsManifest is a walk of SELECTED roots — the cwd subtree, its
   * node_modules, the entry script's own package — not of the filesystem. A
   * directory with an entry there was listed by that walk, so its child list
   * is complete and a name that is not in it is genuinely not there. A
   * directory with no entry was never opened, and knows nothing. __vfsDirs
   * holds the directories this process created itself, which it therefore
   * knows the contents of by construction.
   *
   * Conflating the two is what let a synchronous readdir of a real directory
   * outside the walk answer with an empty array — not an error, not a refusal,
   * a positive assertion that a populated directory is empty. Every caller
   * that used to end in "not found, so absent" goes through here first.
   */
  function _dirEnumerated(k) {
    return (!!__vfsManifest && k in __vfsManifest) || (!!__vfsDirs && k in __vfsDirs);
  }

  /** Does the content bundle itself describe children under this directory? */
  function _bundleHasChildren(k) {
    if (!__vfsBundle) return false;
    return __residentAnyUnder(k ? k + "/" : "");
  }

  /**
   * Can the view say this path is ABSENT, as opposed to say nothing at all?
   *
   * With no supervisor bound there is no authority to be ignorant of: the
   * staged tables ARE the filesystem, the async form reads out of those same
   * tables, and a name that is not in them is not anywhere. Ignorance is a
   * property of the gap between a process and an authority it cannot reach
   * synchronously, so where there is no authority there is no gap.
   */
  function _absenceIsKnown(absPath) {
    if (!_supervisor()) return true;
    const k = _strip(absPath);
    if (k === "") return true;
    const segments = k.split("/");
    // Deepest enumerated ancestor, because that is the only one that can
    // testify. Walking up rather than looking only at the immediate parent is
    // what makes a whole missing subtree answerable from one listing: if
    // $HOME was enumerated and holds no .config, then nothing under .config
    // is there either, and a program probing three levels down deserves that
    // answer rather than three refusals.
    for (let i = segments.length - 1; i >= 0; i--) {
      const dir = segments.slice(0, i).join("/");
      if (!_dirEnumerated(dir)) continue;
      const child = segments.slice(0, i + 1).join("/");
      const children = (__vfsManifest && __vfsManifest[dir]) || [];
      const present = children.indexOf(segments[i]) !== -1
        || (!!__vfsDirs && child in __vfsDirs)
        || (!!__vfsBundle && child in __vfsBundle);
      // The component is not in a directory that was listed: absent, and so is
      // everything below it. If it IS there, only its own enumeration settles
      // what it contains, so nothing short of the immediate parent will do.
      if (!present) return true;
      return i === segments.length - 1;
    }
    return false;
  }

  /**
   * A path the sync view never mapped: record the ignorance, and repair it.
   *
   * Sibling of _notResidentError and the same bargain — the file may well be
   * there, the process simply cannot look without blocking. The callers answer
   * ENOENT, which is provisional rather than fabricated: this records the miss
   * and pulls in the listing that settles the question, and the exit report
   * reads the ledger. If the path was genuinely absent the repair proves it
   * and the entry retires — the program's not-found branch was the right
   * branch and it reached it through the right errno. If the path WAS there,
   * the entry survives and the run is failed by name.
   *
   * EAGAIN was tried here and is the wrong answer to hand a program even
   * though it is the honest description of the situation. It cannot arise from
   * a real POSIX filesystem, so nothing branches on it, and the catch block
   * that receives it was written for a missing file and rethrows instead:
   * measured, create-next-app reads $HOME/.config/<tool>/config.json through
   * the conf package, is handed EAGAIN for a file that was never there, and
   * dies before writing one template file. Read a config, treat ENOENT as "no
   * config yet", rethrow anything else is the near-universal shape. Refusing
   * bought nothing the ledger was not already delivering, and cost every
   * program that idiom.
   *
   * A LISTING is the exception and still refuses — see readdirSync. An array is
   * a complete enumeration by definition, so there is no provisional form of
   * it: an empty one asserts that a directory nothing ever opened is empty,
   * which is how a scaffolder was told its template directory held nothing,
   * wrote nothing, and exited 0.
   */
  function _recordUnmapped(absPath, syscall) {
    const k = _strip(absPath);
    _recordMiss(k);
    // A listing wants the path's own contents; a read wants its bytes. Both
    // also want the boundary listing, which is the only thing that can prove
    // the path was not there — and fetching one repair and then the other
    // would refuse the same access twice, once for being unmapped and once for
    // having no resident content. _faultOnce collapses them where they meet.
    _faultInBoundary(k);
    if (syscall === "scandir") { _faultInDirectory(k); return; }
    _faultIn(k);
  }

  /**
   * The shallowest directory on this path whose contents the view does not
   * know: the child of the deepest ancestor that WAS enumerated.
   *
   * That, not the immediate parent, is the listing a refusal has to pull in.
   * For a path that is not there the parent is usually not there either, so
   * its readdir fails, the view learns nothing, and the ledger keeps an entry
   * no repair can ever retire — the run is failed over a file that was simply
   * absent. The boundary directory is different: the enumerated ancestor's own
   * listing already proved it is present, so it can be read, and reading it
   * either names the next component or proves the whole subtree absent.
   *
   * With nothing enumerated at all the boundary is the root, which is one
   * listing away from making the next level answerable.
   */
  function _unknownBoundary(k) {
    const segments = k.split("/");
    for (let i = segments.length - 1; i >= 0; i--) {
      if (_dirEnumerated(segments.slice(0, i).join("/"))) {
        return segments.slice(0, i + 1).join("/");
      }
    }
    return "";
  }

  function _faultInBoundary(k) {
    _faultInDirectory(_unknownBoundary(k));
  }

  /**
   * The refusal, for the two callers that have no provisional answer to give.
   *
   * A listing cannot say "not found" usefully, and neither can a write that
   * needs the prior content it is splicing onto. Everywhere else the sync view
   * answers ENOENT and lets the exit report settle whether that was true; here
   * there is no branch the program could take that would be right, so the
   * honest EAGAIN is also the useful one.
   */
  function _refuseUnmapped(absPath, displayPath, syscall, asyncForm) {
    _recordUnmapped(absPath, syscall);
    const err = _fsErr("EAGAIN", syscall, displayPath);
    err.message += " — '" + String(displayPath) + "' lies outside the filesystem view "
      + "staged into the process, so a synchronous call cannot tell what is there, "
      + "and synchronous I/O cannot block to find out"
      + (_supervisor() ? "; " + asyncForm + " answers from the live filesystem" : "");
    return err;
  }

  /**
   * Pull a directory listing in. _readdirAsync already records what it learns
   * into __vfsManifest, so one call both answers the fault and converges the
   * sync view on the async one — there is no second merge path to keep honest.
   */
  function _faultInDirectory(k) {
    if (!_supervisor() || _dirEnumerated(k) || !_faultOnce("listing", k)) return;
    try { _repairs.push(_readdirAsync("/" + k, undefined).catch(() => {})); }
    catch { /* speculative */ }
  }

  /**
   * Retire the refusals a repair turned into honest absence.
   *
   * A refusal is only a wrong answer when the path was THERE and the process
   * was denied it. Where the listing comes back and shows the name is simply
   * not present, the program's not-found branch was the right branch all
   * along — it merely reached it through the wrong errno — and failing the run
   * over that would fail every module resolver, which probes dozens of paths
   * that do not exist by design. So what stays in the ledger is exactly the
   * harmful set: content that exists and was not served.
   */
  function _settleProvenAbsences() {
    if (_residencyMisses.size === 0) return;
    for (const k of [..._residencyMisses]) {
      const absPath = "/" + k;
      // The authority did not have it when we asked, so nothing was withheld —
      // whatever is at the path now, this process put there.
      if (_observedAbsent.has(k)) { _residencyMisses.delete(k); continue; }
      if (_statLadder(absPath) !== undefined) continue;
      if (_absenceIsKnown(absPath)) { _residencyMisses.delete(k); continue; }
      // Still unprovable, because the listing that would settle it lies below
      // the one already fetched. Ask for the next one; the settle loop waits.
      _faultInBoundary(k);
    }
  }

  function _fsErr(code, syscall, p) {
    const err = new Error(code + ": " + syscall + " '" + p + "'");
    err.code = code;
    const errno = Number(__constantsMod[code]);
    err.errno = Number.isInteger(errno) ? -errno : -1;
    err.syscall = syscall;
    err.path = String(p);
    return err;
  }

  /**
   * Turn a failed supervisor call into a filesystem error the caller can
   * branch on. Every exit from here carries a code, a syscall, a path and an
   * errno, because that is the shape everything written against node:fs
   * expects — \`err.code === 'ENOENT'\` is how programs make decisions.
   *
   * An error does not cross the RPC boundary intact. Structured clone carries
   * an Error's name, message and stack and drops every own property, so the
   * code the authority set is already gone by the time this sees it; the
   * message is the only thing that survived. Recovering the code from its
   * \`CODE:\` prefix is therefore not a fallback beside a better path, it IS
   * the transport — every authority-side error carries that prefix by
   * construction (_fsErr here, fsError in the runtime-fs bridge, vfsError in
   * the VFS all format it). Carrying the fields in the RPC payload instead
   * would be the real repair; that needs the supervisor surface to return a
   * failure envelope rather than throw, and is noted for whoever owns it.
   *
   * What this does fix: a failure with no errno spelling at all — the object
   * was reset, the RPC disconnected, a quota was hit — used to be returned
   * UNCHANGED, carrying no code. A program branching on err.code then matched
   * no arm at all, so an I/O failure presented as a hang rather than an
   * error. EIO is the honest answer: the operation failed, and no more
   * specific reason is known. The authority's own words stay in the message
   * so classifying the failure does not cost the reason for it.
   */
  function _mapSupervisorError(error, syscall, p) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    const declared = error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : (/^([A-Z][A-Z0-9]+):/.exec(message) || [])[1];
    const known = declared !== undefined && Number.isInteger(Number(__constantsMod[declared]));
    const mapped = _fsErr(known ? declared : "EIO", syscall, p);
    if (!known && message) mapped.message += " — " + message;
    return mapped;
  }

  async function _fsRpc(promise, syscall, p, use) {
    try { return await __nimbusUseRpcResult(promise, use); }
    catch (error) { throw _mapSupervisorError(error, syscall, p); }
  }

  // Every supervisor READ round trip the facet issues. The runner reports it
  // in the exec-diag envelope, so a change to how reads are issued (batched,
  // coalesced, pipelined) is measurable instead of asserted. Reads are the
  // only fs RPC a program can issue thousands of in one lifetime — a whole
  // file costs one per READ_STREAM_CHUNK_BYTES — so this counts reads rather
  // than every fs call.
  if (typeof globalThis.__nimbusFsRpcReads !== "number") globalThis.__nimbusFsRpcReads = 0;
  function _fsReadRpc(promise, syscall, p, use) {
    globalThis.__nimbusFsRpcReads++;
    return _fsRpc(promise, syscall, p, use);
  }

  const _localTimes = globalThis.__nimbusVfsTimes || (globalThis.__nimbusVfsTimes = Object.create(null));
  const _localModes = globalThis.__nimbusVfsModes || (globalThis.__nimbusVfsModes = Object.create(null));

  function _coerceMode(value, syscall, p) {
    const n = typeof value === "string" ? parseInt(value, 8) : Number(value);
    if (!Number.isInteger(n) || n < 0) throw _fsErr("EINVAL", syscall, p);
    return n & 0o7777;
  }

  function _coerceTimeMs(value, syscall, p) {
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return Math.trunc(ms);
      throw _fsErr("EINVAL", syscall, p);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw _fsErr("EINVAL", syscall, p);
    return Math.trunc(n * 1000);
  }

  function _recordLocalTimes(absPath, atime, mtime, syscall, p) {
    const k = _strip(absPath);
    const time = {
      atimeMs: _coerceTimeMs(atime, syscall, p),
      mtimeMs: _coerceTimeMs(mtime, syscall, p),
    };
    _localTimes[k] = time;
    return time;
  }

  function _localStatObject(k, isDir, isSymlink, size, mode, uid, gid) {
    const time = _localTimes[k];
    const mtimeMs = Number.isFinite(time?.mtimeMs) ? time.mtimeMs : Date.now();
    const atimeMs = Number.isFinite(time?.atimeMs) ? time.atimeMs : mtimeMs;
    const mtime = new Date(mtimeMs);
    const atime = new Date(atimeMs);
    const localMode = _localModes[k];
    const typeMode = isDir ? 0o040000 : isSymlink ? 0o120000 : 0o100000;
    const storedMode = Number(mode);
    const fullMode = Number.isInteger(storedMode)
      ? ((storedMode & 0o170000) === 0 ? typeMode | storedMode : storedMode)
      : typeMode | (isDir ? 0o755 : 0o644);
    return {
      isFile: () => !isDir && !isSymlink,
      isDirectory: () => isDir,
      isSymbolicLink: () => isSymlink,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size,
      atime,
      mtime,
      ctime: mtime,
      birthtime: mtime,
      mode: localMode === undefined ? fullMode : typeMode | localMode,
      uid: Number(uid),
      gid: Number(gid),
    };
  }

  function _supervisor() {
    try { return typeof __supervisor !== "undefined" ? __supervisor : null; }
    catch { return null; }
  }

  function _writtenCell(absPath) {
    const k = _strip(absPath);
    if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
    if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
    return undefined;
  }

  function _markVfsStale() {
    globalThis.__nimbusVfsMayBeStale = true;
  }

  // ══ Cache coherence: ACQUIRE + read-through fill ═════════════════════
  //
  // The supervisor's SQLite VFS is the only authority. Everything in this
  // facet — __vfsBundle, __vfsMetadata, __vfsManifest, __vfsDirs — is a
  // cache of it, and __vfsWrites is this process's own not-yet-flushed
  // mutations.
  //
  // INVARIANT: a cell may be served synchronously only if no write to its
  // path has been committed by the supervisor AND DELIVERED to this facet
  // since the cell was fetched. Delivery happens in _acquireBarrier.
  //
  // THE HARD CASE. A node sync read has no synchronous channel to the
  // authority — Atomics.wait is disabled, SharedArrayBuffer cannot cross a
  // Worker-Loader boundary, and a pure-JS stack cannot JSPI-suspend. So a
  // sync read cannot itself fetch; it can only serve what is already local.
  // Coherence therefore has to be established at the RESUMPTION boundary,
  // before user code runs, not inside the read.
  //
  // Three resumptions reached a facet with no supervisor in the path (all
  // measured live): a facet-local timer, a direct outbound fetch, and an
  // unsolicited inbound WebSocket frame. Each is barriered by manufacturing
  // the missing supervisor round trip at the boundary the shim owns:
  //   - timer:  setTimeout/setInterval callbacks run behind an awaited
  //             _acquireAndRefetch (see _installResumptionBarriers).
  //   - fetch:  the dispatcher flushes W ahead of egress and ACQUIREs when
  //             the response lands — after it, never concurrently with the
  //             request, because the response is what encodes the write.
  //   - socket: the supervisor terminates the socket and relays frames, so
  //             a frame arrives as a supervisor reply the same barrier
  //             rides on (see the relayed WebSocket below).
  //
  // Keep this list empty. An entry here is a documented hole in the owner's
  // invariant, not a TODO: it means some process can be woken by something
  // this system does not mediate, and its next synchronous read can serve
  // bytes the authority has already replaced.
  //
  // Correctness is unconditional and costs one supervisor round trip per
  // resumption — a setTimeout(0) poll-and-read loop pays one RTT per
  // iteration. That cost is removable only by a proactive revision push
  // whose delivery ordering is a workerd property, never by weakening the
  // barrier.
  const _UNBARRIERED_RESUMPTIONS = [];

  const _cursor = globalThis.__nimbusVfsCursor
    || (globalThis.__nimbusVfsCursor = { epoch: null, rev: 0 });

  // Whether any of this is working is a measurement, not an opinion: a fill
  // rate and an invalidation count. Same shape and the same reporting path
  // as __nimbusFsRpcReads, which the runner already folds into the exec-diag
  // envelope — there is no reason to invent a second surface for it.
  const _stats = globalThis.__nimbusVfsCoherence
    || (globalThis.__nimbusVfsCoherence = {
      fills: 0, filledBytes: 0, invalidations: 0, poisons: 0,
      reconciles: 0, selfWrites: 0, misses: 0,
    });

  /**
   * Drop a path from the sync CONTENT views, leaving the existence views
   * alone.
   *
   * Deliberate asymmetry. An invalidation says "what you hold is no longer
   * known-good"; it does not say whether the path was modified or removed,
   * and the facet cannot tell them apart from the path alone. Dropping the
   * name as well would make existsSync answer false for a file that was
   * merely rewritten — a fabricated ENOENT, which is worse than the honest
   * refusal, because it sends the caller down an error path built for a
   * different condition. Keeping the name means the next sync read reports
   * EAGAIN ("exists, not resident") and the async read that follows returns
   * either the new bytes or a truthful ENOENT.
   *
   * __vfsWrites is never dropped: this process's own unflushed writes are
   * strictly newer than anything the supervisor can report, and discarding
   * them would break read-your-writes.
   *
   * The name the asymmetry preserves has to BE somewhere, though. A file this
   * process created has no manifest entry and no spawn-time stat record, so
   * its cell was the only witness that it existed at all, and evicting the
   * cell retracted the file — measured live, a sync read after a barrier
   * answered ENOENT for a file the program had written itself moments before.
   * _announceSyncPath, at the moment the cell is created, is what makes the
   * intent above true rather than merely stated.
   */
  function _evictResident(k) {
    let evicted = false;
    delete __vfsBundleRevisions[k];
    if (__vfsBundle && k in __vfsBundle) { delete __vfsBundle[k]; evicted = true; }
    const metadata = _metadataTable();
    if (metadata && k in metadata) { delete metadata[k]; evicted = true; }
    return evicted;
  }

  /**
   * Install bytes the supervisor just served as the resident cell for a
   * path, at the cursor they were served under.
   *
   * This is a correctness obligation before it is an optimization. An async
   * read that returns v2 while leaving the resident cell at v1 makes the
   * NEXT synchronous read go backwards in time relative to a value the
   * program has already seen, which no amount of invalidation discipline
   * catches — the supervisor never learns what the facet's own read
   * returned, so it has nothing to invalidate. The bytes are already paid
   * for; caching them costs one map insert.
   *
   * The parent's manifest entry gains the name too, so the existence view
   * cannot go on denying a file whose bytes this process is holding.
   */
  function _installResident(absPath, bytes) {
    if (!__vfsBundle) return;
    const k = _strip(absPath);
    if (k === "") return;
    // Never over a cell this facet owns.
    //
    // A pending write is strictly newer than anything the authority can
    // report, and __vfsBundle is what sync reads consult first, so installing
    // over it would serve the program bytes older than its own write.
    //
    // A STAMPED cell is this facet's own flushed write, and the barrier this
    // read passed on the way in reported nobody else has touched the path
    // since — so the bytes are already what is being installed, and the only
    // thing the install would change is to drop the stamp. It did: a
    // speculative repair issued by an earlier refused read landed after the
    // flush, unstamped the cell, and the next ACQUIRE evicted the facet's own
    // output. Measured at selfWrites 0 / invalidations 1 / fills 2 for one
    // written file, against 1 / 0 / 0 with the repair absent.
    if (__vfsWrites && k in __vfsWrites) return;
    if (__vfsBundleRevisions[k] !== undefined) return;
    __vfsBundle[k] = bytes;
    // Keep the stat view consistent with the bytes now held. Without this
    // the content view is fresh while statSync still reports the
    // spawn-time length, so a program can read N bytes and be told the
    // file is M — an inconsistency introduced BY the fill. Only the size
    // is corrected: type, mode, ownership and timestamps stay as the
    // authority last reported them, so mtime-based change detection
    // (make, tsc --build, watchers) does not see every read as a change.
    const metadata = _metadataTable();
    if (metadata && k in metadata) {
      metadata[k] = { ...metadata[k], size: _byteLen(bytes) };
    }
    _announceSyncPath(k);
    _stats.fills++;
    _stats.filledBytes += _byteLen(bytes);
  }

  /**
   * Repair a poisoned resident store, once, however many barriers hit the
   * poison at the same instant.
   *
   * A poison is a failure of the DELTA CHANNEL, not of the rows. The
   * invalidation log is bounded at 256 KiB and write churn trims it past a
   * live cursor as a matter of course, so this runs REPEATEDLY during an npm
   * install — and dropping the store here meant re-materialising the whole
   * filesystem (~16,357 files / 96 MB at pi scale) inside the barrier, every
   * time, which is what took an agent turn past the DO CPU limit. fsList does
   * not touch the log and reports absolute per-path revisions, so the rows are
   * reconciled against those instead: every row kept is proven current by
   * revision, and only what actually moved is refetched.
   *
   * Single-flight because concurrent async fs operations each take their own
   * barrier and would each see the same poison: without this, one overflow
   * costs one enumeration per operation in flight. Joining is sound rather
   * than merely cheap — the repair publishes the cursor read BEFORE its walk,
   * so a joiner whose poison was answered later is left with a cursor at or
   * behind its own, and the mutations in between are still owed to it by the
   * next delta.
   */
  let _residentRepair = null;
  function _repairPoisonedStore(supervisor, result) {
    if (!_residentRepair) {
      _residentRepair = _runResidentRepair(supervisor, result)
        .finally(() => { _residentRepair = null; });
    }
    return _residentRepair;
  }

  async function _runResidentRepair(supervisor, result) {
    let repaired;
    try { repaired = await __residentSynchronizeFromSupervisor(supervisor); }
    catch { repaired = null; }
    if (!repaired || !repaired.cursor) {
      // The pass could not vouch for a single row — a supervisor replaced
      // mid-enumeration, an enumeration that came back short. A row that
      // cannot be dated must not be served, so the cold cache the poison asked
      // for is taken after all, and the pass runs once more to repopulate what
      // it just dropped.
      __residentAdmit(result);
      _cursor.epoch = result.epoch;
      _cursor.rev = result.rev;
      try { repaired = await __residentSynchronizeFromSupervisor(supervisor); }
      catch { repaired = null; }
    } else if (repaired.reconciled) {
      _stats.reconciles++;
    }
    if (!repaired || !repaired.cursor) return;
    _cursor.epoch = repaired.cursor.epoch;
    _cursor.rev = repaired.cursor.rev;
    _stats.invalidations += repaired.dropped;
    _stats.fills += repaired.filled;
    _stats.filledBytes += repaired.bytes;
  }

  /**
   * ACQUIRE. Apply every invalidation the supervisor has for this facet,
   * then re-stamp the cursor.
   *
   * Awaited before the async fs operation that carries it returns, so user
   * code never resumes holding a cell the supervisor has already told us
   * to drop.
   *
   * A poison result means the delta cannot repair the view — a different
   * supervisor incarnation, or a cursor older than the retained log. Where the
   * resident set lives in the facet's SQLite its rows carry their own
   * revisions, so a poison is repaired by reconciling them against fsList's
   * absolute per-path revisions rather than by dropping them. On the heap —
   * where a cell carries no date to verify against — the whole resident
   * content view still goes. That costs a cold cache; the alternative is a
   * stale byte.
   *
   * A path the facet itself wrote is skipped, and only at the revision its
   * own flush produced. The invalidation log records what changed, not who
   * changed it, so a facet that writes N files is handed all N of them back
   * on its next barrier and drops the bytes it is holding — measurably, 40
   * writes cost 41 invalidations and 40 refetches of content that never
   * left. Comparing revisions rather than names keeps the peer case intact:
   * a peer writing the same path afterwards reports a HIGHER revision than
   * our stamp, so that invalidation still lands.
   */
  async function _acquireBarrier(supervisor) {
    if (!supervisor || typeof supervisor.fsAcquire !== "function") return [];
    let result;
    // Through the RPC helper like every other supervisor call, because it IS
    // one: the barrier is the first thing an async read issues, and while it
    // was uncounted __nimbusPendingOps read zero for a whole round trip. A
    // one-shot facet's event loop, which exits when no handle is live, then
    // ended the program mid-read — measured as an fs.promises.readFile whose
    // .then never ran, no error, no output, intermittently, and never when a
    // pending timer happened to hold the program open.
    try { result = await __nimbusUseRpcResult(supervisor.fsAcquire(_cursor.epoch, _cursor.rev), (r) => r); }
    catch { return []; }
    if (!result || typeof result.rev !== "number") return [];
    // Paths that held content before this eviction are the ones worth
    // refetching at a resumption boundary — a later sync read of any of them
    // would otherwise miss. Collected before the delete so the membership
    // test is against the pre-eviction bundle.
    const wereResident = [];
    // When the resident set lives in the facet's own SQLite, the STORE applies
    // the delta. That is not an optimisation, it is where provenance has to
    // live: a facet's SQLite outlives its module scope, so a new incarnation
    // opens onto rows a previous one wrote while every heap-side stamp that
    // described them is gone. Rows carry their own revision, __vfsBundleRevisions
    // cannot follow them there, and two provenance stores would be one too many.
    if (_residentStorePresent()) {
      if (result.poison) {
        _stats.poisons++;
        await _repairPoisonedStore(supervisor, result);
        // Nothing is returned because a dropped cell is either refetched by
        // the repair or gone from the authority too.
        return [];
      }
      const applied = __residentAdmit(result);
      _cursor.epoch = result.epoch;
      _cursor.rev = result.rev;
      _stats.invalidations += applied.dropped.length;
      return applied.dropped;
    }
    if (result.poison) {
      if (__vfsBundle) for (const k of Object.keys(__vfsBundle)) { wereResident.push(k); _evictResident(k); }
      _stats.poisons++;
    } else if (Array.isArray(result.paths)) {
      for (const entry of result.paths) {
        const k = entry.path;
        if (__vfsBundleRevisions[k] >= entry.rev) { _stats.selfWrites++; continue; }
        const held = !!(__vfsBundle && k in __vfsBundle);
        if (_evictResident(k)) _stats.invalidations++;
        if (held) wereResident.push(k);
      }
    }
    _cursor.epoch = result.epoch;
    _cursor.rev = result.rev;
    return wereResident;
  }

  /**
   * ACQUIRE, then repopulate the working set the invalidation just dropped.
   *
   * The barrier used at every UNTRUSTED resumption — a timer firing, a
   * relayed socket frame — where user code is about to run synchronously
   * with no supervisor message to have carried an invalidation. Manufacture
   * that message: apply the delta, then live-read every path that was
   * resident and is now stale so a synchronous read inside the callback
   * sees exactly what an async read issued at this instant would.
   *
   * Eviction alone is not enough here. An async fs op evicts and then reads
   * its own path live, so a dropped cell repairs itself; a timer callback
   * has no such follow-up, so a dropped-but-not-refetched cell would raise
   * EAGAIN on the next sync read — the unhandleable error §7 warns about.
   * Under the owner's no-price-ceiling mandate we pay the refetch.
   *
   * This closes staleness of RESIDENT cells across an untrusted resumption.
   * A first synchronous touch of a NON-resident path is the separate
   * residency floor and is unaffected — it still raises EAGAIN, correctly.
   */
  async function _acquireAndRefetch(supervisor) {
    const stale = await _acquireBarrier(supervisor);
    if (stale.length === 0) return;
    await Promise.all(stale.map((k) => _liveReadFile("/" + k, undefined, true).catch(() => {})));
  }

  /**
   * ACQUIRE at an untrusted resumption boundary, with the supervisor
   * resolved at call time.
   *
   * Late resolution is load-bearing, not defensive. The opencode runner
   * evaluates this module with \`__supervisor\` still null and assigns it in
   * its fetch handler; binding the supervisor when the wrappers are
   * installed would silently leave every resident-TUI timer unbarriered.
   *
   * Published on globalThis because the two other untrusted resumptions —
   * an outbound fetch response and a relayed socket frame — are delivered
   * by code outside this closure. One barrier, three boundaries.
   */
  async function _resumptionAcquire() {
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.fsAcquire !== "function") return;
    await _acquireAndRefetch(supervisor);
  }

  /**
   * RELEASE: this facet's parked writes reach the authority before an
   * effect of them can be observed from outside the facet.
   *
   * Sited at every boundary where the facet's own action becomes externally
   * visible — an outbound request, a frame sent on a relayed socket. Without
   * it a peer can observe the effect of a write ("the build finished") and
   * then read the pre-write bytes, which breaks causal consistency rather
   * than merely linearizability.
   */
  async function _resumptionRelease() {
    await __nimbusFlushVfsWriteBack(_supervisor());
  }

  // Every untrusted resumption — a facet-local timer, an outbound fetch
  // response, a relayed socket frame — runs user code with no supervisor
  // message behind it, so it cannot have carried an invalidation. The shim
  // owns these entry points, so it manufactures the missing barrier: the
  // user callback is preceded by a completed ACQUIRE-and-refetch. After it,
  // a synchronous read in the callback is as fresh as an async read at the
  // same instant — the owner's invariant, met for the sync path.
  //
  // Correctness is unconditional and costs one supervisor round trip per
  // resumption. That cost is real (a setTimeout(0) poll-and-read loop pays
  // one RTT per iteration) and is the number to hand the owner; it is
  // removable only by a proactive revision push whose delivery ordering is
  // an unrun workerd probe, never by weakening the barrier.
  function _installResumptionBarriers() {
    if (globalThis.__nimbusResumptionBarriersInstalled) return;
    globalThis.__nimbusResumptionBarriersInstalled = true;
    globalThis.__nimbusVfsAcquireBarrier = _resumptionAcquire;
    globalThis.__nimbusVfsReleaseBarrier = _resumptionRelease;
    const _setTimeout = globalThis.setTimeout;
    const _setInterval = globalThis.setInterval;
    // The barrier moves the user callback BEHIND an awaited round trip, and
    // the timer bookkeeping counts a timer as done the moment its closure
    // starts. So between the ACQUIRE and the callback the facet looks idle,
    // and a one-shot facet could tear itself down in that window — the work
    // the timer was scheduled for simply never ran, silently. Counting the
    // deferred chain as an in-flight operation is what holds the facet open
    // across it; __nimbusPendingOps is the counter the drain consults for
    // exactly this, since an awaited chain is invisible to promise tracking.
    // Only the ACQUIRE is counted, never the callback that follows it. A
    // callback is free to be a long-lived thing — an SSE writer that returns
    // when the client disconnects — and counting it as an in-flight operation
    // would make a resident facet's drain wait for it, which buffers an open
    // response body. The window that needs holding is exactly the round trip.
    const _barriered = (cb, args) => {
      __nimbusTrackOp(_resumptionAcquire()).then(() => cb(...args));
    };
    if (typeof _setTimeout === "function") {
      globalThis.setTimeout = function setTimeout(cb, ms, ...args) {
        if (typeof cb !== "function") return _setTimeout(cb, ms);
        return _setTimeout(() => { _barriered(cb, args); }, ms);
      };
    }
    if (typeof _setInterval === "function") {
      globalThis.setInterval = function setInterval(cb, ms, ...args) {
        if (typeof cb !== "function") return _setInterval(cb, ms);
        return _setInterval(() => { _barriered(cb, args); }, ms);
      };
    }
  }

  // Directories mkdirSync created that the authority has not been told about.
  // A sync syscall cannot make an RPC, so mkdirSync can only record the
  // directory in the sync view (__vfsDirs) — and the write-back then flushed
  // the FILE without ever announcing the directories above it. writeFile
  // creates missing parents implicitly and so papered over the gap; fsAppend
  // and fsTruncate do not, which is how an appendFileSync log inside a fresh
  // mkdir tree failed ENOENT on its own parent and never reached authority.
  const _announcedDirs = new Set();

  // Announce every directory on \`absPath\` the authority may not know about.
  // supervisor.mkdir is recursive, so the deepest unannounced one creates all
  // of them in a single round trip; a path whose directories are already live
  // (the common case) costs none at all.
  async function _announceLocalDirs(absPath, supervisor) {
    if (!__vfsDirs || typeof supervisor.mkdir !== "function") return;
    const pending = [];
    let key = "";
    for (const segment of _strip(absPath).split("/")) {
      if (!segment) continue;
      key = key ? key + "/" + segment : segment;
      if (key in __vfsDirs && !_announcedDirs.has(key)) pending.push(key);
    }
    if (pending.length === 0) return;
    const deepest = "/" + pending[pending.length - 1];
    await _fsRpc(supervisor.mkdir(deepest), "mkdir", deepest, () => undefined);
    for (const dir of pending) _announcedDirs.add(dir);
    _markVfsStale();
  }

  async function _flushLocalPathToSupervisor(absPath, supervisor) {
    const k = _strip(absPath);
    await _announceLocalDirs(absPath, supervisor);
    if (__vfsWrites && k in __vfsWrites && typeof supervisor.writeFile === "function") {
      await __nimbusFlushVfsWrite(
        absPath,
        (content, snapshot) => _fsRpc(
          __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
          "write", absPath,
          (result) => result,
        ),
      );
      _markVfsStale();
    }
    // Pending sync chmod rides along with any flush of the same path
    // (idempotent — the entry stays so local statSync remains coherent).
    if (k in _localModes && typeof supervisor.chmod === "function") {
      await _fsRpc(supervisor.chmod(absPath, _localModes[k]), "chmod", absPath, () => undefined);
      _markVfsStale();
    }
  }

  // Resize the local sync-view cell (bundle + pending write) to \`size\`
  // bytes, zero-extending when growing. No-op when there is no cell.
  function _truncateLocalCell(absPath, size) {
    const k = _strip(absPath);
    const cell = _writtenCell(absPath);
    if (cell === undefined) return;
    const buf = _asBytes(cell);
    let next;
    if (size <= buf.byteLength) {
      next = buf.slice(0, size);
    } else {
      next = new Uint8Array(size);
      next.set(buf, 0);
    }
    if (__vfsWrites && k in __vfsWrites) __vfsWrites[k] = next;
    if (__vfsBundle && k in __vfsBundle) __vfsBundle[k] = next;
  }

  // Positional write into a local cell: return \`base\` with \`bytes\` placed at
  // \`pos\`. The single implementation behind every fd-style write (async
  // FileHandle.write, sync writeSync, and the post-RPC local overlay).
  //
  // A descriptor write loop appends at the current end, so that case grows the
  // cell IN PLACE inside a geometrically reserved buffer — rebuilding the whole
  // cell per call made a write loop quadratic and OOMed the facet on a 26 MiB
  // file. A write that lands on bytes already in the cell still copies, so a
  // view handed out earlier is never mutated underneath its holder.
  //
  // The result is an exactly-sized VIEW over a buffer that may carry reserve.
  // Everything that reads a cell goes through its byteLength — readFileSync
  // copies, statSync sizes it, the supervisor write RPC takes a Uint8Array —
  // with one exception: structured clone carries the whole BACKING BUFFER
  // across that RPC, so the reserve is part of the write payload — and that
  // payload is capped. Measured on a deployed worker: a 26 MiB cell in a
  // doubled 32 MiB buffer silently lost its flush, and normalising it to an
  // exact copy first cost a third copy of the file and killed the write
  // outright. So the reserve doubles while it is cheap, then grows in fixed
  // steps, and stops entirely rather than push a cell past the RPC ceiling —
  // a file that would fit exactly must never be made not to fit.
  const _CELL_RESERVE_CAP = 2 * 1024 * 1024;
  const _CELL_PAYLOAD_CAP = ${MAX_RPC_SAFE_PAYLOAD_BYTES};
  function _spliceCell(base, pos, bytes) {
    const size = Math.max(base.byteLength, pos + bytes.byteLength);
    const capacity = base.buffer.byteLength - base.byteOffset;
    if (pos >= base.byteLength && size <= capacity) {
      const grown = new Uint8Array(base.buffer, base.byteOffset, size);
      grown.fill(0, base.byteLength, pos);
      grown.set(bytes, pos);
      return grown;
    }
    if (size <= capacity) {
      const next = new Uint8Array(new ArrayBuffer(capacity), 0, size);
      next.set(base, 0);
      next.set(bytes, pos);
      return next;
    }
    const wanted = Math.min(Math.max(size, capacity * 2), size + _CELL_RESERVE_CAP);
    const next = new Uint8Array(new ArrayBuffer(wanted < _CELL_PAYLOAD_CAP ? wanted : size), 0, size);
    next.set(base, 0);
    next.set(bytes, pos);
    return next;
  }

  // Overlay \`bytes\` at \`pos\` into the local sync-view cell so sync reads
  // stay coherent after a live ranged write. No-op when there is no cell.
  function _overlayLocalCell(absPath, pos, bytes) {
    const k = _strip(absPath);
    const cell = _writtenCell(absPath);
    if (cell === undefined) return;
    const next = _spliceCell(_asBytes(cell), pos, bytes);
    if (__vfsWrites && k in __vfsWrites) __vfsWrites[k] = next;
    if (__vfsBundle && k in __vfsBundle) __vfsBundle[k] = next;
  }

  function _statObject(meta, key) {
    const type = meta?.type || (meta?.isDir || meta?.isDirectory ? "directory" : "file");
    const isDir = type === "directory";
    const isSymlink = type === "symlink";
    const size = Number(meta?.size || 0);
    const mtime = new Date(Number(meta?.mtime || Date.now()));
    const atime = new Date(Number(meta?.atime || meta?.mtime || Date.now()));
    const mode = Number(meta?.mode ?? (isDir ? 0o755 : 0o644));
    const stat = _localStatObject(key, isDir, isSymlink, size, mode, meta?.uid, meta?.gid);
    stat.atime = atime;
    stat.mtime = mtime;
    stat.ctime = new Date(Number(meta?.ctime ?? meta?.mtime ?? Date.now()));
    stat.birthtime = stat.ctime;
    return stat;
  }

  function _direntObject(name, type) {
    const isDir = type === "directory" || type === "dir";
    const isSymlink = type === "symlink";
    return {
      name,
      isFile: () => !isDir && !isSymlink,
      isDirectory: () => isDir,
      isSymbolicLink: () => isSymlink,
    };
  }

  // Largest single ranged read issued against the supervisor. Every live
  // read path (read streams, whole-file async reads) is expressed as a
  // sequence of reads this size, so neither side ever allocates a whole
  // multi-MB file for one RPC frame.
  const READ_STREAM_CHUNK_BYTES = 65536;

  // Ranged reads issued in the same microtask turn travel as ONE batch.
  //
  // A round trip costs an order of magnitude more than the read behind it,
  // so a program awaiting reads one at a time pays for round trips and
  // nothing else. Nothing here changes what a read sees: every request is
  // the same live ranged read, executed in order, in the caller's turn. The
  // gather window is one microtask, so it can only capture reads the program
  // had already issued concurrently — a sequential loop batches nothing
  // because it has issued nothing else to batch.
  const READ_BATCH_PATH_LIMIT = ${FS_READ_BATCH_PATH_LIMIT};
  const READ_BATCH_REQUEST_BYTES = ${FS_READ_BATCH_REQUEST_BYTES};
  let _openReadBatch = null;

  function _queueRangeRead(supervisor, absPath, pos, want) {
    let batch = _openReadBatch;
    if (batch && (
      batch.requests.length >= READ_BATCH_PATH_LIMIT
      || batch.bytes + want > READ_BATCH_REQUEST_BYTES
    )) {
      _openReadBatch = null;
      _flushReadBatch(batch);
      batch = null;
    }
    if (!batch) {
      batch = { supervisor, requests: [], settlers: [], bytes: 0 };
      _openReadBatch = batch;
      queueMicrotask(() => {
        if (_openReadBatch === batch) _openReadBatch = null;
        _flushReadBatch(batch);
      });
    }
    batch.bytes += want;
    batch.requests.push({ path: absPath, offset: pos, length: want });
    return new Promise((resolve, reject) => { batch.settlers.push({ resolve, reject }); });
  }

  async function _flushReadBatch(batch) {
    globalThis.__nimbusFsRpcReads++;
    try {
      const entries = await __nimbusUseRpcResult(
        batch.supervisor.fsReadBatch(batch.requests), (r) => r,
      );
      for (let i = 0; i < batch.settlers.length; i++) {
        const entry = entries[i];
        if (entry && entry.error) {
          const err = new Error(entry.error.message);
          if (entry.error.code) err.code = entry.error.code;
          batch.settlers[i].reject(err);
        } else {
          batch.settlers[i].resolve(entry ? entry.bytes : null);
        }
      }
    } catch (error) {
      for (const settler of batch.settlers) settler.reject(error);
    }
  }

  /**
   * Read \`want\` bytes at \`pos\`. Async reads always consult the live VFS.
   * A pending sync write is flushed first, so the supervisor remains the
   * authority without losing this facet's newer local bytes.
   * Returns null at EOF, throws ENOENT when the path does not exist.
   */
  async function _readRangeAt(absPath, displayPath, pos, want) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.fsReadBatch === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      let bytes;
      try { bytes = await _queueRangeRead(supervisor, absPath, pos, want); }
      catch (error) { throw _mapSupervisorError(error, "read", displayPath); }
      if (bytes === null || bytes === undefined) throw _fsErr("ENOENT", "open", displayPath);
      return bytes.byteLength === 0 ? null : bytes;
    }
    if (supervisor && typeof supervisor.fsReadRange === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      const bytes = await _fsReadRpc(supervisor.fsReadRange(absPath, pos, want), "read", displayPath, (r) => r);
      if (bytes === null || bytes === undefined) throw _fsErr("ENOENT", "open", displayPath);
      return bytes.byteLength === 0 ? null : bytes;
    }
    const cell = _writtenCell(absPath);
    if (cell !== undefined) {
      const denial = _denialCode(cell);
      if (denial) throw _fsErr(denial, "read", displayPath);
      const bytes = _asBytes(cell);
      if (pos >= bytes.byteLength) return null;
      return bytes.slice(pos, Math.min(bytes.byteLength, pos + want));
    }
    throw _fsErr("ENOENT", "open", displayPath);
  }

  // Every chunk of \`absPath\` from \`from\` to EOF, issued in ONE turn so the
  // read batch carries them together. A stat bounds the walk; a chunk that
  // comes back short or missing still ends the file, exactly as taking them
  // one at a time did, so a file that shrank under the reader is read short
  // rather than read wrong.
  async function _readChunksFrom(absPath, displayPath, supervisor, from) {
    const meta = await _fsRpc(supervisor.stat(absPath), "stat", displayPath, (result) => result);
    const end = meta ? Number(meta.size) || 0 : 0;
    const offsets = [];
    for (let off = from; off < end; off += READ_STREAM_CHUNK_BYTES) offsets.push(off);
    const chunks = await Promise.all(offsets.map((off) => _readRangeAt(
      absPath, displayPath, off, Math.min(READ_STREAM_CHUNK_BYTES, end - off),
    )));
    const parts = [];
    for (const chunk of chunks) {
      if (chunk === null) break;
      parts.push(chunk);
      if (chunk.byteLength < READ_STREAM_CHUNK_BYTES) break;
    }
    return parts;
  }

  async function _liveReadFile(p, opts, skipAcquire) {
    const absPath = _resolve(p);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const supervisor = _supervisor();
    if (!supervisor) throw _fsErr("ENOENT", "open", p);
    // The refetch step of _acquireAndRefetch has already acquired against a
    // fresh cursor, so re-acquiring here would be a redundant round trip
    // that always returns "still R". Every other caller acquires.
    if (!skipAcquire) await _acquireBarrier(supervisor);

    if (typeof supervisor.fsReadRange === "function") {
      // Chunked: the caller wants the whole file, but nothing upstream has
      // to hold it all at once to produce it.
      //
      // A short chunk is the only signal the file ended, so this walk could
      // only ever have one chunk in flight — 65 sequential round trips for a
      // 4 MiB file, each costing far more than the read behind it. The FIRST
      // chunk still costs exactly one trip and settles it for every file
      // that fits in one. When it comes back full there is demonstrably
      // more, and a stat says how much, so the remainder is issued together
      // and the read batch carries it in a single trip.
      const parts = [];
      let total = 0;
      for (;;) {
        const chunk = await _readRangeAt(absPath, p, total, READ_STREAM_CHUNK_BYTES);
        if (chunk === null) break;
        parts.push(chunk);
        total += chunk.byteLength;
        if (chunk.byteLength < READ_STREAM_CHUNK_BYTES) break;
        if (typeof supervisor.stat !== "function") continue;
        for (const rest of await _readChunksFrom(absPath, p, supervisor, total)) {
          parts.push(rest);
          total += rest.byteLength;
        }
        break;
      }
      const bytes = parts.length === 1 ? parts[0] : _concatBytes(parts, total);
      _installResident(absPath, bytes);
      return encoding ? _asString(bytes) : __BufferMod.from(bytes);
    }

    if (typeof supervisor.readFile === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      const text = await _fsReadRpc(supervisor.readFile(absPath), "open", p, (result) => result);
      if (text !== null && text !== undefined) {
        _installResident(absPath, text);
        return encoding ? _asString(text) : __BufferMod.from(text);
      }
    }

    throw _fsErr("ENOENT", "open", p);
  }

  function _concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.byteLength; }
    return out;
  }

  async function _readFileAsync(p, opts) {
    const supervisor = _supervisor();
    if (supervisor && (
      typeof supervisor.fsReadRange === "function" ||
      typeof supervisor.readFile === "function"
    )) {
      const out = await _liveReadFile(p, opts);
      _residencySatisfied(_resolve(p));
      return out;
    }
    return readFileSync(p, opts);
  }

  async function _statAsync(p) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.stat === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _acquireBarrier(supervisor);
      const meta = await _fsRpc(supervisor.stat(absPath), "stat", p, (result) => result);
      if (meta) return _statObject(meta);
      throw _fsErr("ENOENT", "stat", p);
    }
    return statSync(p);
  }

  async function _lstatAsync(p) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.lstat === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _acquireBarrier(supervisor);
      const meta = await _fsRpc(supervisor.lstat(absPath), "lstat", p, (result) => result);
      if (meta) return _statObject(meta);
      throw _fsErr("ENOENT", "lstat", p);
    }
    return lstatSync(p);
  }

  async function _readdirAsync(p, opts) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.readdir === "function") {
      const key = _strip(absPath);
      const prefix = key ? key + "/" : "";
      await _acquireBarrier(supervisor);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      for (const localPath of Object.keys(__vfsWrites || {})) {
        if (localPath !== key && localPath.startsWith(prefix)) {
          await _flushLocalPathToSupervisor("/" + localPath, supervisor);
        }
      }
      for (const localPath of Object.keys(__vfsDirs || {})) {
        if (localPath !== key && localPath.startsWith(prefix)) {
          await _flushLocalPathToSupervisor("/" + localPath, supervisor);
        }
      }
      const entries = await _fsRpc(supervisor.readdir(absPath), "scandir", p, (result) => result);
      if (Array.isArray(entries)) {
        // Every local mutation under this directory was just flushed, so the
        // live listing is strictly newer than the spawn-time snapshot. Record
        // its shape: the sync existence view must not go on contradicting a
        // directory this very process has enumerated. Names only — size, mode
        // and ownership are not observable here and are never invented.
        if (__vfsManifest) __vfsManifest[key] = entries.map((entry) => entry.name);
        // Which of the children are directories IS observable here, and it is
        // the one fact a later synchronous listing cannot recover on its own —
        // an unwalked subdirectory has no manifest entry, so without this it
        // reads back as a file. A directory's size is 0 in this filesystem, so
        // recording it invents nothing; file children are left alone, because
        // their size is not knowable from a listing and must not be guessed.
        const metadataTable = _metadataTable();
        if (metadataTable) {
          for (const entry of entries) {
            if (entry.type !== "directory") continue;
            const child = prefix + entry.name;
            if (child in metadataTable) continue;
            metadataTable[child] = {
              type: "directory", size: 0, mode: 0o755, uid: cred.uid, gid: cred.gid,
            };
          }
        }
        if (opts?.withFileTypes) {
          return entries
            .map((entry) => _direntObject(entry.name, entry.type))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        return entries.map((entry) => entry.name).sort();
      }
      throw _fsErr("ENOENT", "scandir", p);
    }
    return readdirSync(p, opts);
  }

  async function _existsAsync(p) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.exists === "function") {
      const absPath = _resolve(p);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      return !!(await __nimbusUseRpcResult(supervisor.exists(absPath), (r) => r));
    }
    return existsSync(p);
  }

  async function _readlinkAsync(p) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.readlink === "function") {
      const target = await _fsRpc(supervisor.readlink(_resolve(p)), "readlink", p, (result) => result);
      if (target !== null && target !== undefined) return target;
    }
    throw _fsErr("EINVAL", "readlink", p);
  }

  async function _symlinkAsync(target, path) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.symlink === "function") {
      await _fsRpc(supervisor.symlink(String(target), _resolve(path)), "symlink", path, () => undefined);
      _markVfsStale();
      return;
    }
    throw _fsErr("ENOSYS", "symlink", path);
  }

  async function _writeFileAsync(p, data, opts) {
    const absPath = _resolve(p);
    writeFileSync(p, data, opts);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.writeFile === "function") {
      await _announceLocalDirs(absPath, supervisor);
      await __nimbusFlushVfsWrite(absPath, (content) =>
        _fsRpc(supervisor.writeFile(absPath, content), "write", p, () => undefined)
      );
      _markVfsStale();
    }
  }

  async function _appendFileAsync(p, data, opts) {
    const absPath = _resolve(p);
    appendFileSync(p, data, opts);
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.writeFile !== "function") return;
    await _announceLocalDirs(absPath, supervisor);
    await __nimbusFlushVfsWrite(
      absPath,
      (content, snapshot) => _fsRpc(
        __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
        "write", p,
        (result) => result,
      ),
    );
    _markVfsStale();
  }

  async function _mkdirAsync(p, opts) {
    mkdirSync(p, opts);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.mkdir === "function") {
      await _fsRpc(supervisor.mkdir(_resolve(p)), "mkdir", p, () => undefined);
      _markVfsStale();
    }
  }

  async function _unlinkAsync(p) {
    unlinkSync(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.unlink === "function") {
      await _fsRpc(supervisor.unlink(_resolve(p)), "unlink", p, () => undefined);
      _markVfsStale();
    }
  }

  async function _rmdirAsync(p) {
    rmdirSync(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.rmdir === "function") {
      await _fsRpc(supervisor.rmdir(_resolve(p)), "rmdir", p, () => undefined);
      _markVfsStale();
    }
  }

  async function _renameAsync(oldP, newP) {
    renameSync(oldP, newP);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.rename === "function") {
      await _fsRpc(supervisor.rename(_resolve(oldP), _resolve(newP)), "rename", oldP, () => undefined);
      _markVfsStale();
    }
  }

  async function _truncateAsync(p, len) {
    const absPath = _resolve(p);
    const size = Math.max(0, Math.trunc(Number(len) || 0));
    const supervisor = _supervisor();
    const localCell = _bundleLookup(absPath);
    if (supervisor && typeof supervisor.fsTruncate === "function") {
      await _announceLocalDirs(absPath, supervisor);
      const k = _strip(absPath);
      if (__vfsWrites && k in __vfsWrites) {
        const append = __nimbusCapturePendingVfsAppend(k);
        if (append) {
          const flush = __nimbusFlushVfsWrite(
            absPath,
            (content, snapshot) =>
              __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
          );
          await __nimbusQueueVfsMutation(absPath, async () => {
            await flush;
            await _fsRpc(
              supervisor.fsTruncate(absPath, size),
              "truncate", p,
              () => undefined,
            );
          });
          _markVfsStale();
          return;
        }
        // Unflushed sync writes: trim locally, then flush the pending
        // cell whole (it was going to flush whole anyway).
        if (localCell === undefined) throw _fsErr("ENOENT", "truncate", p);
        _truncateLocalCell(absPath, size);
        await _flushLocalPathToSupervisor(absPath, supervisor);
        return;
      }
      // Live file is the source of truth — supervisor trims only the
      // boundary chunk; ENOENT propagates when it does not exist.
      const generation = __vfsWriteGenerations[k];
      await __nimbusQueueVfsMutation(absPath, () =>
        _fsRpc(supervisor.fsTruncate(absPath, size), "truncate", p, () => undefined)
      );
      if (__vfsWriteGenerations[k] === generation && localCell !== undefined) {
        _truncateLocalCell(absPath, size);
      }
      _markVfsStale();
      return;
    }
    if (localCell === undefined) throw _fsErr("ENOENT", "truncate", p);
    _truncateLocalCell(absPath, size);
  }

  function utimesSync(p, atime, mtime) {
    if (!existsSync(p)) throw _fsErr("ENOENT", "utimes", p);
    const absPath = _resolve(p);
    _recordLocalTimes(absPath, atime, mtime, "utimes", p);
  }

  function lutimesSync(p, atime, mtime) {
    if (!existsSync(p)) throw _fsErr("ENOENT", "lutimes", p);
    const absPath = _resolve(p);
    _recordLocalTimes(absPath, atime, mtime, "lutimes", p);
  }

  async function _utimesAsync(p, atime, mtime, opts) {
    const followSymlinks = !(opts && opts.followSymlinks === false);
    const syscall = followSymlinks ? "utimes" : "lutimes";
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    let localExists = false;
    try { localExists = existsSync(p); } catch {}
    if (!localExists && (!supervisor || typeof supervisor.utimes !== "function")) {
      throw _fsErr("ENOENT", syscall, p);
    }
    const time = _recordLocalTimes(absPath, atime, mtime, syscall, p);
    if (supervisor && typeof supervisor.utimes === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _fsRpc(
        supervisor.utimes(absPath, time.atimeMs, time.mtimeMs),
        syscall, p,
        () => undefined,
      );
      _markVfsStale();
      return;
    }
    if (!supervisor && !existsSync(p)) throw _fsErr("ENOENT", syscall, p);
  }

  function chmodSync(p, mode) {
    if (!existsSync(p)) throw _fsErr("ENOENT", "chmod", p);
    // Local-visible immediately (statSync overlay); the live write-through
    // rides the next flush of the same path — same fidelity as utimesSync.
    _localModes[_strip(_resolve(p))] = _coerceMode(mode, "chmod", p);
  }

  async function _chmodAsync(p, mode) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    let localExists = false;
    try { localExists = existsSync(p); } catch {}
    if (!localExists && (!supervisor || typeof supervisor.chmod !== "function")) {
      throw _fsErr("ENOENT", "chmod", p);
    }
    const m = _coerceMode(mode, "chmod", p);
    _localModes[_strip(absPath)] = m;
    if (supervisor && typeof supervisor.chmod === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      _markVfsStale();
      return;
    }
    if (!supervisor && !existsSync(p)) throw _fsErr("ENOENT", "chmod", p);
  }

  function _coerceId(value, syscall, p) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0) throw _fsErr("EINVAL", syscall, p);
    return id;
  }

  async function _chownAsync(p, uid, gid, opts, syscallOverride) {
    const followSymlinks = !(opts && opts.followSymlinks === false);
    const syscall = syscallOverride || (followSymlinks ? "chown" : "lchown");
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.chown !== "function") {
      if (!existsSync(p)) throw _fsErr("ENOENT", syscall, p);
      throw _fsErr("ENOSYS", syscall, p);
    }
    const nextUid = _coerceId(uid, syscall, p);
    const nextGid = _coerceId(gid, syscall, p);
    await _flushLocalPathToSupervisor(absPath, supervisor);
    await _fsRpc(supervisor.chown(absPath, nextUid, nextGid, opts), syscall, p, () => undefined);
    const meta = _metadata(absPath);
    if (meta) { meta.uid = nextUid; meta.gid = nextGid; }
    _markVfsStale();
  }

  function _modeAllows(meta, want) {
    if (want === 0) return true;
    const mode = Number(meta?.mode ?? 0o644) & 0o777;
    const currentUid = Number(cred.uid);
    const currentGid = Number(cred.gid);
    const groups = cred.groups.map(Number);
    if (currentUid === 0) {
      if ((want & 1) !== 0 && (mode & 0o111) === 0) return false;
      return true;
    }
    const shift = currentUid === Number(meta?.uid ?? 1000)
      ? 6
      : (currentGid === Number(meta?.gid ?? 1000) || groups.includes(Number(meta?.gid ?? 1000))) ? 3 : 0;
    const available = (mode >> shift) & 7;
    return (available & want) === want;
  }

  function _ensureAncestorsTraversable(absPath, syscall, p) {
    const parts = _strip(absPath).split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index++) {
      const ancestorMeta = _metadata("/" + parts.slice(0, index).join("/"));
      if (ancestorMeta && !_modeAllows(ancestorMeta, 1)) throw _fsErr("EACCES", syscall, p);
    }
  }

  function _ensureWritable(absPath, syscall, p) {
    _ensureAncestorsTraversable(absPath, syscall, p);
    const cell = _bundleLookup(absPath);
    const meta = _metadata(absPath);
    // The ladder rather than existsSync: a write to a path outside the staged
    // view is a legitimate create, and must not be turned into a refusal by
    // the check that guards it.
    if (meta !== undefined || cell !== undefined || _statLadder(absPath) !== undefined) {
      const denial = _denialCode(cell);
      if (denial || !_modeAllows(meta, 2)) throw _fsErr(denial || "EACCES", syscall, p);
      return;
    }

    const parent = __pathMod.dirname(absPath);
    const parentMeta = _metadata(parent);
    if (parentMeta) {
      if (parentMeta.type && parentMeta.type !== "directory") throw _fsErr("ENOTDIR", syscall, p);
      if (!_modeAllows(parentMeta, 3)) throw _fsErr("EACCES", syscall, p);
      return;
    }

    const parentKey = _strip(parent);
    const parentIsLocal = parent === cwd || parent === "/" ||
      (!!__vfsDirs && parentKey in __vfsDirs) ||
      (!!__vfsManifest && parentKey in __vfsManifest);
    if (parentIsLocal || _supervisor()) return;
    throw _fsErr("ENOENT", syscall, p);
  }

  function accessSync(p, mode) {
    const absPath = _resolve(p);
    const cell = _bundleLookup(absPath);
    const meta = _metadata(absPath);
    if (cell === undefined && meta === undefined && !existsSync(p)) throw _fsErr("ENOENT", "access", p);
    const requested = mode === undefined ? 0 : Number(mode);
    if (!Number.isInteger(requested) || requested < 0 || (requested & ~7) !== 0) {
      throw _fsErr("EINVAL", "access", p);
    }
    _ensureAncestorsTraversable(absPath, "access", p);
    const denial = _denialCode(cell);
    if ((requested & 4) !== 0 && denial) throw _fsErr(denial, "access", p);
    if (!_modeAllows(meta, requested)) throw _fsErr("EACCES", "access", p);
  }

  async function _accessAsync(p, mode) {
    const requested = mode === undefined ? 0 : Number(mode);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.access === "function") {
      const absPath = _resolve(p);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _fsRpc(supervisor.access(absPath, requested), "access", p, () => undefined);
      return;
    }
    accessSync(p, requested);
  }

  // ── readFileSync ──
  // Returns a Buffer when no encoding requested, a string otherwise.
  // The cell shape (string vs Uint8Array) drives conversion:
  //   - text encoding requested + string cell → return string as-is
  //   - text encoding requested + bytes cell → UTF-8 decode bytes
  //   - no encoding + string cell → wrap _enc.encode(...) as Buffer
  //   - no encoding + bytes cell → wrap bytes as Buffer (no copy)
  function readFileSync(p, opts) {
    const absPath = _resolve(p);
    _ensureAncestorsTraversable(absPath, "open", p);
    const content = _bundleLookup(absPath);
    if (content === undefined) {
      throw _notResidentError(absPath, p, "open", "fs.promises.readFile");
    }
    const denial = _denialCode(content);
    if (denial) throw _fsErr(denial, "open", p);
    _residencySatisfied(absPath);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    if (encoding) {
      // text encoding requested — produce a string regardless of cell shape.
      return _asString(content);
    }
    // No encoding requested — produce a Buffer-shaped Uint8Array.
    if (_isBytes(content)) return __BufferMod.from(content);
    return __BufferMod.from(content);
  }

  // ── writeFileSync ──
  // Uint8Array is preserved as bytes (no UTF-8 round-trip → no
  // EF-BF-BD mangling on bytes ≥ 0x80). String is preserved as string
  // (the hot path for source code / package.json / user JS).
  // Anything else is stringified (Node's behaviour for e.g. numbers).
  function writeFileSync(p, data, opts) {
    const absPath = _resolve(p);
    _ensureWritable(absPath, "open", p);
    const k = _strip(absPath);
    let cell;
    if (data instanceof Uint8Array) cell = data;
    else if (typeof data === "string") cell = data;
    else cell = String(data);
    _parkWrite(k, cell);
  }

  // ── appendFileSync ──
  // Concat semantics: if EITHER existing or new data is bytes, the
  // combined cell is bytes (lossless for both). When both are strings,
  // stay string (avoids re-encoding ASCII through TextEncoder).
  function appendFileSync(p, data, opts) {
    const absPath = _resolve(p);
    _ensureWritable(absPath, "open", p);
    const k = _strip(absPath);
    const previousAppend = __nimbusCapturePendingVfsAppend(k);
    const hadPendingWrite = Object.prototype.hasOwnProperty.call(__vfsWrites, k);
    const existing = _bundleLookup(absPath);
    const existingDefined = existing !== undefined;
    const dataIsBytes = data instanceof Uint8Array;
    const existingIsBytes = existingDefined && _isBytes(existing);

    let cell;
    if (!existingDefined) {
      // No prior content — same shape as a writeFileSync.
      if (dataIsBytes) cell = data;
      else if (typeof data === "string") cell = data;
      else cell = String(data);
    } else if (dataIsBytes || existingIsBytes) {
      // Promote both to bytes and concat.
      const a = _asBytes(existing);
      const b = _asBytes(dataIsBytes ? data : (typeof data === "string" ? data : String(data)));
      const out = new Uint8Array(a.byteLength + b.byteLength);
      out.set(a, 0);
      out.set(b, a.byteLength);
      cell = out;
    } else {
      // Both strings — string concat.
      cell = existing + (typeof data === "string" ? data : String(data));
    }
    _parkWrite(k, cell);
    // Bundle content is only a sync-view cache and may be stale. It can supply
    // the local display fragment, but only a pending full write owns its prefix.
    if (!hadPendingWrite || previousAppend) {
      const appended = _asBytes(
        dataIsBytes ? data : (typeof data === "string" ? data : String(data)),
      );
      __nimbusRecordVfsAppend(k, appended, _asBytes(cell), previousAppend);
    }
  }

  // ── existsSync ──
  function existsSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (_metadata(absPath) !== undefined) { _residencySatisfied(absPath); return true; }
    if (__vfsBundle && k in __vfsBundle) { _residencySatisfied(absPath); return true; }
    if (__vfsWrites && k in __vfsWrites) { _residencySatisfied(absPath); return true; }
    if (__vfsDirs && k in __vfsDirs) { _residencySatisfied(absPath); return true; }
    // W2.5b root-cause fix: consult the manifest BEFORE falling back to
    // the O(N) bundle-prefix scan. The manifest is uncapped and always
    // reflects the real directory shape, even when the file content for
    // a directory's contents was excluded by the 4 MiB / 500-file content
    if (__vfsManifest) {
      if (k in __vfsManifest) { _residencySatisfied(absPath); return true; }
      // Path may be a file listed by its parent's manifest entry.
      const slash = k.lastIndexOf("/");
      const parent = slash >= 0 ? k.slice(0, slash) : "";
      const name = slash >= 0 ? k.slice(slash + 1) : k;
      const sib = __vfsManifest[parent];
      if (sib && sib.indexOf(name) !== -1) { _residencySatisfied(absPath); return true; }
    }
    // Last-resort: bundle dir entries
    if (__vfsBundle && (k in __vfsBundle || __residentAnyUnder(k + "/"))) {
      _residencySatisfied(absPath);
      return true;
    }
    // Nothing found — which is only an answer if the enclosing directory was
    // enumerated. Node's existsSync never throws, so the false below is
    // provisional: the miss is recorded, the listing that settles it is pulled
    // in, and the exit report fails the run if the path turns out to have been
    // there all along.
    if (!_absenceIsKnown(absPath)) {
      _recordUnmapped(absPath, "access");
      return false;
    }
    _residencySatisfied(absPath);
    return false;
  }

  // ── statSync ──
  function statSync(p, opts) {
    const absPath = _resolve(p);
    _ensureAncestorsTraversable(absPath, "stat", p);
    return _statResolved(absPath, p, opts);
  }

  // The stat ladder for a path whose ancestors the caller has already
  // checked. Reading it back out of statSync lets the sync read path
  // classify a miss without redoing the resolve and ancestor walk it just
  // performed — that path runs on every module-resolution probe.
  function _statResolved(absPath, p, opts) {
    const stat = _statLadder(absPath);
    // An answer settles the path, including the honest "not there" below —
    // what the ledger is for is reads that went unanswered, not reads that came
    // back with news the caller did not want. A PROVISIONAL not-there is not an
    // answer, so the unmapped branch deliberately leaves the record standing.
    if (stat !== undefined) { _residencySatisfied(absPath); return stat; }
    // Nothing in the view describes the path, and there are two very different
    // reasons for that. Only one of them means the file is not there.
    if (_absenceIsKnown(absPath)) _residencySatisfied(absPath);
    else _recordUnmapped(absPath, "stat");
    // Node's statSync honors { throwIfNoEntry: false } by returning undefined
    // for a missing path instead of throwing.
    if (opts && opts.throwIfNoEntry === false) return undefined;
    throw _fsErr("ENOENT", "stat", p);
  }

  /**
   * The stat ladder itself: everything the sync view can say about a path, or
   * undefined when it has nothing to say. It never decides what "nothing"
   * MEANS — absence and ignorance are different answers and only one of them
   * is a condition a program can act on, so the callers classify.
   */
  function _statLadder(absPath) {
    const k = _strip(absPath);
    // Content written this exec session is newer than the spawn-time
    // metadata snapshot, so it — not __vfsMetadata — is authoritative for
    // size. Without this, fstatSync/statSync on a file we just wrote report
    // the pre-write length.
    if (__vfsWrites && k in __vfsWrites && _denialCode(__vfsWrites[k]) === null) {
      const meta = _metadata(absPath);
      const size = _byteLen(__vfsWrites[k]);
      // Correct only the size — reusing the metadata record keeps the type
      // and the recorded timestamps stable, so mtime-based change detection
      // (make, tsc --build, watchers) does not see every call as a change.
      if (meta) return _statObject({ ...meta, size }, k);
      return _localStatObject(
        k, false, false, size, 0o666 & ~__processUmask, cred.uid, cred.gid,
      );
    }
    const metadata = _metadata(absPath);
    if (metadata) return _statObject(metadata, k);
    // Check if it's a known directory written this exec session
    if (__vfsDirs && k in __vfsDirs) {
      return _localStatObject(k, true, false, 0, 0o777 & ~__processUmask, cred.uid, cred.gid);
    }
    // W2.5b: consult uncapped manifest first for directory shape.
    if (__vfsManifest && k in __vfsManifest) {
      return _localStatObject(k, true, false, 0, 0o755, cred.uid, cred.gid);
    }
    // File with content embedded?
    const content = _bundleLookup(absPath);
    if (content !== undefined) {
      // _byteLen handles both string (UTF-8 encode) and Uint8Array
      // (byteLength) — fixes binary writes from reporting the
      // post-corruption byte count.
      const size = _byteLen(content);
      return _localStatObject(k, false, false, size, 0o666 & ~__processUmask, cred.uid, cred.gid);
    }
    // File listed in parent's manifest but content was capped out — return
    // a zero-size file stat so callers like fs.stat / fs.statSync see the
    // file as present (downstream readFileSync will surface ENOENT if it
    // actually tries to read content; many consumers only need stat).
    if (__vfsManifest) {
      const slash = k.lastIndexOf("/");
      const parent = slash >= 0 ? k.slice(0, slash) : "";
      const name = slash >= 0 ? k.slice(slash + 1) : k;
      const sib = __vfsManifest[parent];
      if (sib && sib.indexOf(name) !== -1) {
        return _localStatObject(k, false, false, 0, 0o644, cred.uid, cred.gid);
      }
    }
    // Last-resort: bundle prefix scan (legacy path).
    if (__vfsBundle && __residentAnyUnder(k + "/")) {
      return _localStatObject(k, true, false, 0, 0o755, cred.uid, cred.gid);
    }
    return undefined;
  }

  // ── lstatSync (alias for statSync in our VFS — no symlinks) ──
  function lstatSync(p, opts) { return statSync(p, opts); }

  // ── readdirSync ──
  // W2.5b root-cause fix: prefer the uncapped __vfsManifest for directory
  // listings. The legacy bundle-prefix scan is kept as a fallback for paths
  // not in the manifest (e.g. dirs created at exec time via mkdirSync) and
  // is unioned with __vfsWrites so newly-written files become visible.
  function readdirSync(p, opts) {
    const absPath = _resolve(p);
    _ensureAncestorsTraversable(absPath, "scandir", p);
    const metadata = _metadata(absPath);
    if (metadata && !_modeAllows(metadata, 4)) throw _fsErr("EACCES", "scandir", p);
    const k = _strip(absPath);
    // A listing is the one answer with no way to express doubt: an array is a
    // complete enumeration by definition, so returning what happens to be
    // known asserts that nothing else is there. Only a directory the walk
    // enumerated, or one this process created, can honestly be listed.
    if (!_dirEnumerated(k) && !_bundleHasChildren(k)) {
      // An authority exists that this call cannot reach, so an empty array
      // would be a claim about a directory nothing ever opened. Refuse, and
      // pull the listing in for the next one.
      //
      // This is the one caller that keeps refusing. Everywhere else the sync
      // view answers a path it cannot map with the not-found the program was
      // written to handle, provisionally, and lets the exit report settle
      // whether that answer was true. A listing has no such answer to give:
      // "no config yet, write one" is an idiom every program implements, and
      // there is no counterpart for a directory — a caller handed ENOENT for a
      // template tree has nowhere to go but the same wrong branch an empty
      // array sent it down, and the array at least it could not detect.
      if (_supervisor()) {
        throw _refuseUnmapped(absPath, p, "scandir", "fs.promises.readdir");
      }
      // No authority: the staged tables are the whole filesystem. A path they
      // do not describe is missing, and one they describe with no children is
      // genuinely empty.
      if (_statLadder(absPath) === undefined) throw _fsErr("ENOENT", "scandir", p);
    }
    const prefix = k ? k + "/" : "";
    const names = new Set();
    // 1. Manifest-supplied children (the authoritative source for installed pkgs).
    if (__vfsManifest && k in __vfsManifest) {
      for (const n of __vfsManifest[k]) names.add(n);
    }
    // 2. Bundle-prefix fallback (covers older paths or runtime-mkdir'd ones
    //    that aren't in the manifest yet).
    if (__vfsBundle) {
      for (const bk of __residentUnder(prefix)) {
        const seg = bk.substring(prefix.length).split("/")[0];
        if (seg) names.add(seg);
      }
    }
    // 3. Files written during this exec session.
    if (__vfsWrites) {
      for (const wk in __vfsWrites) {
        if (wk.startsWith(prefix)) {
          const rest = wk.substring(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
    }
    // 4. Dirs created during this exec session.
    if (__vfsDirs) {
      for (const dk in __vfsDirs) {
        if (dk.startsWith(prefix)) {
          const rest = dk.substring(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
    }
    _residencySatisfied(absPath);
    const arr = [...names].sort();
    if (opts?.withFileTypes) {
      return arr.map(n => {
        const fp = prefix + n;
        // Manifest is the definitive isDir source; fall back to bundle scan.
        // The metadata record sits between them: a directory that was listed
        // but never walked has no manifest entry of its own, and calling it a
        // file is how a template tree full of subdirectories reads back as a
        // tree full of nothing.
        const isDir =
          (!!__vfsManifest && fp in __vfsManifest) ||
          (!!__vfsDirs && fp in __vfsDirs) ||
          _metadata(fp)?.type === "directory" ||
          (!!__vfsBundle && __residentAnyUnder(fp + "/"));
        return { name: n, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false };
      });
    }
    return arr;
  }

  // ── mkdirSync ──
  function mkdirSync(p, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (opts?.recursive) {
      const parts = k.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) { cur = cur ? cur + "/" + part : part; __vfsDirs[cur] = true; }
    } else {
      __vfsDirs[k] = true;
    }
  }

  // ── unlinkSync ──
  function unlinkSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (__vfsBundle) delete __vfsBundle[k];
    if (__vfsWrites) delete __vfsWrites[k];
    _forgetSyncPath(k);
  }

  // ── rmdirSync ──
  function rmdirSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (__vfsDirs) delete __vfsDirs[k];
    _forgetSyncPath(k);
  }

  // ── renameSync ──
  function renameSync(oldP, newP) {
    const oldK = _strip(_resolve(oldP));
    const newK = _strip(_resolve(newP));
    const content = __vfsBundle?.[oldK] ?? __vfsWrites?.[oldK];
    if (content !== undefined) {
      _parkWrite(newK, content);
      if (__vfsBundle) delete __vfsBundle[oldK];
      delete __vfsBundleRevisions[oldK];
      delete __vfsWrites[oldK];
      // The stat record travels with the content: dropping it would lose the
      // mode/ownership, and leaving it behind would keep the source path
      // reporting as an existing file this rename already moved away.
      const metadata = _metadataTable();
      const moved = metadata ? metadata[oldK] : undefined;
      _forgetSyncPath(oldK);
      if (moved) metadata[newK] = moved;
    }
  }

  // ── copyFileSync ──
  function copyFileSync(src, dest) {
    writeFileSync(dest, readFileSync(src, "utf8"));
  }

  // ── realpathSync (X.5-T per X5Z5-plan §4.3 + X526b-retro §3.1) ──
  // Sync realpath stays local and identity-resolves. Async symlink
  // operations use the live supervisor bridge below.
  // .native static is required by TypeScript's getNodeSystem at
  function realpathSync(p, opts) { return _resolve(String(p)); }
  realpathSync.native = realpathSync;

  // ── Async variants (thin wrappers returning via callback) ──
  function readFile(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readFileAsync(p, opts).then((r) => { if (cb) cb(null, r); }).catch((e) => { if (cb) cb(e); });
  }
  function writeFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _writeFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function appendFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _appendFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function stat(p, cb) { _statAsync(p).then((s) => cb(null, s)).catch((e) => cb(e)); }
  function lstat(p, cb) { _lstatAsync(p).then((s) => cb(null, s)).catch((e) => cb(e)); }
  function readdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readdirAsync(p, opts).then((d) => cb(null, d)).catch((e) => cb(e));
  }
  function exists(p, cb) { _existsAsync(p).then((ok) => cb(ok)).catch(() => cb(false)); }
  function mkdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _mkdirAsync(p, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function unlink(p, cb) { _unlinkAsync(p).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function rename(oldP, newP, cb) { _renameAsync(oldP, newP).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function utimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lutimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function chmod(p, mode, cb) { _chmodAsync(p, mode).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function chown(p, uid, gid, cb) { _chownAsync(p, uid, gid).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lchown(p, uid, gid, cb) { _chownAsync(p, uid, gid, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function access(p, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    _accessAsync(p, mode).then(() => cb(null)).catch((e) => cb(e));
  }

  // ── open-flag parsing for fs.promises.open ──
  function _parseOpenFlags(flags) {
    if (typeof flags === "number") {
      const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_EXCL = 128, O_TRUNC = 512, O_APPEND = 1024;
      return {
        read: (flags & O_WRONLY) === 0,
        write: (flags & (O_WRONLY | O_RDWR)) !== 0,
        append: (flags & O_APPEND) !== 0,
        create: (flags & O_CREAT) !== 0,
        truncate: (flags & O_TRUNC) !== 0,
        exclusive: (flags & O_EXCL) !== 0,
      };
    }
    const s = String(flags === undefined || flags === null ? "r" : flags);
    const plus = s.indexOf("+") !== -1;
    const exclusive = s.indexOf("x") !== -1;
    const base = s.charAt(0);
    if (base === "w") return { read: plus, write: true, append: false, create: true, truncate: true, exclusive };
    if (base === "a") return { read: plus, write: true, append: true, create: true, truncate: false, exclusive };
    return { read: true, write: plus, append: false, create: false, truncate: false, exclusive };
  }

  // ── FileHandle — returned from fs.promises.open ──
  // Stateless-live design: the handle owns path/flags/position FACET-side
  // and issues ranged supervisor RPCs (fsReadRange/fsWriteRange/fsTruncate),
  // so there is no server-side fd state to lose across supervisor
  // hibernation and partial reads/writes never move whole files. Unflushed
  // sync writes (__vfsWrites) take read precedence; the local sync view is
  // overlaid on writes so readFileSync stays coherent.
  let __nextFileHandleFd = 3;
  const __fileHandles = new Map();
  class __FileHandle {
    constructor(path, flagInfo, size) {
      this._path = path;
      this._abs = _resolve(path);
      this._flags = flagInfo;
      this._position = 0;
      this._size = size;
      this._closed = false;
      this.fd = __nextFileHandleFd++;
      __fileHandles.set(this.fd, this);
    }
    _assertOpen(syscall) {
      if (this._closed) throw _fsErr("EBADF", syscall, this._path);
    }
    async read(buffer, offset, length, position) {
      this._assertOpen("read");
      if (!this._flags.read) throw _fsErr("EBADF", "read", this._path);
      if (buffer && !(buffer instanceof Uint8Array)) {
        // options-object form: read({ buffer, offset, length, position })
        const o = buffer;
        buffer = o.buffer; offset = o.offset; length = o.length; position = o.position;
      }
      if (!buffer) buffer = __BufferMod.alloc(16384);
      const off = offset || 0;
      const want = (length === undefined || length === null) ? buffer.length - off : Math.max(0, Number(length));
      const pos = (position === undefined || position === null) ? this._position : Math.max(0, Number(position));
      const slice = await _readRangeAt(this._abs, this._path, pos, want) || new Uint8Array(0);
      buffer.set(slice, off);
      if (position === undefined || position === null) this._position = pos + slice.length;
      return { bytesRead: slice.length, buffer };
    }
    async write(buffer, offset, length, position) {
      this._assertOpen("write");
      if (!this._flags.write) throw _fsErr("EBADF", "write", this._path);
      let bytes;
      let pos;
      if (typeof buffer === "string") {
        // write(string[, position[, encoding]])
        bytes = _enc.encode(buffer);
        pos = (offset === undefined || offset === null) ? null : Math.max(0, Number(offset));
      } else {
        const o = offset || 0;
        const l = (length === undefined || length === null) ? buffer.length - o : Number(length);
        bytes = buffer.subarray(o, o + l);
        pos = (position === undefined || position === null) ? null : Math.max(0, Number(position));
      }
      const at = this._flags.append ? this._size : (pos === null ? this._position : pos);
      if (bytes.byteLength === 0) {
        return { bytesWritten: 0, buffer };
      }
      let writeAt = at;
      const supervisor = _supervisor();
      if (supervisor && typeof supervisor.fsWriteRange === "function") {
        const pendingSnapshot = __nimbusCaptureVfsWrite(this._abs);
        const overlayGeneration = pendingSnapshot
          ? pendingSnapshot.generation + 1
          : __vfsWriteGenerations[_strip(this._abs)];
        const flush = __nimbusFlushVfsWrite(
          this._abs,
          (content, snapshot) =>
            __nimbusPersistVfsWrite(supervisor, this._abs, content, snapshot),
        );
        await __nimbusQueueVfsMutation(this._abs, async () => {
          await flush;
          if (this._flags.append && typeof supervisor.stat === "function") {
            const meta = await _fsRpc(
              supervisor.stat(this._abs),
              "stat", this._path,
              (result) => result,
            );
            if (meta && meta.type === "file") writeAt = Number(meta.size) || 0;
          }
          await _fsRpc(
            supervisor.fsWriteRange(this._abs, writeAt, bytes),
            "write", this._path,
            () => undefined,
          );
          const key = _strip(this._abs);
          if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key) &&
              __vfsWriteGenerations[key] === overlayGeneration) {
            _overlayLocalCell(this._abs, writeAt, bytes);
          }
        });
        _markVfsStale();
      } else {
        const cell = _writtenCell(this._abs);
        this._commit(_spliceCell(cell === undefined ? new Uint8Array(0) : _asBytes(cell), at, bytes));
      }
      this._size = Math.max(this._size, writeAt + bytes.byteLength);
      if (pos === null || this._flags.append) this._position = writeAt + bytes.byteLength;
      return { bytesWritten: bytes.byteLength, buffer };
    }
    async readFile(opts) { return _readFileAsync(this._path, opts); }
    async writeFile(data, opts) {
      await _writeFileAsync(this._path, data, opts);
      this._size = _byteLen(typeof data === "string" || data instanceof Uint8Array ? data : String(data));
    }
    async appendFile(data, opts) {
      await _appendFileAsync(this._path, data, opts);
      this._size += _byteLen(typeof data === "string" || data instanceof Uint8Array ? data : String(data));
    }
    async stat() { return _statAsync(this._path); }
    async truncate(len) {
      this._assertOpen("ftruncate");
      if (!this._flags.write) throw _fsErr("EBADF", "ftruncate", this._path);
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      await _truncateAsync(this._path, size);
      this._size = size;
    }
    // ── Synchronous descriptor I/O ──
    // A node facet has NO synchronous I/O primitive (no JSPI suspension, as
    // the WASI runtimes have), so sync fd ops are served from exactly the
    // resident view readFileSync/writeFileSync use — __vfsWrites overlaid on
    // __vfsBundle. Content that is not resident cannot be fetched without
    // blocking, so those calls raise EAGAIN rather than invent bytes.
    // Writes buffer into __vfsWrites and are drained by the existing
    // write-back path (_flushLocalPathToSupervisor), identical to
    // writeFileSync; closeSync/fsyncSync therefore cannot block on
    // durability and only mark the VFS stale.
    _residentBytes(syscall) {
      const cell = _writtenCell(this._abs);
      if (cell === undefined) return undefined;
      const denial = _denialCode(cell);
      if (denial) throw _fsErr(denial, syscall, this._path);
      _residencySatisfied(this._abs);
      return _asBytes(cell);
    }
    _notResident(syscall) {
      return _notResidentError(
        this._abs, this._path, syscall, "the async fs." + syscall + "/fs.promises form",
      );
    }
    _readBase(syscall) {
      const bytes = this._residentBytes(syscall);
      if (bytes === undefined) throw this._notResident(syscall);
      return bytes;
    }
    _writeBase(syscall) {
      const bytes = this._residentBytes(syscall);
      if (bytes !== undefined) return bytes;
      const st = statSync(this._path, { throwIfNoEntry: false });
      // Non-resident and non-empty: writing onto a zero-filled base would
      // silently destroy the bytes we cannot see. Refuse instead.
      if (st !== undefined && st.size !== 0) throw this._notResident(syscall);
      // Absent or empty — an empty base IS the true prior content, but only
      // where absence is knowledge. A path the view never mapped may hold bytes
      // this process cannot see, and an O_APPEND descriptor onto a zero-filled
      // base would overwrite the file with the fragment it meant to add.
      if (st === undefined && !_absenceIsKnown(this._abs)) {
        throw _refuseUnmapped(
          this._abs, this._path, syscall, "the async fs." + syscall + "/fs.promises form",
        );
      }
      return new Uint8Array(0);
    }
    _commit(next) {
      _parkWrite(_strip(this._abs), next);
      _markVfsStale();
      this._size = next.byteLength;
    }
    _readSync(buffer, offset, length, position) {
      this._assertOpen("read");
      if (!this._flags.read) throw _fsErr("EBADF", "read", this._path);
      const off = offset === undefined || offset === null ? 0 : Number(offset);
      const want = length === undefined || length === null
        ? buffer.length - off
        : Math.max(0, Number(length));
      const useCurrent = _isCurrentPos(position);
      const pos = useCurrent ? this._position : Number(position);
      const buf = this._readBase("read");
      const from = Math.min(pos, buf.byteLength);
      const slice = buf.subarray(from, Math.min(buf.byteLength, from + want));
      buffer.set(slice, off);
      if (useCurrent) this._position = pos + slice.byteLength;
      return slice.byteLength;
    }
    _writeSync(data, a, b, c) {
      this._assertOpen("write");
      if (!this._flags.write) throw _fsErr("EBADF", "write", this._path);
      const norm = _normWriteArgs(data, a, b, c);
      const bytes = norm.bytes;
      const pos = _isCurrentPos(norm.pos) ? null : Number(norm.pos);
      _ensureWritable(this._abs, "write", this._path);
      const base = this._writeBase("write");
      const at = this._flags.append
        ? base.byteLength
        : (pos === null ? this._position : pos);
      this._commit(_spliceCell(base, at, bytes));
      if (pos === null || this._flags.append) this._position = at + bytes.byteLength;
      return bytes.byteLength;
    }
    _truncateSync(len) {
      this._assertOpen("ftruncate");
      if (!this._flags.write) throw _fsErr("EBADF", "ftruncate", this._path);
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      _ensureWritable(this._abs, "ftruncate", this._path);
      const base = this._writeBase("ftruncate");
      const next = new Uint8Array(size);
      next.set(base.subarray(0, Math.min(size, base.byteLength)), 0);
      this._commit(next);
      if (this._position > size) this._position = size;
    }
    async chmod(mode) { this._assertOpen("fchmod"); await _chmodAsync(this._path, mode); }
    async chown(uid, gid) { this._assertOpen("fchown"); await _chownAsync(this._path, uid, gid, undefined, "fchown"); }
    async utimes(atime, mtime) { this._assertOpen("futimes"); await _utimesAsync(this._path, atime, mtime); }
    async sync() {}
    async datasync() {}
    async close() { this._assertOpen("close"); this._closed = true; __fileHandles.delete(this.fd); }
    [Symbol.asyncDispose]() { return this.close(); }
  }

  async function _openAsync(path, flags, mode) {
    const fl = _parseOpenFlags(flags);
    const absPath = _resolve(path);
    const supervisor = _supervisor();
    let liveMeta = null;
    if (supervisor && typeof supervisor.stat === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      liveMeta = await _fsRpc(supervisor.stat(absPath), "stat", path, (result) => result);
    }
    if (liveMeta && liveMeta.type === "directory") throw _fsErr("EISDIR", "open", path);
    let localStat = null;
    if (!liveMeta) {
      try { localStat = statSync(path); } catch {}
      if (localStat && localStat.isDirectory()) throw _fsErr("EISDIR", "open", path);
    }
    const exists = !!liveMeta || !!localStat;
    if (!exists && !fl.create) throw _fsErr("ENOENT", "open", path);
    if (exists && fl.create && fl.exclusive) throw _fsErr("EEXIST", "open", path);
    let size = liveMeta ? (Number(liveMeta.size) || 0) : (localStat ? localStat.size : 0);
    if (!exists) {
      await _writeFileAsync(path, new Uint8Array(0));
      if (mode !== undefined && mode !== null) {
        await _chmodAsync(path, Number(mode) & ~__processUmask);
      }
      size = 0;
    } else if (fl.truncate) {
      await _truncateAsync(path, 0);
      size = 0;
    }
    return new __FileHandle(path, fl, size);
  }

  function openSync(path, flags, mode) {
    const fl = _parseOpenFlags(flags);
    const absPath = _resolve(path);
    _ensureAncestorsTraversable(absPath, "open", path);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st && st.isDirectory()) throw _fsErr("EISDIR", "open", path);
    const exists = st !== undefined;
    if (!exists && !fl.create) throw _fsErr("ENOENT", "open", path);
    if (exists && fl.create && fl.exclusive) throw _fsErr("EEXIST", "open", path);
    if (fl.write || !exists) _ensureWritable(absPath, "open", path);
    let size = exists ? st.size : 0;
    // O_TRUNC means "make it empty", so zeroing is the requested semantic,
    // and creating a genuinely absent file is too. O_APPEND must NEVER
    // pre-create: "exists" is only as good as the sync view, so a file
    // created after this facet booted looks absent, and zeroing it at open
    // time would destroy exactly the content the caller asked to preserve.
    if (fl.truncate || (!exists && !fl.append)) {
      // Creating or truncating also makes the file resident, which is what
      // lets the sync read/write path serve it without blocking.
      writeFileSync(path, new Uint8Array(0));
      if (!exists && mode !== undefined && mode !== null) {
        chmodSync(path, Number(mode) & ~__processUmask);
      }
      size = 0;
    }
    return new __FileHandle(path, fl, size).fd;
  }

  // ── fd table ──
  // fds 0/1/2 are the process stdio triple and deliberately live OUTSIDE
  // __fileHandles (which allocates from 3 up), so fs.writeSync(1, ...) —
  // how a lot of bundled CLI output actually reaches the terminal — lands
  // on the real process streams instead of failing EBADF.
  function _fdHandle(fd, syscall) {
    const handle = __fileHandles.get(Number(fd));
    if (!handle || handle._closed) throw _fsErr("EBADF", syscall, fd);
    return handle;
  }
  // Resolve an fd for a callback-style syscall, delivering EBADF via cb.
  function _fdFor(fd, syscall, cb) {
    try { return _fdHandle(fd, syscall); }
    catch (e) { queueMicrotask(() => cb(e)); return null; }
  }
  function _isStdioFd(fd) { const n = Number(fd); return n === 0 || n === 1 || n === 2; }
  // stdio descriptors are character devices, not VFS files.
  function _stdioStat() {
    const now = new Date();
    return {
      isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
      isBlockDevice: () => false, isCharacterDevice: () => true,
      isFIFO: () => false, isSocket: () => false,
      size: 0, mode: 0o020620, uid: Number(cred.uid), gid: Number(cred.gid),
      atime: now, mtime: now, ctime: now, birthtime: now,
    };
  }
  // Node treats a null position — and a negative one, which libuv maps to
  // the same thing — as "use and advance the file position".
  function _isCurrentPos(p) {
    return p === undefined || p === null || Number(p) < 0;
  }
  // Normalizes every documented fs.write/writeSync argument shape:
  //   (fd, buffer[, offset[, length[, position]]])
  //   (fd, buffer[, options])   where options = { offset, length, position }
  //   (fd, string[, position[, encoding]])
  function _normWriteArgs(data, a, b, c) {
    if (typeof data === "string") {
      return {
        bytes: _asBytes(__BufferMod.from(data, typeof b === "string" ? b : "utf8")),
        pos: a,
      };
    }
    let off = a, len = b, pos = c;
    if (a !== null && typeof a === "object" && !(a instanceof Uint8Array)) {
      off = a.offset; len = a.length; pos = a.position;
    }
    off = off === undefined || off === null ? 0 : Number(off);
    len = len === undefined || len === null ? data.length - off : Number(len);
    return { bytes: _asBytes(data).subarray(off, off + len), pos };
  }

  function closeSync(fd) {
    if (_isStdioFd(fd)) return;
    const handle = _fdHandle(fd, "close");
    handle._closed = true;
    __fileHandles.delete(handle.fd);
  }

  function readSync(fd, buffer, offsetOrOptions, length, position) {
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
      offset = offsetOrOptions.offset;
      length = offsetOrOptions.length;
      position = offsetOrOptions.position;
    }
    // Sync stdin cannot block, so stdin always reads as EOF here — an
    // attached tty with buffered input is NOT distinguished.
    if (_isStdioFd(fd)) return 0;
    return _fdHandle(fd, "read")._readSync(buffer, offset, length, position);
  }

  function writeSync(fd, data, a, b, c) {
    const n = Number(fd);
    if (n === 1 || n === 2) {
      // The stream shim stringifies whatever it is given, so decode first.
      const bytes = _normWriteArgs(data, a, b, c).bytes;
      (n === 2 ? __processMod.stderr : __processMod.stdout).write(_dec.decode(bytes));
      return bytes.byteLength;
    }
    if (n === 0) throw _fsErr("EBADF", "write", fd);
    return _fdHandle(fd, "write")._writeSync(data, a, b, c);
  }

  function fstatSync(fd, opts) {
    if (_isStdioFd(fd)) return _stdioStat();
    return statSync(_fdHandle(fd, "fstat")._path, opts);
  }

  function ftruncateSync(fd, len) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "ftruncate", fd);
    _fdHandle(fd, "ftruncate")._truncateSync(len);
  }

  // Sync writes buffer into __vfsWrites and are drained by the existing
  // VFS write-back path — a facet cannot block on durability, so these
  // validate the fd and mark the VFS stale rather than pretending to sync.
  function fsyncSync(fd) { if (!_isStdioFd(fd)) _fdHandle(fd, "fsync"); _markVfsStale(); }
  function fdatasyncSync(fd) { if (!_isStdioFd(fd)) _fdHandle(fd, "fdatasync"); _markVfsStale(); }

  // ── callback forms (live I/O — these CAN reach the supervisor) ──
  function open(path, flags, mode, cb) {
    if (typeof flags === "function") { cb = flags; flags = undefined; mode = undefined; }
    else if (typeof mode === "function") { cb = mode; mode = undefined; }
    _openAsync(path, flags, mode).then((h) => cb(null, h.fd)).catch((e) => cb(e));
  }
  function close(fd, cb) {
    let err = null;
    try { closeSync(fd); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    queueMicrotask(() => cb(err));
  }
  function read(fd, buffer, offset, length, position, cb) {
    if (typeof buffer === "function") {
      // read(fd, callback)
      cb = buffer; buffer = undefined; offset = undefined; length = undefined; position = undefined;
    } else if (typeof offset === "function") {
      // read(fd, options, callback) — the buffer rides inside options
      cb = offset;
      const o = buffer !== null && typeof buffer === "object" && !(buffer instanceof Uint8Array) ? buffer : {};
      buffer = o.buffer instanceof Uint8Array ? o.buffer : undefined;
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof length === "function") {
      // read(fd, buffer, options, callback)
      cb = length;
      const o = offset !== null && typeof offset === "object" ? offset : {};
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof position === "function") {
      // read(fd, buffer, offset, length, callback)
      cb = position; position = undefined;
    }
    if (!(buffer instanceof Uint8Array)) buffer = __BufferMod.alloc(16384);
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(null, 0, buffer)); return; }
    const handle = _fdFor(fd, "read", cb);
    if (!handle) return;
    handle.read(buffer, offset, length, position)
      .then((r) => cb(null, r.bytesRead, r.buffer))
      .catch((e) => cb(e));
  }
  function write(fd, data, a, b, c, d) {
    // write(fd, buffer[, offset[, length[, position]]], cb)
    // write(fd, string[, position[, encoding]], cb)
    let cb = d;
    if (typeof a === "function") { cb = a; a = undefined; b = undefined; c = undefined; }
    else if (typeof b === "function") { cb = b; b = undefined; c = undefined; }
    else if (typeof c === "function") { cb = c; c = undefined; }
    let norm;
    try { norm = _normWriteArgs(data, a, b, c); }
    catch (e) { queueMicrotask(() => cb(e)); return; }
    const n = Number(fd);
    if (n === 1 || n === 2) {
      (n === 2 ? __processMod.stderr : __processMod.stdout).write(_dec.decode(norm.bytes));
      queueMicrotask(() => cb(null, norm.bytes.byteLength, data));
      return;
    }
    const handle = _fdFor(fd, "write", cb);
    if (!handle) return;
    // Hand over already-decoded bytes so the async path applies the same
    // encoding rules as writeSync instead of FileHandle.write's UTF-8-only
    // string branch.
    handle.write(norm.bytes, 0, norm.bytes.byteLength, _isCurrentPos(norm.pos) ? null : Number(norm.pos))
      .then((r) => cb(null, r.bytesWritten, data))
      .catch((e) => cb(e));
  }
  function fstat(fd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    let stats = null;
    let err = null;
    try { stats = fstatSync(fd, opts); } catch (e) { err = e; }
    queueMicrotask(() => cb(err, stats));
  }
  function ftruncate(fd, len, cb) {
    if (typeof len === "function") { cb = len; len = 0; }
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(_fsErr("EINVAL", "ftruncate", fd))); return; }
    const handle = _fdFor(fd, "ftruncate", cb);
    if (!handle) return;
    handle.truncate(len).then(() => cb(null)).catch((e) => cb(e));
  }
  function fsync(fd, cb) {
    let err = null;
    try { fsyncSync(fd); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    queueMicrotask(() => cb(err));
  }
  function fdatasync(fd, cb) {
    let err = null;
    try { fdatasyncSync(fd); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    queueMicrotask(() => cb(err));
  }
  function fchmod(fd, mode, cb) {
    const handle = _fdFor(fd, "fchmod", cb);
    if (!handle) return;
    handle.chmod(mode).then(() => cb(null)).catch((e) => cb(e));
  }
  function fchown(fd, uid, gid, cb) {
    const handle = _fdFor(fd, "fchown", cb);
    if (!handle) return;
    handle.chown(uid, gid).then(() => cb(null)).catch((error) => cb(error));
  }

  // ── promises namespace (W3: full surface, VFS-backed) ──
  // We can't forward to workerd's node:fs/promises because that operates
  // on a real-host filesystem, not our VFS. So every method is shim'd
  // against the same underlying readFileSync/writeFileSync/etc.
  const promises = {
    // pre-W3 surface:
    readFile: (p, o) => new Promise((res, rej) => readFile(p, o, (e, d) => e ? rej(e) : res(d))),
    writeFile: (p, d, o) => new Promise((res, rej) => writeFile(p, d, o, (e) => e ? rej(e) : res())),
    stat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
    readdir: (p, o) => new Promise((res, rej) => readdir(p, o, (e, d) => e ? rej(e) : res(d))),
    mkdir: (p, o) => new Promise((res, rej) => mkdir(p, o, (e) => e ? rej(e) : res())),
    unlink: (p) => new Promise((res, rej) => unlink(p, (e) => e ? rej(e) : res())),
    access: (p, m) => new Promise((res, rej) => access(p, m, (e) => e ? rej(e) : res())),

    // W3 additions:
    appendFile: async (p, d, o) => { await _appendFileAsync(p, d, o); },
    lstat: (p) => new Promise((res, rej) => lstat(p, (e, s) => e ? rej(e) : res(s))),
    rm: async (p, opts) => {
      const o = opts || {};
      const k = _strip(_resolve(p));
      const prefix = k + "/";
      if (o.recursive) {
        if (__vfsBundle) {
          if (k in __vfsBundle) delete __vfsBundle[k];
          for (const bk of __residentUnder(prefix)) delete __vfsBundle[bk];
        }
        if (__vfsWrites) for (const wk of Object.keys(__vfsWrites)) if (wk === k || wk.startsWith(prefix)) delete __vfsWrites[wk];
        if (__vfsDirs) for (const dk of Object.keys(__vfsDirs)) if (dk === k || dk.startsWith(prefix)) delete __vfsDirs[dk];
        _forgetSyncTree(k);
      } else {
        try { await _unlinkAsync(p); } catch (e) { if (!o.force) throw e; }
      }
    },
    cp: async (src, dest, opts) => {
      const o = opts || {};
      const srcAbs = _resolve(src);
      const srcK = _strip(srcAbs);
      const destK = _strip(_resolve(dest));
      const content = _bundleLookup(srcAbs);
      if (content !== undefined) { await _writeFileAsync(dest, content); return; }
      if (!o.recursive) {
        const err = new Error("EISDIR: cp without recursive on directory: " + src);
        err.code = "EISDIR"; throw err;
      }
      // Recursive: walk the source tree (merging the local sync view with
      // the live VFS listing so files only present in SQLite — e.g. a
      // just-extracted template tarball — are included) and persist every
      // file through the async bridge. Writing through _writeFileAsync —
      // not just the local cache — is required so a subsequent async fs op
      // (e.g. fs.promises.rename of a copied file, as create-cloudflare
      // does for __dot__gitignore) sees the copy in the VFS instead of
      // ENOENT.
      __vfsDirs[destK] = true;
      const walk = async (relDir) => {
        const absDir = relDir ? srcAbs + "/" + relDir : srcAbs;
        const ents = await _readdirAsync(absDir, { withFileTypes: true });
        for (const ent of ents) {
          const rel = relDir ? relDir + "/" + ent.name : ent.name;
          if (ent.isDirectory && ent.isDirectory()) {
            __vfsDirs[destK + "/" + rel] = true;
            await walk(rel);
          } else {
            await _writeFileAsync("/" + destK + "/" + rel, await _readFileAsync(srcAbs + "/" + rel));
          }
        }
      };
      await walk("");
    },
    copyFile: async (src, dest) => { await _writeFileAsync(dest, await _readFileAsync(src)); },
    rename: async (oldP, newP) => { await _renameAsync(oldP, newP); },
    rmdir: async (p) => { await _rmdirAsync(p); },
    realpath: async (p) => __pathMod.resolve(String(p)),
    truncate: async (p, len) => { await _truncateAsync(p, len || 0); },
    chmod: async (p, mode) => { await _chmodAsync(p, mode); },
    chown: async (p, uid, gid) => { await _chownAsync(p, uid, gid); },
    lchmod: async (p, mode) => { await _chmodAsync(p, mode); },
    lchown: async (p, uid, gid) => { await _chownAsync(p, uid, gid, { followSymlinks: false }); },
    utimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime); },
    lutimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime, { followSymlinks: false }); },
    symlink: async (target, path) => { await _symlinkAsync(target, path); },
    link: async () => { throw _fsErr("ENOSYS", "link", ""); },
    readlink: async (p) => _readlinkAsync(p),
    mkdtemp: async (prefix) => {
      const name = String(prefix) + Math.random().toString(36).slice(2, 10);
      mkdirSync(name, { recursive: true });
      return name;
    },
    open: async (path, flags, mode) => _openAsync(path, flags, mode),
    watch: async function* (filename, opts) {
      // Minimal async iter — polls _bundleLookup every 500ms and yields
      // a single \`change\` event when content differs. Adequate for
      // "wait for file to change" patterns; not a complete fsevents.
      const absPath = _resolve(filename);
      let last = _bundleLookup(absPath);
      while (true) {
        await new Promise(r => setTimeout(r, 500));
        const cur = _bundleLookup(absPath);
        if (cur !== last) {
          last = cur;
          yield { eventType: cur === undefined ? 'rename' : 'change', filename: __pathMod.basename(String(filename)) };
        }
      }
    },
    glob: async function* (pattern, opts) {
      // Minimal — yield matching files via prefix scan. Not full glob.
      // Sufficient for "**/*.js" style patterns; documented limitation.
      const root = (opts && opts.cwd) ? _strip(_resolve(opts.cwd)) : _strip(_resolve('.'));
      const re = (() => {
        // Convert simple glob to regex: ** -> .*, * -> [^/]*, ? -> .
        let r = '^' + (root ? root + '/' : '');
        let g = pattern.replace(/\\\\/g, '/');
        for (let i = 0; i < g.length; i++) {
          const c = g[i];
          if (c === '*') {
            if (g[i+1] === '*') { r += '.*'; i++; if (g[i+1] === '/') i++; }
            else r += '[^/]*';
          } else if (c === '?') r += '.';
          else if (/[.+^$(){}|[\\]\\\\]/.test(c)) r += '\\\\' + c;
          else r += c;
        }
        r += '$';
        return new RegExp(r);
      })();
      const seen = new Set();
      // The pattern is anchored at the root, so nothing outside that subtree
      // can match and nothing outside it needs visiting.
      if (__vfsBundle) for (const bk of __residentUnder(root ? root + "/" : "")) if (re.test(bk)) seen.add(bk);
      if (__vfsWrites) for (const wk in __vfsWrites) if (re.test(wk)) seen.add(wk);
      for (const m of [...seen].sort()) yield '/' + m;
    },
  };

  // ── constants ──
  const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

  // fs.ReadStream / fs.WriteStream classes. Real Node exposes these as
  // constructors; graceful-fs (bundled by degit → create-cloudflare)
  // re-parents its own patched stream off fs.ReadStream.prototype, so
  // the classes must exist with readable prototypes and stream the file.
  // __streamMod is defined later in the generated bundle than __fsMod,
  // so the classes are built lazily on first access (post-init) and
  // cached, exposed via getters to avoid a temporal-dead-zone reference.
  let __ReadStreamClass = null;
  let __WriteStreamClass = null;
  function __getReadStream() {
    if (__ReadStreamClass) return __ReadStreamClass;
    /**
     * ONE read-stream implementation, behind both \`fs.createReadStream\`
     * and the exported \`fs.ReadStream\` class.
     *
     * Each \`_read()\` pulls exactly one bounded chunk, so a multi-MB asset
     * streams to the consumer without the facet — or the supervisor — ever
     * materialising the whole file, and \`.pipe()\` backpressure actually
     * throttles the source. A file the prefetch bundle does not carry is
     * read live from the VFS via the same stateless ranged RPC that
     * FileHandle.read uses: the bundle is a cache, the VFS is the truth.
     */
    __ReadStreamClass = class ReadStream extends __streamMod.Readable {
      constructor(path, opts) {
        const options = typeof opts === "string" ? { encoding: opts } : (opts || {});
        super({
          encoding: options.encoding || null,
          highWaterMark: options.highWaterMark || READ_STREAM_CHUNK_BYTES,
        });
        this.path = path;
        this.bytesRead = 0;
        this._abs = _resolve(path);
        this._pos = Number.isFinite(options.start) ? Math.max(0, Math.trunc(options.start)) : 0;
        // Node's \`end\` option is INCLUSIVE.
        this._last = Number.isFinite(options.end) ? Math.trunc(options.end) : Infinity;
      }
      _read() {
        // The base class guarantees one outstanding _read at a time, so the
        // position cursor advances sequentially without extra locking.
        this._pull().catch((e) => this.destroy(e));
      }
      async _pull() {
        if (this._pos > this._last) { this.push(null); return; }
        const want = Math.min(READ_STREAM_CHUNK_BYTES, this._last - this._pos + 1);
        const chunk = await _readRangeAt(this._abs, this.path, this._pos, want);
        if (chunk === null) { this.push(null); return; }
        this._pos += chunk.byteLength;
        this.bytesRead += chunk.byteLength;
        this.push(chunk);
        if (chunk.byteLength < want) this.push(null);
      }
      open() {}
      close(cb) { this.destroy(); if (cb) cb(); }
    };
    return __ReadStreamClass;
  }
  function __getWriteStream() {
    if (__WriteStreamClass) return __WriteStreamClass;
    __WriteStreamClass = class WriteStream extends __streamMod.Writable {
      constructor(path, opts) { super(); this.path = path; this._opts = opts; this._chunks = []; this._anyBytes = false; }
      _write(chunk, enc, cb) {
        if (chunk instanceof Uint8Array) { this._anyBytes = true; this._chunks.push(chunk); }
        else this._chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        cb();
      }
      _final(cb) {
        try {
          if (this._anyBytes) {
            let total = 0;
            for (const c of this._chunks) total += (c instanceof Uint8Array) ? c.byteLength : _enc.encode(c).length;
            const out = new Uint8Array(total); let off = 0;
            for (const c of this._chunks) { const b = (c instanceof Uint8Array) ? c : _enc.encode(c); out.set(b, off); off += b.byteLength; }
            writeFileSync(this.path, out);
          } else {
            writeFileSync(this.path, this._chunks.join(""));
          }
          cb();
        } catch (e) { cb(e); }
      }
      open() {}
      close(cb) { if (cb) cb(); }
    };
    return __WriteStreamClass;
  }

  const __fsExports = {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
    readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
    realpathSync, utimesSync, lutimesSync, chmodSync, accessSync,
    openSync, closeSync, readSync, writeSync, fstatSync, ftruncateSync, fsyncSync, fdatasyncSync,
    open, close, read, write, fstat, ftruncate, fsync, fdatasync, fchmod,
    readFile, writeFile, appendFile, stat, lstat, readdir, exists, mkdir, unlink, rename, utimes, lutimes, chmod, chown, lchown, fchown, access,
    promises, constants,
    createReadStream: (p, opts) => new (__getReadStream())(p, opts),
    createWriteStream: (p, opts) => {
      // binary-fs: chunks may arrive as Uint8Array OR string. Keep
      // each chunk in its native shape; on final, if any chunk is
      // bytes the merged write is bytes; otherwise string-concat
      // (the hot path for ASCII text streams).
      const chunks = [];
      let anyBytes = false;
      const ws = new __streamMod.Writable({
        write(chunk, enc, cb) {
          if (chunk instanceof Uint8Array) { anyBytes = true; chunks.push(chunk); }
          else chunks.push(typeof chunk === "string" ? chunk : String(chunk));
          cb();
        },
        final(cb) {
          if (anyBytes) {
            // Sum byteLength across mixed chunks; concat to one Uint8Array.
            let total = 0;
            for (const c of chunks) total += (c instanceof Uint8Array) ? c.byteLength : _enc.encode(c).length;
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              const b = (c instanceof Uint8Array) ? c : _enc.encode(c);
              out.set(b, off);
              off += b.byteLength;
            }
            writeFileSync(p, out);
          } else {
            writeFileSync(p, chunks.join(""));
          }
          cb();
        },
      });
      return ws;
    },
    // fs.watch() — returns a watcher object that emits 'change' events.
    // In the facet context, changes to __vfsBundle/Writes are detected
    // via polling since we don't have the supervisor's event emitter.
    // For the supervisor context, real VFS events are wired separately.
    watch: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      const watcher = new __eventsMod();
      watcher.close = () => { watcher._closed = true; watcher.removeAllListeners(); };
      watcher._closed = false;
      if (listener) watcher.on("change", listener);
      // Poll for changes every 500ms (simple but functional)
      const absPath = _resolve(filename);
      const key = _strip(absPath);
      let lastContent = _bundleLookup(absPath);
      const interval = setInterval(() => {
        if (watcher._closed) { clearInterval(interval); return; }
        const current = _bundleLookup(absPath);
        if (current !== lastContent) {
          lastContent = current;
          const eventType = current === undefined ? "rename" : "change";
          watcher.emit("change", eventType, __pathMod.basename(filename));
        }
      }, 500);
      return watcher;
    },
    watchFile: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      // No-op but accept the API
      return { unref: () => {} };
    },
    unwatchFile: () => {},
  };
  // Lazy getters with setters: graceful-fs reads fs.ReadStream.prototype
  // then reassigns fs.ReadStream / fs.FileReadStream to its patched
  // subclass, so each slot must be both readable (lazily) and writable.
  const __defLazyStream = (key, build) => {
    let __set = false;
    let __val;
    Object.defineProperty(__fsExports, key, {
      get() { return __set ? __val : build(); },
      set(v) { __set = true; __val = v; },
      enumerable: true, configurable: true,
    });
  };
  __defLazyStream("ReadStream", __getReadStream);
  __defLazyStream("WriteStream", __getWriteStream);
  __defLazyStream("FileReadStream", __getReadStream);
  __defLazyStream("FileWriteStream", __getWriteStream);
  _installResumptionBarriers();
  return __fsExports;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  WebSocket: relayed through the supervisor ───────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// The last resumption that reached a facet without a supervisor message.
// A directly-connected socket delivers \`onmessage\` as a bare resumption:
// an arbitrary third party wakes the facet at a time of its own choosing,
// and a synchronous read in that handler serves whatever the facet was
// holding when it last heard from the authority. Two facets connected to
// any common external endpoint had a full-duplex channel that never
// touched the supervisor, which breaks causal consistency and not merely
// linearizability.
//
// Proxying the bytes would not have fixed it. The frame has to arrive AS a
// supervisor reply, so the supervisor terminates the socket and this class
// receives frames as replies to a poll it is already blocked on. Then the
// frame handler takes the same ACQUIRE the timer and fetch boundaries take,
// and \`_UNBARRIERED_RESUMPTIONS\` is empty.
//
// This is a listener registry rather than an EventTarget subclass on
// purpose: it dispatches plain event-shaped objects, which is what a
// relayed frame can carry across RPC, and it keeps \`onmessage\` and
// \`addEventListener\` served by one path instead of two.
const __NimbusRelayedWebSocket = (() => {
  const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
  class NimbusWebSocket {
    constructor(url, protocols) {
      const supervisor = _nimbusSupervisor();
      if (!supervisor || typeof supervisor.wsOpen !== "function") {
        // Not a fallback to the platform socket, deliberately. An
        // unmediated socket is exactly the incoherence this class exists
        // to remove, and opening one quietly would put the guarantee back
        // to being conditional on which facet you happened to be in.
        throw new Error(
          "WebSocket: no supervisor is bound to this process, so a socket " +
          "cannot be relayed; a directly-connected socket would deliver " +
          "frames outside the filesystem coherence barrier",
        );
      }
      this.url = String(url);
      this.readyState = CONNECTING;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.onopen = null; this.onmessage = null;
      this.onerror = null; this.onclose = null;
      this._listeners = new Map();
      this._id = null;
      this._done = false;
      this._sends = Promise.resolve();
      const requested = protocols === undefined ? []
        : (Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]);
      this._ready = this._connect(supervisor, requested);
    }

    async _connect(supervisor, protocols) {
      try {
        const opened = await __nimbusUseRpcResultUnref(
          supervisor.wsOpen(this.url, protocols),
          (result) => result,
        );
        this._id = opened.id;
        this.protocol = opened.protocol || "";
        this._pump(supervisor);
      } catch (error) {
        this._fail(error);
      }
    }

    async _pump(supervisor) {
      while (!this._done) {
        let events;
        try {
          events = await __nimbusUseRpcResultUnref(
            supervisor.wsPoll(this._id, 5000),
            (result) => result,
          );
        } catch (error) { this._fail(error); return; }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (this._done) return;
          // The barrier the whole relay exists for. Every frame is now a
          // supervisor reply, so it can carry the invalidation delta, and
          // user code runs only after the resident set has caught up.
          const acquire = globalThis.__nimbusVfsAcquireBarrier;
          if (typeof acquire === "function") await acquire();
          this._deliver(event);
        }
      }
    }

    _deliver(event) {
      if (event.kind === "open") {
        this.readyState = OPEN;
        this._emit({ type: "open", target: this });
        return;
      }
      if (event.kind === "message") {
        const data = event.text !== null && event.text !== undefined
          ? event.text
          : (this.binaryType === "arraybuffer"
            ? _nimbusToArrayBuffer(event.bytes)
            : event.bytes);
        this._emit({ type: "message", data, target: this });
        return;
      }
      if (event.kind === "error") {
        this._emit({ type: "error", message: event.message, target: this });
        return;
      }
      if (event.kind === "close") {
        this._done = true;
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: event.code, reason: event.reason,
          wasClean: event.code === 1000, target: this,
        });
      }
    }

    _fail(error) {
      if (this._done) return;
      this._done = true;
      this.readyState = CLOSED;
      const message = (error && error.message) || String(error);
      this._emit({ type: "error", message, target: this });
      this._emit({ type: "close", code: 1006, reason: message, wasClean: false, target: this });
    }

    _emit(event) {
      const handler = this["on" + event.type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch (error) { _nimbusReportListenerError(error); }
      }
      const listeners = this._listeners.get(event.type);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          if (typeof listener === "function") listener.call(this, event);
          else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
        } catch (error) { _nimbusReportListenerError(error); }
      }
    }

    addEventListener(type, listener) {
      const key = String(type);
      if (!this._listeners.has(key)) this._listeners.set(key, new Set());
      this._listeners.get(key).add(listener);
    }

    removeEventListener(type, listener) {
      const listeners = this._listeners.get(String(type));
      if (listeners) listeners.delete(listener);
    }

    dispatchEvent(event) { this._emit(event); return true; }

    send(data) {
      if (this.readyState === CLOSED || this.readyState === CLOSING) {
        throw new Error("WebSocket: send on a socket that is already closing");
      }
      const text = typeof data === "string" ? data : null;
      const bytes = text === null ? _nimbusToBytes(data) : null;
      const size = text !== null ? text.length : (bytes ? bytes.byteLength : 0);
      this.bufferedAmount += size;
      // A frame leaving this facet is an outward-visible effect of whatever
      // it just wrote, so the parked writes go first. Otherwise the peer
      // that reads this frame can act on a write the authority does not
      // have yet, which is the causal edge the protocol closes.
      this._sends = this._sends.then(async () => {
        const supervisor = _nimbusSupervisor();
        if (!supervisor || this._done) return;
        const release = globalThis.__nimbusVfsReleaseBarrier;
        if (typeof release === "function") await release();
        await this._ready;
        if (this._id === null || this._done) return;
        await __nimbusUseRpcResultUnref(
          supervisor.wsSend(this._id, text, bytes),
          () => undefined,
        );
      }).then(
        () => { this.bufferedAmount -= size; },
        (error) => { this.bufferedAmount -= size; this._fail(error); },
      );
      __nimbusTrackOp(this._sends);
    }

    close(code, reason) {
      if (this._done || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      const supervisor = _nimbusSupervisor();
      const closing = (async () => {
        await this._ready.catch(() => {});
        if (this._id === null || !supervisor) return;
        await __nimbusUseRpcResultUnref(
          supervisor.wsClose(this._id, code, reason),
          () => undefined,
        );
      })().catch(() => {}).then(() => {
        this._done = true;
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: code === undefined ? 1000 : code,
          reason: reason === undefined ? "" : String(reason),
          wasClean: true, target: this,
        });
      });
      __nimbusTrackOp(closing);
    }
  }
  for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
    NimbusWebSocket[name] = value;
    NimbusWebSocket.prototype[name] = value;
  }
  return NimbusWebSocket;
})();

function _nimbusSupervisor() {
  try { return typeof __supervisor !== "undefined" ? __supervisor : null; }
  catch { return null; }
}

function _nimbusToBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function _nimbusToArrayBuffer(bytes) {
  if (!bytes) return new ArrayBuffer(0);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.byteLength === view.byteLength
    ? view.buffer
    : view.slice().buffer;
}

// A listener that throws is the program's bug, but swallowing it silently
// would make a relayed socket behave differently from a direct one. Route it
// to the same place an uncaught async failure goes.
function _nimbusReportListenerError(error) {
  queueMicrotask(() => { throw error; });
}

globalThis.WebSocket = __NimbusRelayedWebSocket;

// ═══════════════════════════════════════════════════════════════════════
// ──  constants module (framework-fixes-F1) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// require('node:constants') (and the legacy bare require('constants'))
// expose a FLAT object of POSIX/Linux/OpenSSL constants. Real Node ships
// ~234 constants; we ship the ones that actually get touched by:
//   - create-next-app (touches UV_FS_O_FILEMAP — verified via grep on
//     unpkg.com/create-next-app@latest/dist/index.js)
//   - typical fs.openSync flag composition (O_RDONLY, O_WRONLY, O_RDWR,
//     O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY, etc.)
//   - typical fs.access mode composition (F_OK, R_OK, W_OK, X_OK)
//   - typical fs.copyFile mode composition (COPYFILE_EXCL etc.)
//   - signal/errno tables (shared shape with __osMod.constants.signals
//     etc. — flat here, nested there; both shapes are real-Node-accurate
//     and we expose both via the right module).
//   - dlopen flags (RTLD_*) for libraries that probe defined-ness.
//   - SSL_OP_* / TLS_*_VERSION for libs that probe TLS options
//     (vanilla openssl numeric values — semantic match real Node's).
//
// Values match real Node v20 on Linux exactly. Verified via
// node -e 'console.log(require("node:constants"))'.
//
// History: F1 root cause in framework-fixes wave. Pre-fix create-next-app
// errored with "Cannot find module 'node:constants'" at module init.
const __constantsMod = {
  // ── dlopen flags ──────────────────────────────────────────────────
  RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8,
  // ── errno (Linux ABI) ─────────────────────────────────────────────
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97,
  EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16,
  ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103, ECONNREFUSED: 111,
  ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89, EDOM: 33, EDQUOT: 122,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
  EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5,
  EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31,
  EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100,
  ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105,
  ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37,
  ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92, ENOSPC: 28,
  ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20,
  ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6,
  EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71,
  EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34, EROFS: 30,
  ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
  ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
  // ── Process priority (os.setPriority / os.getPriority) ────────────
  PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
  // ── Signals (POSIX + Linux) ───────────────────────────────────────
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
  // ── File-type bits (stat.mode masks) ──────────────────────────────
  S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
  S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
  // ── File-open flags (fs.openSync / fs.constants.O_*) ──────────────
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024,
  O_DIRECTORY: 65536, O_NOATIME: 262144, O_NOFOLLOW: 131072,
  O_SYNC: 1052672, O_DSYNC: 4096, O_DIRECT: 16384, O_NONBLOCK: 2048,
  // libuv-specific fs flag — create-next-app touches this directly.
  UV_FS_O_FILEMAP: 0,
  // ── File-permission bits (chmod / stat.mode user/group/other) ─────
  S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64,
  S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8,
  S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
  // ── fs.access mode constants ──────────────────────────────────────
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  // ── fs.copyFile mode constants (libuv shape + Node alias) ─────────
  UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
  // ── OpenSSL / TLS option flags ────────────────────────────────────
  // Numeric values from real Node v20. Libraries probe defined-ness;
  // we ship the surface so constants.SSL_OP_* doesn't undefined-throw.
  OPENSSL_VERSION_NUMBER: 810549328,
  SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
  SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
  SSL_OP_CISCO_ANYCONNECT: 32768, SSL_OP_COOKIE_EXCHANGE: 8192,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072,
  SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
  SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432,
  SSL_OP_NO_TICKET: 16384, SSL_OP_NO_TLSv1: 67108864,
  SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728,
  SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152,
  SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  // ── TLS version numbers ───────────────────────────────────────────
  TLS1_VERSION: 769, TLS1_1_VERSION: 770,
  TLS1_2_VERSION: 771, TLS1_3_VERSION: 772,
  // ── crypto engine method flags ────────────────────────────────────
  ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4,
  ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048,
  ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128,
  ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0,
  // ── DH / RSA padding ──────────────────────────────────────────────
  DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_CHECK_P_NOT_PRIME: 1,
  DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8,
  RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  os module ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __osMod = {
  platform: () => "linux", arch: () => "x64", type: () => "Linux",
  release: () => "6.0.0-nimbus", tmpdir: () => "/tmp", homedir: () => "/home/user",
  hostname: () => "nimbus", userInfo: () => {
    const uid = Number(cred.uid);
    const gid = Number(cred.gid);
    const root = uid === 0;
    return { uid, gid, username: root ? "root" : "user", homedir: root ? "/root" : "/home/user", shell: "/bin/sh" };
  },
  cpus: () => [{ model: "DO vCPU", speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  totalmem: () => 128 * 1024 * 1024, freemem: () => 64 * 1024 * 1024,
  loadavg: () => [0, 0, 0], uptime: () => 3600,
  networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }] }),
  EOL: "\\n", endianness: () => "LE",
  // os.constants — signals + errno + priority. Used by human-signals,
  // signal-exit, cross-spawn, exit-hook, and a long tail of "graceful
  // shutdown" / "child-process plumbing" libraries that real Node ships.
  //
  // human-signals's main.js (v2+) does:
  //   import { constants } from 'node:os'
  //   ...
  //   const findSignalByNumber = (number, signals) =>
  //     signals.find(({ name }) => constants.signals[name] === number)
  //
  // Pre-fix, __osMod had no \`constants\` field → \`constants.signals\`
  // was undefined → \`signals[name]\` throws TypeError → caller's
  // \`getSignalsByName\` blows up at module init time. Surfaced by
  // create-react-router (transitively depends on human-signals via
  // execa / cross-spawn).
  //
  // Values mirror real Node v20+ on Linux (verified against \`node -e
  // "console.log(require('os').constants)"\`). The shape is stable;
  // pinning POSIX signal numbers per the LSB / glibc table.
  constants: {
    // ── Signals ──────────────────────────────────────────────────
    // Standard POSIX + Linux-specific signals as Node exposes them.
    // Numbers match the Linux ABI; portable signal-name lookups
    // (which is what 100% of npm consumers do) work regardless of
    // platform.
    signals: {
      SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
      SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
      SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
      SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19,
      SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
      SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
      SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
    },
    // ── Errno ────────────────────────────────────────────────────
    // Standard Linux errno codes. fs/network libraries (e.g.
    // graceful-fs, retry layers in node-fetch wrappers) probe these
    // to decide retry strategy. Subset matches Node's exposed surface.
    errno: {
      E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99,
      EAFNOSUPPORT: 97, EAGAIN: 11, EALREADY: 114, EBADF: 9,
      EBADMSG: 74, EBUSY: 16, ECANCELED: 125, ECHILD: 10,
      ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104,
      EDEADLK: 35, EDESTADDRREQ: 89, EDOM: 33, EDQUOT: 122,
      EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113,
      EIDRM: 43, EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22,
      EIO: 5, EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24,
      EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
      ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23,
      ENOBUFS: 105, ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8,
      ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92,
      ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107,
      ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95,
      ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1,
      EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91,
      ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116,
      ETIME: 62, ETIMEDOUT: 110, ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
    },
    // ── Priority ────────────────────────────────────────────────
    // Process priority constants for os.setPriority / os.getPriority.
    // Not used by anything we've observed, but Node exposes them and
    // some libs check defined-ness before falling through.
    priority: {
      PRIORITY_LOW: 19,
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_NORMAL: 0,
      PRIORITY_ABOVE_NORMAL: -7,
      PRIORITY_HIGH: -14,
      PRIORITY_HIGHEST: -20,
    },
    // ── dlopen flags ────────────────────────────────────────────
    // Documented for completeness; Nimbus has no real dlopen.
    dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 },
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  events module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __eventsMod = (() => {
  // X.5-Z5 (Z5 §1 follow-on): every method that reads/writes \`this._e\`
  // lazy-initializes it. Userland (notably express's createApplication
  // — express/lib/express.js:36-42) mixin-copies EventEmitter.prototype
  // onto a plain function via merge-descriptors; the EE constructor
  // never runs on that target so \`_e\` is undefined. The lazy guard
  // \`(this._e ??= {})\` matches Node's behaviour (Node initializes
  // _events on first use too) and makes mixin-copy patterns safe.
  class EE {
    constructor() { this._e = {}; this._maxListeners = 10; }
    on(n, fn) { const e = (this._e ??= {}); (e[n] = e[n] || []).push(fn); return this; }
    addListener(n, fn) { return this.on(n, fn); }
    once(n, fn) { const w = (...a) => { this.removeListener(n, w); fn(...a); }; w.__orig = fn; return this.on(n, w); }
    _remove(n, fn) { const e = (this._e ??= {}); if (e[n]) e[n] = e[n].filter(f => f !== fn && f.__orig !== fn); return this; }
    off(n, fn) { return this._remove(n, fn); }
    removeListener(n, fn) { return this._remove(n, fn); }
    removeAllListeners(n) { if (n) { const e = (this._e ??= {}); delete e[n]; } else this._e = {}; return this; }
    emit(n, ...a) { const e = (this._e ??= {}); const fns = e[n]; if (!fns || !fns.length) return false; for (const fn of [...fns]) fn(...a); return true; }
    listeners(n) { const e = (this._e ??= {}); return (e[n] || []).map(f => f.__orig || f); }
    listenerCount(n) { const e = (this._e ??= {}); return (e[n] || []).length; }
    eventNames() { const e = (this._e ??= {}); return Object.keys(e).filter(k => e[k].length > 0); }
    setMaxListeners(n) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners; }
    prependListener(n, fn) { const e = (this._e ??= {}); (e[n] = e[n] || []).unshift(fn); return this; }
    rawListeners(n) { const e = (this._e ??= {}); return e[n] || []; }
  }
  EE.EventEmitter = EE;
  EE.defaultMaxListeners = 10;
  return EE;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  stream module (real, with backpressure) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════
${STREAMS_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  node:sqlite module (sql.js-backed) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
${SQLITE_SHIM_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  undici (npm) — mapped onto the platform HTTP stack ─────────────
// ═══════════════════════════════════════════════════════════════════════
${UNDICI_SHIM_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  util module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __utilMod = {
  inspect: (o, opts) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } },
  format: (fmt, ...a) => {
    if (typeof fmt !== "string") return [fmt, ...a].map(__fmt).join(" ");
    let i = 0;
    return fmt.replace(/%[sdifjoO%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= a.length) return m;
      const v = a[i++];
      if (m === "%s") return String(v);
      if (m === "%d" || m === "%i" || m === "%f") return Number(v).toString();
      if (m === "%j") { try { return JSON.stringify(v); } catch { return "[Circular]"; } }
      if (m === "%o" || m === "%O") { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
      return String(v);
    }) + (i < a.length ? " " + a.slice(i).map(__fmt).join(" ") : "");
  },
  // util.formatWithOptions(inspectOptions, format[, ...args]) — identical
  // to format() but takes inspect options as the first argument. consola's
  // FancyReporter calls this directly (FancyReporter.formatArgs); its
  // absence crashed every consola-based CLI under Nimbus with
  // "(0 , import_node_util.formatWithOptions) is not a function" (nuxi init,
  // at its first consola.error after "Welcome to Nuxt!"). This shim's
  // inspect() ignores color/depth options, so dropping them and delegating
  // to format() is behaviourally exact for what the shim can render.
  formatWithOptions: (_inspectOptions, ...a) => __utilMod.format(...a),
  promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, r) => e ? rej(e) : res(r))),
  callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then(r => cb(null, r), e => cb(e)); },
  // X.5-Q: util.types polyfill expansion. The pre-X.5-Q 3-method shape
  // (isDate, isRegExp, isPromise) was insufficient for jsdom's bundled
  // undici, which dereferences isUint8Array (lib/web/fetch/util.js +
  // body.js), isArrayBuffer (lib/web/websocket/websocket.js), and
  // util.types.isProxy (lib/web/fetch/headers.js). Expanding to the
  // 17-method shape below mirrors Node.js's util.types surface for the
  // common cases; isProxy returns false (no userland Proxy detection).
  types: {
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isPromise: (v) => v instanceof Promise,
    isUint8Array: (v) => v instanceof Uint8Array,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer
      || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isNativeError: (v) => v instanceof Error,
    isAsyncFunction: (v) => v && v.constructor && v.constructor.name === "AsyncFunction",
    isGeneratorFunction: (v) => v && v.constructor && v.constructor.name === "GeneratorFunction",
    isProxy: (v) => false,
    isBoxedPrimitive: (v) => v instanceof Boolean || v instanceof Number
      || v instanceof String || (typeof v === "object" && v !== null && (v.constructor === Symbol || v.constructor === BigInt)),
  },
  inherits: (c, s) => {
    // X.5-Z5 Defect-B fix: guard against null/undefined superCtor or a
    // superCtor whose .prototype is null/undefined. Without this guard,
    // Object.create(undefined.prototype, ...) and Object.create(null, ...)
    // both throw 'Object prototype may only be an Object or null: undefined'
    // — same surface as Defect A but for shim namespaces with no synthetic
    // .prototype. Mirrors the canonical inherits_browser.js fallback.
    if (s == null || s.prototype == null) return;
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
  },
  deprecate: (fn, msg) => fn,
  debuglog: () => () => {},
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  // util.stripVTControlCharacters(str) — Node 16.11+. Strips ANSI
  // escape sequences from a string. Used by sv (svelte CLI), modern
  // log libraries, and any CLI that wants to measure displayed-width
  // independent of color codes. Pre-fix, sv's engine module imported
  // this from 'node:util' and crashed at module-init with
  // "stripVTControlCharacters is not a function".
  //
  // Real-Node impl strips C0/C1 ANSI escapes via a single regex.
  // Standard CSI sequence pattern: ESC + '[' + parameter bytes + final byte.
  stripVTControlCharacters: (str) => {
    if (typeof str !== "string") return str;
    // Covers most common ANSI sequences: CSI (\x1b[...m, \x1b[...K, etc.),
    // OSC, simple ESC sequences. Mirrors the regex Node's lib/internal/
    // util/inspect.js uses (slightly relaxed).
    return str.replace(/\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b[\\(\\)\\*\\+][AB012]|\\x1b\\][^\\x07\\x1b]*[\\x07\\x1b]|\\x1b[=>]/g, "");
  },
  // util.styleText(format, text [, opts]) — Node 20.12+. Returns text
  // wrapped in ANSI escape sequences for terminal styling. Used by
  // create-vite and many modern CLIs.
  //
  // Surface: format may be a single style string or an array of style
  // strings; in either case we apply each style's open code, then the
  // text, then the closing code. The Nimbus terminal renders ANSI;
  // unrecognised formats pass through as plain text (Node's docs say
  // it throws TypeError in strict mode, but our facet code may emit
  // styled error messages even for unrecognised foreground colors
  // — choose the lenient pass-through to keep CLIs functioning).
  styleText: (format, text /*, _opts */) => {
    // ANSI lookup. Mirrors Node's util.inspect.colors keys.
    const codes = {
      reset:           [0, 0],
      bold:            [1, 22],
      italic:          [3, 23],
      underline:       [4, 24],
      strikethrough:   [9, 29],
      hidden:          [8, 28],
      dim:             [2, 22],
      overlined:       [53, 55],
      blink:           [5, 25],
      inverse:         [7, 27],
      doubleunderline: [21, 24],
      framed:          [51, 54],
      black:           [30, 39], red:    [31, 39], green:   [32, 39],
      yellow:          [33, 39], blue:   [34, 39], magenta: [35, 39],
      cyan:            [36, 39], white:  [37, 39], gray:    [90, 39],
      grey:            [90, 39],
      blackBright:     [90, 39], redBright:    [91, 39], greenBright: [92, 39],
      yellowBright:    [93, 39], blueBright:   [94, 39], magentaBright: [95, 39],
      cyanBright:      [96, 39], whiteBright:  [97, 39],
      bgBlack:         [40, 49], bgRed:        [41, 49], bgGreen: [42, 49],
      bgYellow:        [43, 49], bgBlue:       [44, 49], bgMagenta: [45, 49],
      bgCyan:          [46, 49], bgWhite:      [47, 49], bgGray: [100, 49],
      bgGrey:          [100, 49],
      bgBlackBright:   [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49],
      bgYellowBright:  [103, 49], bgBlueBright: [104, 49], bgMagentaBright: [105, 49],
      bgCyanBright:    [106, 49], bgWhiteBright: [107, 49],
    };
    const formats = Array.isArray(format) ? format : [format];
    let opens = "";
    let closes = "";
    for (const f of formats) {
      const c = codes[f];
      if (c) {
        opens += "\\x1b[" + c[0] + "m";
        closes = "\\x1b[" + c[1] + "m" + closes;
      }
    }
    return opens + String(text) + closes;
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  url module ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// X.5-M (M-3): lenient URL constructor for rolldown-bundled CJS packages.
//
// Rolldown/rollup-bundled CJS packages (vite v7, esbuild plugins, …)
// emit at module top-level:
//
//     const X = new URL("../../../src/node/constants.ts", import.meta.url);
//
// where the rolldown-CJS polyfill for import.meta.url evaluates to literal
// null (the bare word) in our facet (no document, no location, polyfill doesn't reach
//
// workerd's URL constructor strict-rejects null/undefined base, throwing
// "Invalid URL string." at module top-level eval — breaks require('vite').
//
// Fix: wrap globalThis.URL so null/undefined base for a string input
// defaults to "file:///" (after first trying the input as an absolute
// URL). All other URL behaviour is passthrough; instanceof checks and
// static methods (canParse, parse, createObjectURL, ...) preserved.
//
// Stage A (this commit): vite no longer throws at the URL constructor;
// it now progresses to a deeper fs-URL composition gap (vite passes URL
// instances / file:// strings to fs.readFileSync, which our fs shim
// doesn't strip) — that's out-of-charter, see X5M-retro §3.
//
// X.5-M3 (this section): when esbuild ESM-to-CJS pre-compile substitutes
// import.meta.url with undefined (its documented empty-import-meta
// warning behavior), new URL(rel, undefined) falls into the null-base
// branch below. Pre-M3 the fallback was a literal "file:///", which
// resolved every new URL("../foo", import.meta.url) to root-relative
// file:///foo — wrong for vite/dist/node/chunks/logger.js:75 et al.
//
// M3 plumbs the currently-loading module's path via globalThis.__currentModulePath
// (set+restored by __loadModule per call). When set, the fallback becomes
// "file:///" + __currentModulePath so relative URLs resolve against
// the real on-VFS module location — restoring proper import.meta.url
(() => {
  const _Orig = globalThis.URL;
  class _Shim extends _Orig {
    constructor(input, base) {
      if (base == null && typeof input === "string") {
        try { super(input); return; }
        catch {
          // X.5-M3: prefer current module path when known, so
          //   new URL(rel, undefined) === new URL(rel, "file:///" + __filename)
          // matches real ESM import-meta-url resolution.
          const cur = globalThis.__currentModulePath;
          const fallback = (typeof cur === "string" && cur.length > 0)
            ? "file:///" + cur.replace(/^\\/+/, "")
            : "file:///";
          super(input, fallback);
          return;
        }
      }
      super(input, base);
    }
  }
  for (const k of Object.getOwnPropertyNames(_Orig)) {
    if (typeof _Orig[k] === "function" && !(k in _Shim)) {
      try { _Shim[k] = _Orig[k].bind(_Orig); } catch (_e) {}
    }
  }
  // NOTE: cannot reassign _Shim.prototype = _Orig.prototype — workerd treats
  // class.prototype as read-only. Inheritance via "extends _Orig" is enough:
  // _Shim instances are instanceof _Orig, and _Shim.prototype's __proto__ is
  // _Orig.prototype (so all native URL methods are reachable via the chain).
  globalThis.URL = _Shim;
})();
const __urlMod = {
  URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  parse: (s) => { try { const u = new URL(s); return { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href, host: u.host }; } catch { return { href: s }; } },
  format: (o) => { if (typeof o === "string") return o; if (o instanceof URL) return o.href; return (o.protocol || "http:") + "//" + (o.hostname || "") + (o.port ? ":" + o.port : "") + (o.pathname || "/") + (o.search || ""); },
  resolve: (from, to) => new URL(to, from).href,
  pathToFileURL: (p) => new URL("file://" + p),
  fileURLToPath: (u) => (typeof u === "string" ? u : u.pathname).replace(/^file:\\/\\//, ""),
};
__urlMod.URL = globalThis.URL;

// ═══════════════════════════════════════════════════════════════════════
// ──  crypto module (W3: forward to workerd's real node:crypto) ──────
// ═══════════════════════════════════════════════════════════════════════
//
// Pre-W3 this was a hand-rolled FNV-1a fake that returned a 16-byte
// FNV state repeated as a 32-byte "sha256" hash — silent correctness
// disaster (sha256("hello") = abdd62852c5bd7fc9fa116d64f0254ec × 2
// instead of 2cf24dba...).  W3 forwards to workerd's real
// node:crypto, which has been stable since CF changelog 2025-04-08.
// __real_crypto comes from the static import block at the top of the
// generated facet file (see src/_shared/real-node-imports.ts).
//
// The forward is exhaustive — Node 20 surface (createHash, createHmac,
// pbkdf2/Sync, scrypt/Sync, createCipheriv/Decipheriv, createSign/
// Verify, KeyObject, generateKeyPair/Sync, createPublic/PrivateKey,
// timingSafeEqual, randomBytes/UUID/Int/Fill, getHashes/Ciphers/Curves,
// constants, webcrypto, subtle) is all on the workerd module.
const __cryptoMod = (() => {
  const real = (typeof __real_crypto !== 'undefined') ? (__real_crypto.default ?? __real_crypto) : null;
  if (real && typeof real.createHash === 'function') return real;
  // Defensive fallback: if for some reason the static import didn't
  // materialise (e.g. compat-flag drift), surface honest-error rather
  // than silently shipping a fake hash.  Anything beyond randomBytes/
  // randomUUID throws a NIMBUS-flavoured error.
  function _unavail(name) {
    return () => {
      const e = new Error('crypto.' + name + ': workerd node:crypto not available. Check facet compat date >= 2025-04-08.');
      e.code = 'ERR_CRYPTO_UNAVAILABLE';
      throw e;
    };
  }
  return {
    randomBytes: (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return __BufferMod.from(a); },
    randomUUID: () => crypto.randomUUID(),
    randomInt: (min, max) => { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); },
    randomFillSync: (buf) => { crypto.getRandomValues(buf); return buf; },
    createHash: _unavail('createHash'),
    createHmac: _unavail('createHmac'),
    pbkdf2: _unavail('pbkdf2'),
    pbkdf2Sync: _unavail('pbkdf2Sync'),
    timingSafeEqual: (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; },
    constants: {},
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto?.subtle,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  vm module (W3: hybrid — forward surface, honest-error on eval) ──
// ═══════════════════════════════════════════════════════════════════════
//
// Workerd's node:vm provides the API surface (constants, classes,
// runInContext as a function) BUT every code-running method throws
// ERR_METHOD_NOT_IMPLEMENTED at request-handler time. New Function
// is also blocked at request time. So we forward the surface (so
// jsdom's static-load checks pass) and wrap the eval methods with
// a honest Nimbus error so callers know it's the workerd block.
//
// Acceptance limitation: jsdom static-load works; jsdom HTML-script
// execution does not.  Documented in W3 retro for W3.5 follow-up
// (a parser-based vm fallback, or pre-bundle vm-using scripts at
// install time).
const __vmMod = (() => {
  const real = (typeof __real_vm !== 'undefined') ? (__real_vm.default ?? __real_vm) : null;
  function honestError(method, originalErr) {
    const e = new Error(
      'vm.' + method + ': workerd does not implement runtime eval. ' +
      'Pre-bundle vm-using scripts at install time, or wait for W3.5 ' +
      'parser-based fallback. (Original: ' +
      ((originalErr && originalErr.message) || 'no underlying error') + ')'
    );
    e.code = 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
    return e;
  }
  function wrapRuntimeEval(method) {
    return (...args) => {
      if (!real || typeof real[method] !== 'function') {
        throw honestError(method, null);
      }
      try { return real[method](...args); } catch (e) {
        // Workerd surfaces ERR_METHOD_NOT_IMPLEMENTED;
        // \`new Function\` surfaces "Code generation from strings disallowed".
        if (e && (e.code === 'ERR_METHOD_NOT_IMPLEMENTED'
                  || /not implemented|disallowed|Code generation/i.test(e.message || ''))) {
          throw honestError(method, e);
        }
        throw e;
      }
    };
  }
  return {
    constants: real?.constants ?? {},
    createContext: (sandbox, opts) => {
      if (!real || typeof real.createContext !== 'function') return sandbox || {};
      try { return real.createContext(sandbox, opts); }
      catch { return sandbox || {}; }
    },
    isContext: real?.isContext ?? ((o) => !!o),
    runInContext: wrapRuntimeEval('runInContext'),
    runInNewContext: wrapRuntimeEval('runInNewContext'),
    runInThisContext: wrapRuntimeEval('runInThisContext'),
    compileFunction: wrapRuntimeEval('compileFunction'),
    Script: real?.Script ?? class { constructor() { throw honestError('Script', null); } },
    Module: real?.Module,
    SourceTextModule: real?.SourceTextModule,
    SyntheticModule: real?.SyntheticModule,
    measureMemory: real?.measureMemory ?? (async () => ({ total: { jsMemoryEstimate: 0 } })),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  http2 module (W3: stub — non-throwing load, honest connect err) ─
// ═══════════════════════════════════════════════════════════════════════
//
// axios's dist/node code does \`var http2 = require('http2')\` at top
// level, unconditionally. Without this stub the require fails →
// axios fails to load. The actual HTTP/2 transport is only invoked
// when user opts in (\`httpVersion: 2\`); otherwise this shim is dormant.
const __http2Mod = (() => {
  function _err(op) {
    const e = new Error('http2.' + op + ': not implemented in Nimbus. Use fetch() or HTTP/1.1.');
    e.code = 'ERR_HTTP2_NOT_SUPPORTED';
    return e;
  }
  class Http2Session extends __eventsMod {
    constructor() { super(); this.destroyed = false; }
    request() { throw _err('request'); }
    close() { this.destroyed = true; this.emit('close'); }
    destroy(err) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); }
    settings() {}
  }
  function connect(/* authority, opts, listener */) {
    const session = new Http2Session();
    queueMicrotask(() => session.emit('error', _err('connect')));
    return session;
  }
  function createServer() { throw _err('createServer'); }
  return {
    connect, createServer,
    createSecureServer: createServer,
    Http2Session,
    constants: {
      NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1,
      HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_METHOD: ':method',
      HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_AUTHORITY: ':authority',
      HTTP2_HEADER_SCHEME: ':scheme',
    },
    sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  repl module (W3: forward to workerd) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ts-node imports repl. Workerd has it (stub since 2026-03-17).
const __replMod = (() => {
  const real = (typeof __real_repl !== 'undefined') ? (__real_repl.default ?? __real_repl) : null;
  if (real && typeof real.start === 'function') return real;
  // Fallback if static import didn't materialise.
  class REPLServer extends __eventsMod {
    close() { this.emit('exit'); }
    displayPrompt() {} pause() {} resume() {}
    setupHistory(p, cb) { if (cb) cb(null, this); }
    defineCommand() {}
  }
  return { start: (opts) => new REPLServer(), REPLServer, REPL_MODE_SLOPPY: 0, REPL_MODE_STRICT: 1 };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  diagnostics_channel (W3: forward to workerd) ───────────────────
// ═══════════════════════════════════════════════════════════════════════
// fastify uses Channel.runStores at request-handler time — workerd's
// real impl includes this. Forward whole module.
const __diagChannelMod = (() => {
  const real = (typeof __real_diagnostics_channel !== 'undefined') ? (__real_diagnostics_channel.default ?? __real_diagnostics_channel) : null;
  if (real && typeof real.channel === 'function') return real;
  // Fallback: tiny pure-JS impl (no runStores; fastify will fail loud).
  const channels = new Map();
  class Channel {
    constructor(name) { this.name = name; this._subs = []; }
    get hasSubscribers() { return this._subs.length > 0; }
    subscribe(fn) { this._subs.push(fn); }
    unsubscribe(fn) { const i = this._subs.indexOf(fn); if (i >= 0) { this._subs.splice(i, 1); return true; } return false; }
    publish(msg) { for (const fn of [...this._subs]) { try { fn(msg, this.name); } catch {} } }
    runStores(_store, fn, thisArg, ...args) { return fn.apply(thisArg, args); }
    bindStore() {} unbindStore() {}
  }
  function channel(name) {
    let c = channels.get(name);
    if (!c) { c = new Channel(name); channels.set(name, c); }
    return c;
  }
  return {
    channel,
    hasSubscribers: (name) => { const c = channels.get(name); return !!(c && c.hasSubscribers); },
    subscribe: (name, fn) => channel(name).subscribe(fn),
    unsubscribe: (name, fn) => channel(name).unsubscribe(fn),
    tracingChannel: (n) => ({
      start: channel('tracing:' + n + ':start'),
      end: channel('tracing:' + n + ':end'),
      asyncStart: channel('tracing:' + n + ':asyncStart'),
      asyncEnd: channel('tracing:' + n + ':asyncEnd'),
      error: channel('tracing:' + n + ':error'),
      traceSync(fn) { return fn(); },
      tracePromise(fn) { return Promise.resolve().then(fn); },
      traceCallback(fn, _pos, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
    }),
    Channel,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  tls module (W3: forward to workerd, override createServer) ─────
// ═══════════════════════════════════════════════════════════════════════
const __tlsMod = (() => {
  const real = (typeof __real_tls !== 'undefined') ? (__real_tls.default ?? __real_tls) : null;
  if (!real) {
    return { connect: () => { throw new Error('tls: workerd node:tls not available'); } };
  }
  // tls.createServer in workerd would bind a real port; in a facet we want
  // routing through __portRegistry, so override that one method.
  return new Proxy(real, {
    get(t, p) {
      if (p === 'createServer') {
        return () => {
          const e = new Error('tls.createServer: not supported in Nimbus facet. Use http.createServer for routing.');
          e.code = 'ERR_NET_SERVER_NOT_AVAILABLE';
          throw e;
        };
      }
      return t[p];
    }
  });
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  async_hooks module (W3: forward to workerd) ────────────────────
// ═══════════════════════════════════════════════════════════════════════
// AsyncLocalStorage is the 90% case; workerd has it via nodejs_als
// (auto-on at compat date 2026-04-01). createHook is also present
// in workerd as a non-functional stub.
const __asyncHooksMod = (() => {
  const real = (typeof __real_async_hooks !== 'undefined') ? (__real_async_hooks.default ?? __real_async_hooks) : null;
  if (real && typeof real.AsyncLocalStorage === 'function') return real;
  // Defensive fallback.
  return {
    AsyncLocalStorage: class { run(_s, fn, ...args) { return fn(...args); } getStore() { return undefined; } enterWith() {} disable() {} exit(fn, ...args) { return fn(...args); } },
    AsyncResource: class { runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } bind(fn) { return fn; } asyncId() { return 0; } triggerAsyncId() { return 0; } emitDestroy() {} },
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    executionAsyncId: () => 0,
    executionAsyncResource: () => null,
    triggerAsyncId: () => 0,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  inspector module (forward to workerd) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's nodejs_compat exposes node:inspector (Session/console/url).
// The V8 inspector protocol isn't attachable inside a Worker, so a
// constructed Session is inert: connect()/post() resolve/no-op rather
// than driving a real debugger. Tools that import it for optional
// profiling (e.g. nuxi's lockfile timing Session) degrade cleanly.
const __inspectorMod = (() => {
  const real = (typeof __real_inspector !== 'undefined') ? (__real_inspector.default ?? __real_inspector) : null;
  if (real && typeof real.Session === 'function') return real;
  // Defensive fallback when workerd doesn't surface node:inspector.
  const noopSession = class {
    connect() {} connectToMainThread() {} disconnect() {}
    post(_method, _params, cb) { if (typeof _params === 'function') cb = _params; if (typeof cb === 'function') cb(null, {}); }
    on() { return this; } once() { return this; } removeListener() { return this; } emit() { return false; }
  };
  return {
    Session: noopSession,
    console: globalThis.console,
    url: () => undefined,
    open: () => {},
    close: () => {},
    waitForDebugger: () => {},
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  assert module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __assertMod = Object.assign(
  (v, m) => { if (!v) { const e = new Error(m || "AssertionError"); e.code = "ERR_ASSERTION"; throw e; } },
  {
    ok: (v, m) => { if (!v) { const e = new Error(m || "The expression evaluated to a falsy value"); e.code = "ERR_ASSERTION"; throw e; } },
    equal: (a, b, m) => { if (a != b) { const e = new Error(m || __fmt(a) + " != " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notEqual: (a, b, m) => { if (a == b) { const e = new Error(m || __fmt(a) + " == " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    strictEqual: (a, b, m) => { if (a !== b) { const e = new Error(m || __fmt(a) + " !== " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notStrictEqual: (a, b, m) => { if (a === b) { const e = new Error(m || "Values are strictly equal"); e.code = "ERR_ASSERTION"; throw e; } },
    deepEqual: (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { const e = new Error(m || "deepEqual failed"); e.code = "ERR_ASSERTION"; throw e; } },
    deepStrictEqual: (a, b, m) => __assertMod.deepEqual(a, b, m),
    throws: (fn, m) => { try { fn(); } catch { return; } const e = new Error(m || "Missing expected exception"); e.code = "ERR_ASSERTION"; throw e; },
    doesNotThrow: (fn, m) => { try { fn(); } catch (ex) { const e = new Error(m || "Got unwanted exception: " + ex.message); e.code = "ERR_ASSERTION"; throw e; } },
    ifError: (v) => { if (v) throw v; },
    fail: (m) => { const e = new Error(m || "Failed"); e.code = "ERR_ASSERTION"; throw e; },
  }
);

// ═══════════════════════════════════════════════════════════════════════
// ──  querystring, string_decoder, child_process ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __qsMod = {
  stringify: (o, sep, eq) => Object.entries(o || {}).map(([k,v]) => encodeURIComponent(k) + (eq||"=") + encodeURIComponent(String(v))).join(sep||"&"),
  parse: (s, sep, eq) => Object.fromEntries(new URLSearchParams(s)),
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
};

const __stringDecoderMod = {
  StringDecoder: class { constructor(enc) { this.enc = enc || "utf8"; this._dec = new TextDecoder(this.enc); } write(buf) { return this._dec.decode(buf, { stream: true }); } end(buf) { return buf ? this._dec.decode(buf) : ""; } },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  child_process — W8 facet-mapped impl ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Routes through __supervisor.cp{Spawn,StdinWrite,StdinEnd,ReadOutput,
// DrainOutput,Kill,Wait}. When __supervisor is unavailable (rare — the
// facet is normally instantiated with one), every API surfaces a clean
// ERR_CHILD_PROCESS_UNAVAILABLE error rather than silently returning
// success.
//
// Key differences from the pre-W8 stub:
//   1. spawn() actually spawns. Returns a ChildProcess emitter whose
//      stdio streams are real workerd Readable/Writable instances.
//   2. exec/execFile route through spawn (Node-doc semantics). The
//      callback fires (err, stdout, stderr) once the child exits.
//   3. fork() establishes a JSON-newline IPC channel via the stdin
//      queue. ChildProcess.send(msg)→cpStdinWrite of JSON.stringify(msg)+'\\n'.
//      Phase 1 limit: messages are JSON, NOT v8.serialize. Buffer/Date
//      project to their JSON shapes ({type:'Buffer',data:[...]} and
//      ISO strings respectively). Documented in cp-fork-ipc.mjs probe.
//   4. spawnSync returns a result object that FILLS IN LATER: the spawn is
//      async and the fields land as the child's events fire, so a caller
//      reads status=null until it settles. \`__deferred\` resolves with the
//      completed result and is the contract Nimbus consumers await.
//      execSync/execFileSync cannot offer that — their Node contract is to
//      RETURN the child's stdout — so they refuse instead of lying; see
//      _refuseSyncExec below.
//   5. Live children are tracked in __cpChildren so the facet's exit-
//      time drain (see __cpDrainAllChildren below) can issue a
//      cpDrainOutput RPC for each before reportExit fires. This is
//      the BLOCKER-1 fix from W8-plan §8.5: without it, output from
//      unawaited children dies between the last 'data' poll and the
//      facet's reportExit.
const __cpChildren = new Map();   // pid → ChildProcess (for exit-time drain)

const __childProcessMod = (() => {
  const HAS_SUPERVISOR = !!(__supervisor && typeof __supervisor.cpSpawn === "function");

  /**
   * Child stdout/stderr. Defaults to utf8 so consumers see strings (the
   * common cross-spawn / husky pattern); callers override via
   * .setEncoding('hex'), .setEncoding(null), etc. Flowing-mode resumption
   * and encoding are the Readable base class's job — see streams.ts.
   */
  function _makeReadable() {
    return new __streamMod.PassThrough({ encoding: "utf8" });
  }

  /**
   * Create a workerd-Writable backed by cpStdinWrite RPC.
   * Decodes Uint8Array chunks to UTF-8 strings before pushing to RPC
   * (workerd's Writable encodes string→bytes internally; we need to
   * round-trip back to a string for the supervisor's stdin queue).
   */
  function _toUtf8(chunk) {
    if (typeof chunk === "string") return chunk;
    if (chunk instanceof Uint8Array) {
      try { return new TextDecoder("utf-8").decode(chunk); } catch { return String(chunk); }
    }
    return String(chunk);
  }
  function _queueStdinWrite(child, data) {
    if (!child.pid) {
      child._pendingStdin = child._pendingStdin || [];
      child._pendingStdin.push(data);
      return Promise.resolve();
    }
    if (!HAS_SUPERVISOR) return Promise.reject(new Error("ERR_CHILD_PROCESS_UNAVAILABLE"));
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(() =>
      __nimbusUseRpcResult(__supervisor.cpStdinWrite(child.pid, data), () => undefined)
    );
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  function _queueStdinEnd(child) {
    child._pendingStdinEnd = true;
    if (!child.pid) return Promise.resolve();
    if (!HAS_SUPERVISOR) return Promise.resolve();
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(() =>
      __nimbusUseRpcResult(__supervisor.cpStdinEnd(child.pid), () => undefined)
    );
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  function _makeWritable(child) {
    const w = new __streamMod.Writable({
      write(chunk, enc, cb) {
        const s = _toUtf8(chunk);
        _queueStdinWrite(child, s)
          .then(() => cb())
          .catch((e) => cb(e));
      },
      final(cb) {
        _queueStdinEnd(child)
          .then(() => cb())
          .catch(() => cb()); // best-effort end
      },
    });
    return w;
  }

  /** Normalize stdio config to a 3-tuple of 'pipe'|'ignore'|'inherit'. */
  function _normalizeStdio(stdio) {
    if (!stdio) return ["pipe", "pipe", "pipe"];
    if (Array.isArray(stdio)) {
      const a = stdio.slice(0, 3);
      while (a.length < 3) a.push("pipe");
      return a.map((v) => (v === "ignore" || v === "inherit" || v === "pipe") ? v : "pipe");
    }
    if (stdio === "ignore" || stdio === "inherit" || stdio === "pipe") return [stdio, stdio, stdio];
    return ["pipe", "pipe", "pipe"];
  }

  /** Build a fresh ChildProcess emitter with real streams. */
  function _makeChild(opts) {
    const stdio = _normalizeStdio((opts || {}).stdio);
    const child = new __eventsMod();
    child.pid = 0;
    child.connected = false;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    // For 'inherit' or 'ignore', set the corresponding stream to null
    // (Node-doc semantics). 'inherit' → parent's stdio; we don't have
    // one, so null is the closest honest value. Consumers that try to
    // attach .on('data', ...) on null will throw — same as real Node.
    child.stdin  = stdio[0] === "pipe" ? _makeWritable(child) : null;
    child.stdout = stdio[1] === "pipe" ? _makeReadable() : null;
    child.stderr = stdio[2] === "pipe" ? _makeReadable() : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child._pendingKill = null;       // {signal} if kill called before pid
    child._exitFired = false;
    child._closeFired = false;
    child._stdinChain = Promise.resolve();
    child._pendingStdin = [];
    child._pendingStdinEnd = false;
    let _resolveClosePromise;
    child._closePromise = new Promise((resolve) => { _resolveClosePromise = resolve; });
    child._resolveClosePromise = _resolveClosePromise;
    child._closeTracked = false;
    const _trackCloseInterest = (event) => {
      if ((event === "close" || event === "exit") && !child._closeTracked) {
        child._closeTracked = true;
        __pendingIO.push(child._closePromise.catch(() => {}));
      }
    };
    const _childOn = child.on.bind(child);
    const _childOnce = child.once.bind(child);
    child.on = function(event, listener) {
      _trackCloseInterest(event);
      return _childOn(event, listener);
    };
    child.addListener = child.on;
    child.once = function(event, listener) {
      _trackCloseInterest(event);
      return _childOnce(event, listener);
    };
    // For non-piped fds, treat them as already-ended so 'close' can
    // fire after exit without waiting for end events that never come.
    child._stdoutEnded = stdio[1] !== "pipe";
    child._stderrEnded = stdio[2] !== "pipe";
    // Listen to the underlying streams' 'end' events so 'close' fires
    // only after actual data has flushed.
    if (child.stdout) {
      child.stdout.on("end", () => { child._stdoutEnded = true; _maybeFireClose(child); });
    }
    if (child.stderr) {
      child.stderr.on("end", () => { child._stderrEnded = true; _maybeFireClose(child); });
    }

    child.kill = function(signal) {
      // Node semantics: kill() returns true even on already-exited
      // children (it's a best-effort syscall). Reserve false for "no
      // pid known" (kill called before spawn settled and we have
      // nothing to queue).
      const sig = signal || "SIGTERM";
      child.killed = true;
      if (child._exitFired) return true;
      if (!child.pid) { child._pendingKill = { signal: sig }; return true; }
      if (!HAS_SUPERVISOR) return true;
      __pendingIO.push(
        __nimbusUseRpcResult(__supervisor.cpKill(child.pid, sig), () => undefined).catch(() => {}),
      );
      return true;
    };
    child.ref = function() { return child; };
    child.unref = function() { return child; };
    child.disconnect = function() {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    };

    return child;
  }

  /**
   * Coalesce the close event: emit only after exit AND both streams
   * have ended. Once close fires, evict the child from __cpChildren so
   * a long-running parent that spawns thousands of children doesn't
   * leak ChildProcess emitters + PassThrough buffers into memory.
   */
  function _maybeFireClose(child) {
    if (child._exitFired && child._stdoutEnded && child._stderrEnded && !child._closeFired) {
      child._closeFired = true;
      globalThis.__nimbusVfsMayBeStale = true;
      try { child.emit("close", child.exitCode, child.signalCode); } catch {}
      try { child._resolveClosePromise({ code: child.exitCode, signal: child.signalCode }); } catch {}
      // Evict from the live-children map after a microtask so any
      // close listeners that re-read child state see consistent values.
      queueMicrotask(() => {
        try { if (child.pid) __cpChildren.delete(child.pid); } catch {}
      });
    }
  }

  /**
   * Read-loop for a single fd. Long-polls cpReadOutput, pushes chunks
   * into the Readable via .push, handles closure.
   */
  async function _runReadLoop(child, fd, stream, sinceSeqRef) {
    // Exponential backoff for idle children: start at 100ms, double up
    // to 1500ms cap. Reset to 100ms whenever a chunk arrives. Caps
    // workerd subrequest budget consumption for many concurrent
    // children — a 30-way 'concurrently' would otherwise sustain 60
    // in-flight RPCs at 250ms intervals.
    let backoff = 100;
    const BACKOFF_MAX = 1500;
    while (HAS_SUPERVISOR && child.pid && !child._streamsClosed) {
      try {
        const r = await __nimbusUseRpcResult(
          __supervisor.cpReadOutput(child.pid, fd, sinceSeqRef.value, backoff),
          (result) => result,
        );
        if (r && Array.isArray(r.chunks) && r.chunks.length > 0) {
          backoff = 100;  // reset — child is producing
          for (const c of r.chunks) {
            stream.write(c.data);
            if (typeof c.seq === "number" && c.seq > sinceSeqRef.value) {
              sinceSeqRef.value = c.seq;
            }
          }
        } else {
          backoff = Math.min(backoff * 2, BACKOFF_MAX);
        }
        if (r && r.closed) {
          stream.end();
          // _stdoutEnded / _stderrEnded flag is set in the stream's
          // 'end' listener (see _makeChild) so 'close' fires AFTER
          // actual data flushes.
          break;
        }
      } catch (e) {
        // RPC failure → close the stream and bail.
        stream.end();
        break;
      }
    }
  }

  /**
   * Wait-loop: long-poll cpWait until the child reports exit. Emits
   * 'exit' once stamped.
   */
  async function _runWaitLoop(child) {
    while (HAS_SUPERVISOR && child.pid && !child._exitFired) {
      try {
        const r = await __nimbusUseRpcResult(
          __supervisor.cpWait(child.pid, 1000),
          (result) => result,
        );
        if (r && r.done) {
          child.exitCode = r.exitCode;
          child.signalCode = r.signal;
          child._exitFired = true;
          try { child.emit("exit", r.exitCode, r.signal || null); } catch {}
          _maybeFireClose(child);
          break;
        }
      } catch (e) {
        // Couldn't wait — synthesize an error exit.
        child.exitCode = 1;
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        _maybeFireClose(child);
        break;
      }
    }
  }

  /**
   * Internal spawn primitive. Always returns a ChildProcess emitter;
   * any failure (no supervisor, bad cmd) surfaces via 'error' + 'exit'
   * events, never a synchronous throw.
   */
  function _spawn(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || [];
    opts = opts || {};
    const child = _makeChild(opts);

    if (!HAS_SUPERVISOR) {
      queueMicrotask(() => {
        const err = Object.assign(new Error("ERR_CHILD_PROCESS_UNAVAILABLE"), {
          code: "ERR_CHILD_PROCESS_UNAVAILABLE", cmd,
        });
        try { child.emit("error", err); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        // End the streams synchronously; their 'end' listeners flip the
        // _stdoutEnded/_stderrEnded flags and trigger _maybeFireClose.
        try { child.stdout && child.stdout.end(); } catch {}
        try { child.stderr && child.stderr.end(); } catch {}
        _maybeFireClose(child);
      });
      return child;
    }

    // Issue cpSpawn asynchronously. Return the emitter immediately so
    // callers can attach 'data' listeners before any chunk arrives.
    __pendingIO.push((async () => {
      try {
        const r = await __nimbusUseRpcResult(
          __supervisor.cpSpawn({
            command: cmd,
            args,
            env: { ...(__processMod.env || {}), ...(opts.env || {}) },
            cwd: opts.cwd || cwd || "/home/user",
            stdio: opts.stdio || ["pipe", "pipe", "pipe"],
            detached: !!opts.detached,
            shell: opts.shell || false,
          }),
          (result) => result,
        );
        child.pid = r.childPid;
        child.connected = true;
        __cpChildren.set(child.pid, child);
        try { child.emit("spawn"); } catch {}

        // Flush any stdin written before pid was known, preserving
        // write-before-end ordering for common child.stdin.write();
        // child.stdin.end() patterns.
        if (child._pendingStdin && child._pendingStdin.length > 0) {
          const pending = child._pendingStdin.splice(0);
          for (const d of pending) {
            await __nimbusUseRpcResult(
              __supervisor.cpStdinWrite(child.pid, d),
              () => undefined,
            ).catch(() => {});
          }
        }
        if (child._pendingStdinEnd) {
          await __nimbusUseRpcResult(
            __supervisor.cpStdinEnd(child.pid),
            () => undefined,
          ).catch(() => {});
        }

        // Flush a queued kill if .kill() was called before pid landed.
        if (child._pendingKill) {
          const sig = child._pendingKill.signal;
          child._pendingKill = null;
          __pendingIO.push(__nimbusUseRpcResult(
            __supervisor.cpKill(child.pid, sig),
            () => undefined,
          ).catch(() => {}));
        }

        // Start the loops.  Each of these is its own async task pushed
        // onto __pendingIO so the facet's main drain knows to await.
        // For non-piped fds (stdio: 'inherit' or 'ignore'), the stream
        // is null and we skip the read-loop entirely.
        const stdoutSeq = { value: 0 };
        const stderrSeq = { value: 0 };
        if (child.stdout) void _runReadLoop(child, 1, child.stdout, stdoutSeq);
        if (child.stderr) void _runReadLoop(child, 2, child.stderr, stderrSeq);
        void _runWaitLoop(child);
      } catch (e) {
        try { child.emit("error", e); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        try { child.stdout && child.stdout.end(); } catch {}
        try { child.stderr && child.stderr.end(); } catch {}
        _maybeFireClose(child);
      }
    })());

    return child;
  }

  /**
   * exec(cmd, opts, cb) — Node semantics: passes cmd to a shell
   * (we use 'sh -c'). Buffers stdout/stderr; cb fires once on exit.
   */
  function exec(cmd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    // Use sh -c so shell metacharacters work for husky/concurrently/etc.
    const child = _spawn("sh", ["-c", cmd], { ...opts, shell: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    // Use 'close' (fires after exit AND both stdio streams ended) so all
    // chunks have landed before cb resolves.
    child.on("close", (code) => {
      if (cb) {
        if (code === 0) cb(null, stdout, stderr);
        else {
          const err = Object.assign(new Error("Command failed: " + cmd), {
            code, cmd, stdout, stderr,
          });
          cb(err, stdout, stderr);
        }
      }
    });
    return child;
  }

  /**
   * execFile(file, args, opts, cb) — like exec but no shell.
   */
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    const child = _spawn(file, args || [], { ...opts, shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      if (cb) {
        if (code === 0) cb(null, stdout, stderr);
        else {
          const err = Object.assign(new Error("Command failed: " + file), {
            code, stdout, stderr,
          });
          cb(err, stdout, stderr);
        }
      }
    });
    return child;
  }

  /**
   * Fake-sync spawn. Phase-1 limit: V8/Workers can't truly block JS
   * execution. We approximate "synchronous" semantics by:
   *   1. Issuing the underlying _spawn (which queues async work onto
   *      __pendingIO).
   *   2. Returning a result object that LAZILY accumulates fields as
   *      stdout/stderr/exit events fire. Callers like cross-spawn.sync
   *      that read result.status get null until the spawn settles.
   *   3. When the parent facet's main drain settles __pendingIO before
   *      reportExit (facet-manager.ts), the result object's fields are
   *      filled in by the time the supervisor sees the parent exit.
   *
   * Cross-spawn.sync's typical pattern is "const r = spawnSync(...);
   * if (r.status !== 0) throw". To make THIS work synchronously, we
   * also expose a .__deferred promise; idiomatic Nimbus consumers
   * await r.__deferred to get a fully-populated result. Probes test
   * both shapes.
   *
   * Real Node spawnSync truly blocks the event loop via libuv; matching
   * that semantic in workerd would require Atomics.wait on shared state
   * which workerd doesn't expose to userland. Phase 1 documents this.
   */
  function spawnSync(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    const child = _spawn(cmd, args, opts);
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });

    const result = { pid: 0, stdout: "", stderr: "", status: null, signal: null, output: [null, "", ""] };
    let _done = false;
    result.__deferred = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        result.pid = child.pid;
        result.stdout = stdout;
        result.stderr = stderr;
        result.status = code;
        result.signal = signal;
        result.output = [null, stdout, stderr];
        _done = true;
        resolve(result);
      });
    });
    // Best-effort eager population: as 'data' events flow we already
    // mutate stdout/stderr above; once 'exit' fires we also populate
    // .status synchronously (before 'close' which fires after streams
    // drain). This narrows the window where a sync caller sees
    // status=null.
    child.on("exit", (code, signal) => {
      if (result.status === null) result.status = code;
      if (result.signal === null) result.signal = signal;
    });
    return result;
  }

  /**
   * execSync/execFileSync return the child's stdout and throw when it exits
   * non-zero — a contract that is only meaningful once the child has run to
   * completion. A facet has no synchronous I/O primitive: every path to a
   * child process is an async supervisor RPC, and JS in workerd cannot block
   * on one. readFileSync answers the same constraint by serving content that
   * was already staged into the facet, but a command's output cannot exist
   * before the command runs, so there is nothing to pre-stage.
   *
   * The pre-fix shim kicked off an async spawn and returned an empty,
   * not-yet-populated result object. Callers — which shell out precisely
   * because they need the result NOW — read a blank stdout, or run their next
   * step before the child has started, and report success. Refusing is the
   * only honest answer left.
   */
  function _refuseSyncExec(api, command) {
    const err = new Error(
      "child_process." + api + " is not supported in a Nimbus node facet: a facet " +
      "has no synchronous I/O primitive, so a child process cannot be run to completion " +
      "without yielding to the event loop. Returning early would report success for a " +
      "command that has not run. Use the asynchronous form instead — exec/execFile/spawn, " +
      "or await util.promisify(child_process.exec)(...). Command: " + command,
    );
    err.code = "ERR_NIMBUS_SYNC_CHILD_PROCESS";
    err.command = command;
    throw err;
  }

  function execSync(cmd, opts) {
    _refuseSyncExec("execSync", String(cmd));
  }

  function execFileSync(file, args, opts) {
    _refuseSyncExec(
      "execFileSync",
      [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(" "),
    );
  }

  /**
   * fork(modulePath, args, opts) — spawn a child node facet with an IPC
   * channel. IPC is JSON-newline over the stdin queue. Phase-1 limits:
   *   - Buffer → {type:'Buffer', data:[...]} (JSON.stringify projection)
   *   - Date   → ISO string
   *   - Map/Set lose all entries (become {})
   * Documented + asserted in cp-fork-ipc.mjs.
   */
  function fork(modulePath, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    // The child runs the requested module with __NIMBUS_FORK_IPC=1 in env
    // so a corresponding fork-aware runtime in the child knows to listen
    // on stdin for IPC frames.
    const childEnv = { ...(__processMod.env || {}), ...(opts.env || {}), NIMBUS_FORK_IPC: "1" };
    const child = _spawn("node", [modulePath, ...args], { ...opts, env: childEnv });
    child.connected = true;
    child.send = function(msg) {
      if (!child.connected) return false;
      if (!child.stdin) return false;
      try {
        const line = JSON.stringify(msg) + "\\n";
        child.stdin.write(line);
        return true;
      } catch (e) {
        return false;
      }
    };
    // 'message' events: parent listens to child.stdout newline-
    // delimited and parses each as JSON. Real Node IPC uses a side-
    // channel fd; Phase 1 multiplexes through stdout. Any well-formed
    // JSON line counts as a message — non-JSON lines are dropped
    // silently (real fork would route them to stderr-style handling).
    // No __nimbusIpc envelope: round-trip is symmetric with the
    // parent's child.send which writes raw JSON.stringify(msg)+'\\n'.
    child.stdout.on("data", (d) => {
      const lines = String(d).split("\\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); }
        catch { continue; }
        try { child.emit("message", msg); } catch {}
      }
    });
    child.on("exit", () => {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    });
    return child;
  }

  /**
   * Exit-time drain: walk __cpChildren and issue cpDrainOutput RPCs so
   * any unawaited children's stdout lands before the facet's reportExit.
   * Called automatically by the facet's exit path AND exposed for tests.
   */
  async function __cpDrainAllChildren() {
    if (!HAS_SUPERVISOR) return;
    const drains = [];
    for (const [pid, child] of __cpChildren) {
      drains.push((async () => {
        try {
          const r = await __nimbusUseRpcResult(
            __supervisor.cpDrainOutput(pid),
            (result) => result,
          );
          if (r && r.stdout && child.stdout) {
            try { child.stdout.write(r.stdout); } catch {}
          }
          if (r && r.stderr && child.stderr) {
            try { child.stderr.write(r.stderr); } catch {}
          }
          // Force-close streams so listeners receive 'end'. The 'end'
          // event listeners in _makeChild flip _stdoutEnded/_stderrEnded.
          try { child.stdout && child.stdout.end(); } catch {}
          try { child.stderr && child.stderr.end(); } catch {}
          if (!child._exitFired) {
            // No exit reported yet — wait briefly, then synthesize.
            try {
              const w = await __nimbusUseRpcResult(
                __supervisor.cpWait(pid, 500),
                (result) => result,
              );
              if (w && w.done) {
                child.exitCode = w.exitCode;
                child.signalCode = w.signal;
              } else {
                child.exitCode = child.exitCode == null ? 0 : child.exitCode;
              }
            } catch {
              child.exitCode = child.exitCode == null ? 0 : child.exitCode;
            }
            child._exitFired = true;
            try { child.emit("exit", child.exitCode, child.signalCode); } catch {}
          }
          _maybeFireClose(child);
        } catch { /* best-effort */ }
      })());
    }
    await Promise.allSettled(drains);
  }

  return {
    spawn: _spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
    ChildProcess: __eventsMod,
    __cpDrainAllChildren,    // exposed for the facet exit hook + tests
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  console shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// The Console constructor workerd's node:console does not implement (it throws
// "The Console method is not implemented"). OpenTUI's console capture
// (setupConsoleCapture) constructs \`new Console({ stdout, stderr, ... })\` to
// redirect console output into a captured stream; without a working
// constructor the TUI renderer setup throws and the program exits before its
// first frame. This shim writes to the supplied streams via util.format /
// inspect — the Node Console contract OpenTUI relies on.
class __NimbusConsole {
  constructor(options, stderrArg) {
    let out, err, inspectOptions;
    if (options && typeof options === "object" && !options.write) {
      out = options.stdout; err = options.stderr || options.stdout; inspectOptions = options.inspectOptions;
    } else {
      out = options; err = stderrArg || options;
    }
    const fmt = (a) => a.map((x) => typeof x === "string" ? x : __utilMod.inspect(x, inspectOptions)).join(" ");
    const write = (stream, s) => { try { if (stream && typeof stream.write === "function") stream.write(s); } catch {} };
    this.log = (...a) => write(out, fmt(a) + "\\n");
    this.info = (...a) => write(out, fmt(a) + "\\n");
    this.debug = (...a) => write(out, fmt(a) + "\\n");
    this.dir = (o, opts) => write(out, __utilMod.inspect(o, opts || inspectOptions) + "\\n");
    this.error = (...a) => write(err, fmt(a) + "\\n");
    this.warn = (...a) => write(err, fmt(a) + "\\n");
    this.trace = (...a) => write(err, "Trace: " + fmt(a) + "\\n");
    this.assert = (c, ...a) => { if (!c) write(err, "Assertion failed: " + fmt(a) + "\\n"); };
    this.table = (d) => write(out, __utilMod.inspect(d, inspectOptions) + "\\n");
    this.group = (...a) => { if (a.length) write(out, fmt(a) + "\\n"); };
    this.groupCollapsed = this.group;
    this.time = () => {}; this.timeEnd = () => {}; this.timeLog = () => {}; this.timeStamp = () => {};
    this.clear = () => {}; this.count = () => {}; this.countReset = () => {}; this.groupEnd = () => {};
    this.Console = __NimbusConsole;
  }
}
const __consoleMod = {
  log: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  error: (...a) => { stderr += __utilMod.format(...a) + "\\n"; },
  warn: (...a) => { stderr += __utilMod.format(...a) + "\\n"; },
  info: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  debug: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  dir: (o, opts) => { stdout += __utilMod.inspect(o, opts) + "\\n"; },
  trace: (...a) => { stderr += "Trace: " + __utilMod.format(...a) + "\\n"; },
  assert: (c, ...a) => { if (!c) stderr += "Assertion failed: " + __utilMod.format(...a) + "\\n"; },
  time: () => {}, timeEnd: () => {}, timeLog: () => {}, clear: () => {},
  count: () => {}, countReset: () => {}, group: () => {}, groupEnd: () => {},
  table: (d) => { stdout += __utilMod.inspect(d) + "\\n"; },
  Console: __NimbusConsole,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  process shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __nimbusAttachedTty = env?.NIMBUS_ATTACHED_TTY === "1";
let __nimbusTtyColumns = Number(env && env.COLUMNS) || 80;
let __nimbusTtyRows = Number(env && env.LINES) || 24;
const __nimbusTerminalOutputStreams = [];
function __nimbusClampTerminalCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
function __nimbusWriteControl(stream, data, cb) {
  if (stream && typeof stream.write === "function") stream.write(data);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
}
function __nimbusClearLine(stream, dir, cb) {
  const n = Number(dir);
  const mode = n < 0 ? 1 : n > 0 ? 0 : 2;
  return __nimbusWriteControl(stream, "\\x1b[" + mode + "K", cb);
}
function __nimbusClearScreenDown(stream, cb) {
  return __nimbusWriteControl(stream, "\\x1b[0J", cb);
}
function __nimbusCursorTo(stream, x, y, cb) {
  if (typeof y === "function") {
    cb = y;
    y = undefined;
  }
  const col = __nimbusClampTerminalCoordinate(x) + 1;
  if (y === undefined) return __nimbusWriteControl(stream, "\\x1b[" + col + "G", cb);
  const row = __nimbusClampTerminalCoordinate(y) + 1;
  return __nimbusWriteControl(stream, "\\x1b[" + row + ";" + col + "H", cb);
}
function __nimbusMoveCursor(stream, dx, dy, cb) {
  let out = "";
  const x = Math.trunc(Number(dx) || 0);
  const y = Math.trunc(Number(dy) || 0);
  if (x < 0) out += "\\x1b[" + (-x) + "D";
  else if (x > 0) out += "\\x1b[" + x + "C";
  if (y < 0) out += "\\x1b[" + (-y) + "A";
  else if (y > 0) out += "\\x1b[" + y + "B";
  return __nimbusWriteControl(stream, out, cb);
}
function __nimbusEmitTerminalResize() {
  for (const stream of __nimbusTerminalOutputStreams) {
    try { stream.emit("resize"); } catch {}
  }
}
function __makeProcessStdin() {
  const r = new __streamMod.PassThrough();
  let seeded = false;
  let encoding = null;
  r.isTTY = __nimbusAttachedTty;
  r.isRaw = false;
  r.setRawMode = function(mode) {
    r.isRaw = mode !== false;
    return r;
  };
  r.ref = function() { return r; };
  r.unref = function() { return r; };
  r.setEncoding = function(enc) { encoding = enc || null; return r; };
  const liveChildPid = env && env.NIMBUS_CP_CHILD_PID
    ? Number(env.NIMBUS_CP_CHILD_PID)
    : 0;
  if (liveChildPid) {
    try {
      globalThis.__nimbusProcessStdin = r;
      const pending = Array.isArray(globalThis.__nimbusPendingProcessInput)
        ? globalThis.__nimbusPendingProcessInput.splice(0)
        : [];
      globalThis.__nimbusPendingProcessInputBytes = 0;
      for (const chunk of pending) r.write(String(chunk));
      if (globalThis.__nimbusPendingProcessInputEnded) {
        globalThis.__nimbusPendingProcessInputEnded = false;
        queueMicrotask(() => r.end());
      }
    } catch {}
  }
  async function pumpLiveStdin() {
    let readFailures = 0;
    while (liveChildPid && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      let packet;
      try {
        // Unref'd: this long-poll runs for the whole life of an attached
        // facet, so counting it as in-flight work would mean the entry drain
        // never sees the program finish.
        packet = await __nimbusUseRpcResultUnref(
          __supervisor.cpReadStdin(liveChildPid, 1000),
          (result) => result,
        );
        readFailures = 0;
      } catch (pumpErr) {
        // Transient supervisor failure — e.g. the session Durable Object
        // instance was reset mid-flight ("Internal error in Durable Object
        // storage caused object to be reset"). The binding routes by DO id,
        // so the next call lands on the fresh instance; killing the pump
        // (and falsely reporting exit 1) on the first rejection turned a
        // recoverable blip into a dead TUI. Retry with a short pause and
        // give up only on persistent failure.
        readFailures++;
        if (readFailures > 10) throw pumpErr;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (packet && packet.resize) {
        __nimbusTtyColumns = Number(packet.resize.columns) || __nimbusTtyColumns;
        __nimbusTtyRows = Number(packet.resize.rows) || __nimbusTtyRows;
        __nimbusEmitTerminalResize();
        try { __processEvents.emit("SIGWINCH"); } catch {}
      }
      if (packet && packet.signal) {
        const sig = String(packet.signal);
        let handled = false;
        try { handled = __processEvents.emit(sig); } catch {}
        if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
          const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
          __nimbusReportProcessExit(code, sig);
          throw new __ProcessExit(code);
        }
      }
      if (packet && packet.data) r.write(packet.data);
      if (packet && packet.ended) {
        r.end();
        break;
      }
      // Diagnostic hook (runner-installed, NIMBUS_DIAG_EXEC-gated): the pump's
      // cpReadStdin round-trip is the one I/O yield a resident facet is
      // guaranteed to keep making, so it paces the [oc-mem] sampler even when
      // facet timers starve.
      try { globalThis.__nimbusOcPumpDiag && globalThis.__nimbusOcPumpDiag(); } catch {}
    }
  }
  const seed = () => {
    if (seeded) return;
    seeded = true;
    if (liveChildPid && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      const pump = pumpLiveStdin().catch((e) => {
        if (e instanceof __ProcessExit) {
          if (!__nimbusProcessExitReported) {
            try { __nimbusReportProcessExit(e.code, ""); } catch {}
          }
          return;
        }
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        try { __nimbusUseRpcResult(__supervisor.stderr(trace + "\\n"), () => undefined).catch(() => {}); } catch {}
        try { __nimbusUseRpcResult(__supervisor.reportExit(1, trace + "\\n"), () => undefined).catch(() => {}); } catch {}
        try { r.end(); } catch {}
      });
      __nimbusLiveStdinPump = pump;
      return;
    }
    queueMicrotask(() => {
      const data = typeof stdin === "string" ? stdin : "";
      if (data.length > 0) r.write(data);
      r.end();
    });
  };
  r.__nimbusStartLivePump = seed;
  const origResume = typeof r.resume === "function" ? r.resume.bind(r) : null;
  const origPause = typeof r.pause === "function" ? r.pause.bind(r) : null;
  r.resume = function() {
    seed();
    return origResume ? origResume() : r;
  };
  r.pause = function() {
    return origPause ? origPause() : r;
  };
  const origOn = r.on.bind(r);
  function wrapDataListener(listener) {
    const wrapped = (chunk) => {
      let out = chunk;
      if (encoding && chunk instanceof Uint8Array) {
        try { out = new TextDecoder(encoding).decode(chunk); }
        catch { out = chunk; }
      }
      return listener(out);
    };
    wrapped.__orig = listener;
    return wrapped;
  }
  r.on = function(event, listener) {
    seed();
    if (event === "data" && typeof listener === "function") {
      const wrapped = wrapDataListener(listener);
      const ret = origOn(event, wrapped);
      try { r.resume(); } catch {}
      return ret;
    }
    return origOn(event, listener);
  };
  r.addListener = r.on;
  const origRead = r.read.bind(r);
  r.read = function(size) { seed(); return origRead(size); };
  return r;
}

function __makeProcessOutputStream(streamName) {
  const stream = new __eventsMod();
  Object.assign(stream, {
    fd: streamName === "stderr" ? 2 : 1,
    isTTY: __nimbusAttachedTty,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    writableLength: 0,
    writableNeedDrain: false,
    writableHighWaterMark: 16 * 1024,
    writableObjectMode: false,
    writableCorked: 0,
    readable: false,
    destroyed: false,
    closed: false,
    errored: null,
    write(d, enc, cb) {
      if (typeof enc === "function") cb = enc;
      const s = String(d);
      if (streamName === "stderr") stderr += s;
      else stdout += s;
      if (typeof cb === "function") queueMicrotask(cb);
      return true;
    },
    getColorDepth: () => __nimbusAttachedTty ? 24 : 1,
    hasColors: () => __nimbusAttachedTty,
    clearLine(dir, cb) { return __nimbusClearLine(stream, dir, cb); },
    clearScreenDown(cb) { return __nimbusClearScreenDown(stream, cb); },
    cursorTo(x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); },
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); },
    end(d, enc, cb) {
      if (d !== undefined && typeof d !== "function") stream.write(d, enc);
      if (typeof d === "function") cb = d;
      if (typeof enc === "function") cb = enc;
      stream.writableEnded = true;
      stream.writableFinished = true;
      if (typeof cb === "function") queueMicrotask(cb);
      stream.emit("finish");
      return stream;
    },
    destroy(err) {
      stream.destroyed = true;
      stream.closed = true;
      stream.errored = err || null;
      if (err) stream.emit("error", err);
      stream.emit("close");
      return stream;
    },
    cork() { stream.writableCorked++; },
    uncork() { if (stream.writableCorked > 0) stream.writableCorked--; },
    ref() { return stream; },
    unref() { return stream; },
  });
  Object.defineProperty(stream, "columns", { enumerable: true, get() { return __nimbusTtyColumns; } });
  Object.defineProperty(stream, "rows", { enumerable: true, get() { return __nimbusTtyRows; } });
  __nimbusTerminalOutputStreams.push(stream);
  return stream;
}

function __nimbusReportProcessExit(code, reason) {
  if (__nimbusProcessExitReported) return;
  __nimbusProcessExitCode = Number(code ?? 0);
  try { if (__nimbusProcessExitResolve) __nimbusProcessExitResolve(__nimbusProcessExitCode); } catch {}
  // Generated lifecycle owners defer the terminal supervisor report until
  // their durability boundary has drained. Reporting here would retire the
  // writer capability before pending sync/append mutations can commit.
  if (
    typeof __nimbusDeferProcessExitReport !== "undefined"
    && __nimbusDeferProcessExitReport
  ) return;
  __nimbusProcessExitReported = true;
  if (__supervisor && typeof __supervisor.reportExit === "function") {
    try {
      const task = __nimbusUseRpcResult(__supervisor.reportExit(code, reason || ""), () => undefined);
      if (Array.isArray(__pendingIO) && task && typeof task.catch === "function") {
        __pendingIO.push(task.catch(() => {}));
      }
    } catch {}
  }
}

function __nimbusSignalSelf(signal) {
  const sig = String(signal || "SIGTERM");
  const handled = __processEvents.emit(sig);
  if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
    const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
    __nimbusReportProcessExit(code, sig);
    throw new __ProcessExit(code);
  }
  return true;
}

const __processEvents = new __eventsMod();
let __processUmask = Number(cred.umask) & 0o777;
const __processMod = {
  argv: ["node", ...(argv || [])],
  env: env || {},
  cwd: () => cwd || "/home/user",
  chdir: (d) => { cwd = __pathMod.resolve(cwd || "/home/user", d); },
  exit: (code) => {
    exitCode = code ?? 0;
    try { __processEvents.emit("exit", exitCode); } catch {}
    __nimbusReportProcessExit(exitCode, "");
    throw new __ProcessExit(exitCode);
  },
  platform: "linux", arch: "x64",
  version: ${NODE_VERSION_LITERAL}, versions: ${NODE_VERSIONS_LITERAL},
  execPath: "/usr/local/bin/node",
  execArgv: [],
  pid: 1, ppid: 0, title: "node",
  stdout: __makeProcessOutputStream("stdout"),
  stderr: __makeProcessOutputStream("stderr"),
  stdin: __makeProcessStdin(),
  hrtime: Object.assign(
    (prev) => { const n = Date.now(); const s = Math.floor(n / 1000); const ns = (n % 1000) * 1e6; if (!prev) return [s, ns]; return [s - prev[0], ns - prev[1]]; },
    { bigint: () => BigInt(Date.now()) * 1000000n }
  ),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  on: (name, listener) => { __processEvents.on(name, listener); return __processMod; },
  addListener: (name, listener) => { __processEvents.on(name, listener); return __processMod; },
  prependListener: (name, listener) => { __processEvents.prependListener(name, listener); return __processMod; },
  once: (name, listener) => { __processEvents.once(name, listener); return __processMod; },
  off: (name, listener) => { __processEvents.removeListener(name, listener); return __processMod; },
  removeListener: (name, listener) => { __processEvents.removeListener(name, listener); return __processMod; },
  removeAllListeners: (name) => { __processEvents.removeAllListeners(name); return __processMod; },
  emit: (name, ...args) => __processEvents.emit(name, ...args),
  listeners: (name) => __processEvents.listeners(name),
  rawListeners: (name) => __processEvents.rawListeners(name),
  listenerCount: (name) => __processEvents.listenerCount(name),
  eventNames: () => __processEvents.eventNames(),
  setMaxListeners: (n) => { __processEvents.setMaxListeners(n); return __processMod; },
  getMaxListeners: () => __processEvents.getMaxListeners(),
  uptime: () => 0,
  kill: (pid, signal) => {
    const n = Number(pid);
    if (n === __processMod.pid || n === 0) return __nimbusSignalSelf(signal || "SIGTERM");
    return false;
  },
  getuid: () => Number(cred.uid),
  geteuid: () => Number(cred.uid),
  getgid: () => Number(cred.gid),
  getegid: () => Number(cred.gid),
  getgroups: () => Array.from(cred.groups, Number),
  umask: (mask) => {
    const previous = __processUmask;
    if (mask === undefined) return previous;
    const next = typeof mask === "string" ? parseInt(mask, 8) : Number(mask);
    if (!Number.isInteger(next) || next < 0 || next > 0o777) {
      const error = new TypeError("The value of mask is out of range");
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    __processUmask = next;
    if (__supervisor && typeof __supervisor.setUmask === "function") {
      const task = __nimbusUseRpcResult(__supervisor.setUmask(next), () => undefined);
      if (Array.isArray(__pendingIO)) __pendingIO.push(task);
    }
    return previous;
  },
  // process.binding is a deprecated internal API some bundled legacy
  // packages still read at module init (e.g. minipass, bundled by degit
  // → create-cloudflare, does process.binding('fs') for FS constants).
  // Surface the constants those callers need; reject unknown bindings
  // with the same shape Node uses so anything else fails loudly.
  binding: (name) => {
    if (name === "fs") return { constants: __constantsMod };
    if (name === "constants") {
      return { fs: __constantsMod, os: { errno: __constantsMod, signals: __constantsMod }, crypto: {} };
    }
    const err = new Error("No such module: " + name);
    err.code = "ERR_UNKNOWN_BUILTIN_MODULE";
    throw err;
  },
};

function __nimbusRuntimeErrorTrace(error) {
  if (error && typeof error === "object") {
    return error.stack || error.message || String(error);
  }
  return String(error);
}

function __nimbusFailUnhandledAsync(error, kind) {
  if (error instanceof __ProcessExit) {
    __nimbusReportProcessExit(error.code, "");
    return;
  }
  const label = kind === "rejection"
    ? "Unhandled promise rejection: "
    : "Uncaught exception: ";
  const line = label + __nimbusRuntimeErrorTrace(error) + "\\n";
  stderr += line;
  if (__supervisor && typeof __supervisor.stderr === "function") {
    try { __nimbusUseRpcResult(__supervisor.stderr(line), () => undefined).catch(() => {}); } catch {}
  }
  __nimbusReportProcessExit(1, line);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event && typeof event === "object" && "reason" in event ? event.reason : event;
    const promise = event && typeof event === "object" && "promise" in event ? event.promise : undefined;
    let handled = false;
    try { handled = __processEvents.emit("unhandledRejection", reason, promise); } catch {}
    if (!handled) __nimbusFailUnhandledAsync(reason, "rejection");
    try { event.preventDefault?.(); } catch {}
  });
  globalThis.addEventListener("error", (event) => {
    const error = event && typeof event === "object" && "error" in event ? event.error : event;
    let handled = false;
    try { handled = __processEvents.emit("uncaughtException", error); } catch {}
    if (!handled) __nimbusFailUnhandledAsync(error, "exception");
    try { event.preventDefault?.(); } catch {}
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ──  Builtins initialization (MUST come before require) ─────────────
// ═══════════════════════════════════════════════════════════════════════
const builtins = {};
builtins.fs = __fsMod;
builtins.path = __pathMod;
builtins.os = __osMod;
// framework-fixes-F1 (2026-05-12): 'node:constants' (legacy 'constants').
// Pre-fix require('node:constants') threw "Cannot find module" because
// the table didn't include it. create-next-app touches
// constants.UV_FS_O_FILEMAP at module init; that crash blocked the entire
// scaffold flow. See __constantsMod definition above for the full shape.
builtins.constants = __constantsMod;
// Also register under the 'node:'-prefixed key. __requireFrom (this
// file ~line 2900) has a fast-path strip but the explicit registration
// matches the dns/promises + util/types convention.
builtins["node:constants"] = __constantsMod;
builtins.events = __eventsMod;
builtins.stream = __streamMod;
// X.5-R: real Node's \`require('stream')\` re-exports EventEmitter
// (verified: \`require('stream').EventEmitter === require('events').EventEmitter\`
// in Node 20). Older CJS code reads EE off the stream module instead of
// events — e.g., @redis/client/dist/lib/client/cache.js:301:
// \`class ClientSideCacheProvider extends stream_1.EventEmitter {}\` where
// \`stream_1 = require("stream")\`. Without this re-export, \`stream_1.EventEmitter\`
// is undefined and \`class … extends undefined\` throws "Class extends value
// Idempotent guard so a future streams.ts revision that already exposes
// EventEmitter doesn't get clobbered.
if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;
builtins.buffer = { Buffer: __BufferMod };
builtins.util = __utilMod;
builtins.url = __urlMod;
builtins.crypto = __cryptoMod;
builtins.assert = __assertMod;
builtins.querystring = __qsMod;
builtins.string_decoder = __stringDecoderMod;
// node:sqlite (sql.js-backed). Dual-registered like node:fs/promises; the
// resolver strips the node: prefix but the explicit key matches the
// constants/util-types convention. The engine boots lazily and
// synchronously on the first DatabaseSync open (sqlite-shim.ts __getSQL) —
// the ~48 MiB boot must not be paid by processes that never open a DB.
builtins.sqlite = __sqliteMod;
builtins["node:sqlite"] = __sqliteMod;
builtins.child_process = __childProcessMod;
builtins.process = __processMod;
builtins.console = __consoleMod;
builtins.http = (() => {
  if (!globalThis.__portRegistry) globalThis.__portRegistry = new Map();
  // Capture the host Response/encoder at shim-init (before any user code can
  // shadow globalThis.Response) — the dispatch layer wraps the response stream
  // in a host Response and streams it across the RPC boundary.
  const __httpEnc = new TextEncoder();
  const __hostResponse = globalThis.Response;
  // Streaming ServerResponse: writes flow into a ReadableStream that the
  // dispatch layer (__nimbusServeHttp) returns the moment response headers are
  // known — nothing is buffered to "finish". A live SSE / chunked body that
  // never ends streams indefinitely; a slow-but-finite response streams as it
  // is produced. res.write() enqueues bytes (binary-safe), res.end() closes the
  // stream, and a downstream cancel (client disconnect) releases the handler.
  class ServerResponse extends __eventsMod {
    constructor() {
      super();
      this.statusCode = 200;
      this.statusMessage = undefined;
      this.headers = {};
      this._headersSent = false;
      this._ended = false;
      this._destroyed = false;
      this._closed = false;
      this._controller = null;
      this._needDrain = false;
      const self = this;
      // Bounded backpressure: up to 16 queued chunks before write() reports
      // backpressure (returns false) and a 'drain' fires on the next pull.
      this._stream = new ReadableStream({
        start(c) { self._controller = c; },
        pull() { if (self._needDrain) { self._needDrain = false; self.emit("drain"); } },
        cancel() {
          // Downstream (client / attach facet) went away — release the handler
          // so a dead SSE does not keep the producer writing into a void.
          self._destroyed = true;
          self._ended = true;
          self.emit("aborted");
          self._emitClose();
        },
      }, new CountQueuingStrategy({ highWaterMark: 16 }));
      // Resolves as soon as headers are flushed (writeHead / first write / end).
      this._headersReady = new Promise((resolve) => { self._resolveHeaders = resolve; });
    }
    _emitClose() { if (!this._closed) { this._closed = true; this.emit("close"); } }
    _flushHeaders() { if (this._headersSent) return; this._headersSent = true; this._resolveHeaders(); }
    _toBytes(chunk) {
      if (typeof chunk === "string") return __httpEnc.encode(chunk);
      if (chunk instanceof Uint8Array) return chunk;
      if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
      if (chunk && chunk.buffer instanceof ArrayBuffer && typeof chunk.byteLength === "number") {
        return new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
      }
      return __httpEnc.encode(String(chunk));
    }
    writeHead(code, reasonOrHeaders, maybeHeaders) {
      this.statusCode = code;
      let hdrs = maybeHeaders;
      if (reasonOrHeaders && typeof reasonOrHeaders === "object") hdrs = reasonOrHeaders;
      else if (typeof reasonOrHeaders === "string") this.statusMessage = reasonOrHeaders;
      if (hdrs) {
        if (Array.isArray(hdrs)) { for (let i = 0; i + 1 < hdrs.length; i += 2) this.headers[String(hdrs[i]).toLowerCase()] = hdrs[i + 1]; }
        else for (const k of Object.keys(hdrs)) this.headers[k.toLowerCase()] = hdrs[k];
      }
      this._flushHeaders();
      return this;
    }
    flushHeaders() { this._flushHeaders(); return this; }
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
    getHeader(k) { return this.headers[String(k).toLowerCase()]; }
    getHeaders() { return { ...this.headers }; }
    hasHeader(k) { return Object.prototype.hasOwnProperty.call(this.headers, String(k).toLowerCase()); }
    removeHeader(k) { delete this.headers[String(k).toLowerCase()]; }
    write(chunk, enc, cb) {
      if (typeof enc === "function") { cb = enc; }
      this._flushHeaders();
      if (this._ended || this._destroyed) { if (cb) queueMicrotask(cb); return false; }
      if (chunk != null && !(typeof chunk === "string" && chunk.length === 0)) {
        try { this._controller.enqueue(this._toBytes(chunk)); }
        catch { this._destroyed = true; if (cb) queueMicrotask(cb); return false; }
      }
      if (cb) queueMicrotask(cb);
      const ds = this._controller ? this._controller.desiredSize : null;
      const ok = ds === null || ds > 0;
      if (!ok) this._needDrain = true;
      return ok;
    }
    end(data, enc, cb) {
      if (typeof data === "function") { cb = data; data = undefined; }
      else if (typeof enc === "function") { cb = enc; }
      if (data != null) this.write(data);
      this._flushHeaders();
      if (!this._ended) {
        this._ended = true;
        if (!this._destroyed) { try { this._controller.close(); } catch {} }
        this.emit("finish");
        this._emitClose();
      }
      if (cb) queueMicrotask(cb);
      return this;
    }
    destroy(err) {
      if (this._destroyed) return this;
      this._destroyed = true;
      if (!this._ended) { this._ended = true; try { this._controller.error(err || new Error("aborted")); } catch {} }
      if (err) this.emit("error", err);
      this._emitClose();
      return this;
    }
    get headersSent() { return this._headersSent; }
    get writableEnded() { return this._ended; }
    get writableFinished() { return this._ended; }
    get destroyed() { return this._destroyed; }
  }
  // Node's IncomingMessage is a Readable whose chunks are Buffers, and every
  // idiom for reading a request body depends on both halves of that: the
  // canonical \`req.on('data', c => chunks.push(c))\` + \`Buffer.concat(chunks)\`
  // brand-checks each chunk as a TypedArray, \`for await (const c of req)\` and
  // \`req.pipe()\` need the stream contract, and a Readable is what holds the
  // bytes until a consumer actually attaches instead of emitting them into
  // the void. The body arrives here as bytes and is pushed on demand.
  class IncomingMessage extends __streamMod.Readable {
    constructor(u, m, h, body) {
      super();
      this.url = u || "/";
      this.method = m || "GET";
      this.headers = h || {};
      this.httpVersion = "1.1";
      this._body = body && body.byteLength > 0 ? body : null;
    }
    _read() {
      const body = this._body;
      this._body = null;
      if (body) this.push(__BufferMod.from(body));
      this.push(null);
    }
  }
  class Server extends __eventsMod {
    constructor(handler) { super(); this._parkedRequests = []; if (handler) this.on("request", handler); this._port = 0; this._host = undefined; this._listening = false; }
    // effect-platform (opencode serve) binds via listen() FIRST and attaches
    // its "request" handler only after the HTTP-app layer is built. A request
    // emitted into zero listeners is silently lost — the ServerResponse never
    // gets headers and the dispatcher's header timeout fires. Park requests
    // that arrive in that window and flush them when the handler attaches.
    on(n, fn) {
      super.on(n, fn);
      if (n === "request") this._flushParkedRequests();
      return this;
    }
    prependListener(n, fn) {
      super.prependListener(n, fn);
      if (n === "request") this._flushParkedRequests();
      return this;
    }
    _flushParkedRequests() {
      if (!this._parkedRequests || this._parkedRequests.length === 0) return;
      const parked = this._parkedRequests.splice(0);
      for (const dispatch of parked) queueMicrotask(dispatch);
    }
    // Node's listen has several overloads; the two we honour are
    // listen(options[, cb]) — options = { port, host, path, backlog, ... } —
    // and listen([port[, host[, backlog]]][, cb]). opencode's server adaptor
    // binds via the OPTIONS-OBJECT form (server.listen({ host, port }, cb)), so
    // we read port/host off the object; a bare positional port is the classic
    // form. The port is normalized to a number (number|string) so the ACTUAL
    // listened port is what lands in the registry + SUPERVISOR.registerPort.
    listen(...args) {
      let portArg, host, cb;
      const first = args[0];
      if (first !== null && typeof first === "object") {
        portArg = first.port;
        host = first.host;
        if (typeof args[1] === "function") cb = args[1];
      } else {
        portArg = first;
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (typeof a === "function") { cb = a; break; }
          if (typeof a === "string") host = a;
        }
      }
      const numPort = typeof portArg === "string" ? parseInt(portArg, 10) : portArg;
      this._port = Number.isFinite(numPort) ? numPort : 0;
      this._host = host;
      this._listening = true;
      globalThis.__portRegistry.set(this._port, this);
      try { if (__supervisor && typeof __supervisor.registerPort === "function") { Promise.resolve(__supervisor.registerPort(this._port)).catch(() => {}); } } catch {}
      if (cb) queueMicrotask(cb);
      this.emit("listening");
      return this;
    }
    close(cb) { this._listening = false; globalThis.__portRegistry.delete(this._port); try { if (__supervisor && typeof __supervisor.unregisterPort === "function") { Promise.resolve(__supervisor.unregisterPort(this._port)).catch(() => {}); } } catch {} if (cb) cb(); this.emit("close"); }
    get listening() { return this._listening; }
    // X.5-M (M-1): http.Server.setTimeout no-op for fastify.
    // fastify's lib/server.js calls server.setTimeout(connectionTimeout)
    // immediately after createServer(). Pre-X5M the Server class lacked
    // this method → "TypeError: server.setTimeout is not a function".
    // Mirror the net.Socket.setTimeout pattern at the bottom of this file
    // (same builtins/net IIFE): no-op + chainable. Idle timeouts have no
    // facet-side meaning (we don't own outbound TCP), but we honour the
    // 1-arg callback form so listeners that emit on 'timeout' still run.
    setTimeout(ms, cb) { if (typeof ms === "function") { cb = ms; } if (cb) this.on("timeout", cb); return this; }
    setKeepAlive() { return this; }
    address() { return { address: this._host || "0.0.0.0", port: this._port, family: "IPv4" }; }
    _handleRequest(u, m, h, b) {
      const req = new IncomingMessage(u, m, h, b);
      const res = new ServerResponse();
      // Node drains a request body the handler never reads, which is what lets
      // an 'end'-only listener fire. Nudge the stream once the handler has had
      // its turn, so a handler that DID attach a consumer owns the bytes and
      // one that did not still sees the request complete.
      const dispatch = () => {
        this.emit("request", req, res);
        if (req.readableFlowing !== true) req.resume();
      };
      if (this.listenerCount("request") === 0) this._parkedRequests.push(dispatch);
      else dispatch();
      return res;
    }
  }
  function createServer(o, h) { if (typeof o === "function") { h = o; } return new Server(h); }
  // Shared streaming HTTP dispatch for every facet server (generic node
  // long-running, opencode serve, …). A request forwarded by the port registry
  // (loopback OR external /port/<n>, stamped X-Nimbus-Port) is replayed through
  // the in-facet server's _handleRequest, and the response is returned as a
  // streaming host Response the moment its headers are known — never buffered.
  // This is what lets an SSE / chunked body flow live across the RPC boundary
  // (the registry + loopback both return this Response as-is). The single
  // source of truth for facet HTTP dispatch: manager.ts (__nimbusDispatchHttp)
  // and the opencode runner (__ocDispatchHttp) both delegate here.
  globalThis.__nimbusServeHttp = async function __nimbusServeHttp(request) {
    const ports = globalThis.__portRegistry;
    const hinted = Number(request.headers.get("X-Nimbus-Port") || 0);
    const server = ports && (ports.get(hinted) || ports.values().next().value);
    if (!server || typeof server._handleRequest !== "function") {
      return new __hostResponse("Nimbus: no HTTP server is listening in this process", { status: 502 });
    }
    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    // Bytes, not text: a UTF-8 decode corrupts every binary upload, and the
    // decoded string is not the TypedArray receiver Buffer methods require.
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = new Uint8Array(await request.arrayBuffer());
    }
    const res = server._handleRequest(url.pathname + url.search, request.method, headers, body);
    // Return once headers are known. A handler that never sends headers is
    // bounded by a header timeout (NOT a body-finish cap) so a hung handler
    // can't wedge the request, while a live stream that never "finishes" flows.
    // The timeout defaults to 30s; tests pin it low via __nimbusHttpHeaderTimeoutMs.
    if (!res._headersSent) {
      const headerTimeoutMs = Number(globalThis.__nimbusHttpHeaderTimeoutMs) || 30000;
      let timer;
      const timedOut = await Promise.race([
        res._headersReady.then(() => false),
        new Promise((resolve) => { timer = setTimeout(() => resolve(true), headerTimeoutMs); }),
      ]);
      clearTimeout(timer);
      if (timedOut && !res._headersSent) {
        try { res.destroy(); } catch {}
        return new __hostResponse("Nimbus: HTTP handler sent no response headers in time", { status: 504 });
      }
    }
    return new __hostResponse(res._stream, { status: res.statusCode || 200, headers: res.headers || {} });
  };
  return { createServer, Server, IncomingMessage, ServerResponse, Agent: class {}, STATUS_CODES: {}, METHODS: ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"], request: () => { throw new Error("Use fetch()"); }, get: () => { throw new Error("Use fetch()"); } };
})();
builtins.https = (() => {
  const hm = builtins.http;
  return {
    createServer: hm.createServer, Server: hm.Server, Agent: class {}, globalAgent: {},
    request: (url, opts, cb) => { if (typeof url === "string") url = new URL(url); if (typeof opts === "function") { cb = opts; opts = {}; } const req = new __eventsMod(); req.end = (body) => { fetch(url.href || url, { method: opts?.method || "GET", headers: opts?.headers, body }).then(async (resp) => { const res = new __eventsMod(); res.statusCode = resp.status; res.headers = Object.fromEntries(resp.headers); if (cb) cb(res); const text = await resp.text(); res.emit("data", text); res.emit("end"); }).catch((e) => req.emit("error", e)); }; req.write = () => req; req.on = (...a) => { __eventsMod.prototype.on.apply(req, a); return req; }; return req; },
    get: (url, opts, cb) => { const req = builtins.https.request(url, opts, cb); req.end(); return req; },
  };
})();
// W3 — net.Socket honest-error mode.
//
// Pre-W3 behaviour: \`new net.Socket().connect(443, 'example.com')\`
// immediately fired the 'connect' event without any I/O — silent lie.
// Anything attempting raw TCP from a facet (pg, mysql2, redis wire
// protocols) thought it succeeded but produced no I/O.
//
// W3 behaviour: connect() emits 'error' with code
// ERR_NET_SOCKET_NOT_AVAILABLE so callers fail loud.  W8 will route
// raw outbound TCP through supervisor RPC.
builtins.net = (() => {
  class Socket extends __eventsMod {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      // Honest: we cannot send/receive bytes from a facet today.
      this.writable = false;
      this.readable = false;
      this.remoteAddress = null;
      this.remotePort = null;
      this.localAddress = "0.0.0.0";
      this.localPort = 0;
    }
    connect(port, host, cb) {
      if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
      this.remoteAddress = host || "127.0.0.1";
      this.remotePort = port;
      const self = this;
      queueMicrotask(() => {
        const err = new Error(
          "net.Socket: outbound TCP from Nimbus facet not yet supported. " +
          "Use fetch() for HTTP/HTTPS. (W8 will route via supervisor RPC.)"
        );
        err.code = "ERR_NET_SOCKET_NOT_AVAILABLE";
        self.destroyed = true;
        self.emit("error", err);
        if (cb) cb(err);
      });
      return this;
    }
    write() { return false; }
    end(data, enc, cb) {
      if (typeof data === "function") { cb = data; data = undefined; }
      const self = this;
      queueMicrotask(() => { self.emit("end"); self.emit("close"); if (cb) cb(); });
      return this;
    }
    destroy(err) { this.destroyed = true; if (err) this.emit("error", err); this.emit("close"); return this; }
    setEncoding() { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return null; }
  }
  return {
    Socket,
    Server: builtins.http.Server,
    createServer: (o, h) => { if (typeof o === "function") { h = o; } return builtins.http.createServer(h); },
    createConnection: (p, h, cb) => new Socket().connect(p, h, cb),
    connect: (p, h, cb) => new Socket().connect(p, h, cb),
    isIP: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s) ? 4 : 0,
    isIPv4: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s),
    isIPv6: () => false,
  };
})();
// dgram (UDP) — workerd has no UDP sockets. Some packages require it at
// module init (dns2's server/udp.js, bundled by create-cloudflare) but
// never open a UDP server during scaffolding. Expose the API surface so
// module init succeeds; bind/send surface an honest error only if used.
builtins.dgram = (() => {
  class Socket extends __eventsMod {
    constructor(opts) { super(); this.type = (opts && opts.type) || (typeof opts === "string" ? opts : "udp4"); }
    bind(_port, _addr, cb) {
      const err = new Error("UDP sockets are not supported in this runtime");
      err.code = "ERR_SOCKET_BAD_PORT";
      queueMicrotask(() => this.emit("error", err));
      if (typeof cb === "function") queueMicrotask(cb);
      return this;
    }
    send(_msg, ...args) {
      const cb = args.find((a) => typeof a === "function");
      const err = new Error("UDP sockets are not supported in this runtime");
      if (cb) queueMicrotask(() => cb(err)); else queueMicrotask(() => this.emit("error", err));
    }
    address() { return { address: "0.0.0.0", port: 0, family: this.type === "udp6" ? "IPv6" : "IPv4" }; }
    close(cb) { queueMicrotask(() => { this.emit("close"); if (typeof cb === "function") cb(); }); return this; }
    setBroadcast() {} setTTL() {} setMulticastTTL() {} addMembership() {} dropMembership() {}
    ref() { return this; } unref() { return this; }
  }
  return { Socket, createSocket: (opts, cb) => { const s = new Socket(opts); if (typeof cb === "function") s.on("message", cb); return s; } };
})();
builtins.dns = (() => {
  async function _doh(h, t) { try { const r = await fetch("https://cloudflare-dns.com/dns-query?name="+encodeURIComponent(h)+"&type="+(t||"A"),{headers:{"Accept":"application/dns-json"}}); const d = await r.json(); return (d.Answer||[]).map(a=>a.data).filter(Boolean); } catch { return []; } }
  return { resolve: (h,t,cb) => { if (typeof t==="function"){cb=t;t="A";} _doh(h,t).then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)); }, resolve4: (h,cb) => _doh(h,"A").then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)), resolve6: (h,cb) => _doh(h,"AAAA").then(a=>cb(null,a)).catch(e=>cb(e)), lookup: (h,o,cb) => { if(typeof o==="function"){cb=o;} if(h==="localhost"){cb(null,"127.0.0.1",4);return;} _doh(h,"A").then(a=>cb(null,a[0]||"127.0.0.1",4)).catch(e=>cb(e)); }, promises: { resolve: (h,t) => _doh(h,t||"A"), resolve4: (h) => _doh(h,"A"), lookup: async(h) => { if(h==="localhost") return {address:"127.0.0.1",family:4}; const a=await _doh(h,"A"); return {address:a[0]||"127.0.0.1",family:4}; } } };
})();
builtins.tty = {
  isatty: () => __nimbusAttachedTty,
  ReadStream: class extends __streamMod.Readable {
    constructor() { super(); this.isTTY = __nimbusAttachedTty; this.isRaw = false; }
    setRawMode(mode) { this.isRaw = mode !== false; return this; }
  },
  WriteStream: class extends __streamMod.Writable {
    constructor() { super(); this.isTTY = __nimbusAttachedTty; }
    get columns() { return __nimbusTtyColumns; }
    get rows() { return __nimbusTtyRows; }
    getColorDepth() { return __nimbusAttachedTty ? 24 : 1; }
    hasColors() { return __nimbusAttachedTty; }
    clearLine(dir, cb) { return __nimbusClearLine(this, dir, cb); }
    clearScreenDown(cb) { return __nimbusClearScreenDown(this, cb); }
    cursorTo(x, y, cb) { return __nimbusCursorTo(this, x, y, cb); }
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(this, dx, dy, cb); }
    getWindowSize() { return [this.columns, this.rows]; }
  },
};
// builtinModules is the node CORE list. The table also carries the npm
// packages the facet provides itself (FACET_PROVIDED_PACKAGES), which are not
// core and must not be reported as such — a package that sniffs this list
// would otherwise conclude e.g. undici ships with node.
const __nimbusFacetProvidedPackages = new Set(${FACET_PROVIDED_PACKAGES_LITERAL});
	builtins.module = { get builtinModules() { return Object.keys(builtins).filter((n) => !__nimbusFacetProvidedPackages.has(n)); }, createRequire: (specifier) => __makeRequire(__requireBaseDir(specifier)), _resolveFilename: (id) => id, _cache: {} };
// Bind to globalThis: workerd's timer globals throw "Illegal invocation"
// when called with a receiver other than globalThis (i.e. as
// timers.setInterval(...)), which clack's spinner — used by
// create-cloudflare — triggers.
builtins.timers = { setTimeout: globalThis.setTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), setImmediate: (fn,...a) => globalThis.setTimeout(fn,0,...a), clearImmediate: globalThis.clearTimeout.bind(globalThis) };
builtins.zlib = (() => {
  function _c(d,a) { const i=typeof d==="string"?new TextEncoder().encode(d):d; return new Response(new Blob([i]).stream().pipeThrough(new CompressionStream(a))).arrayBuffer().then(ab=>__BufferMod.from(new Uint8Array(ab))); }
  function _d(d,a) { const i=d instanceof Uint8Array?d:new Uint8Array(d); return new Response(new Blob([i]).stream().pipeThrough(new DecompressionStream(a))).arrayBuffer().then(ab=>__BufferMod.from(new Uint8Array(ab))); }
  return { gzip:(d,o,cb)=>{if(typeof o==="function")cb=o;_c(d,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}, gunzip:(d,o,cb)=>{if(typeof o==="function")cb=o;_d(d,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}, deflate:(d,o,cb)=>{if(typeof o==="function")cb=o;_c(d,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}, inflate:(d,o,cb)=>{if(typeof o==="function")cb=o;_d(d,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}, gzipSync:()=>{throw new Error("use async gzip()");}, gunzipSync:()=>{throw new Error("use async gunzip()");}, createGzip:()=>new __streamMod.Transform({transform(c,e,cb){_c(c,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}}), createGunzip:()=>new __streamMod.Transform({transform(c,e,cb){_d(c,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}}), createDeflate:()=>new __streamMod.Transform({transform(c,e,cb){_c(c,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}}), createInflate:()=>new __streamMod.Transform({transform(c,e,cb){_d(c,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}}), constants:{Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1} };
})();
builtins.readline = (() => {
  function emitKeypressEvents(stream) {
    if (!stream || stream.__nimbusKeypressEvents) return;
    stream.__nimbusKeypressEvents = true;
    stream.on("data", (chunk) => {
      const text = chunk instanceof Uint8Array
        ? new TextDecoder("utf-8").decode(chunk)
        : String(chunk);
      for (let i = 0; i < text.length; i++) {
        let str = text[i];
        let key = { sequence: str, name: str, ctrl: false, meta: false, shift: false };
        if (str === "\\x1b" && text[i + 1] === "[") {
          const code = text[i + 2];
          if (code === "A" || code === "B" || code === "C" || code === "D") {
            i += 2;
            str = "\\x1b[" + code;
            key = {
              sequence: str,
              name: code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : "left",
              ctrl: false,
              meta: false,
              shift: false,
            };
          }
        } else if (str === "\\x03") {
          key = { sequence: str, name: "c", ctrl: true, meta: false, shift: false };
        } else if (str === "\\x7f" || str === "\\b") {
          key = { sequence: str, name: "backspace", ctrl: false, meta: false, shift: false };
        } else if (str === "\\r" || str === "\\n") {
          key = { sequence: str, name: "enter", ctrl: false, meta: false, shift: false };
        }
        stream.emit("keypress", str, key);
      }
    });
  }
  function createInterface(opts) {
    const inp = typeof opts === "object" && opts ? opts : { input: opts };
    const input = inp.input || __processMod.stdin;
    const output = inp.output || __processMod.stdout;
    const rl = new __eventsMod();
    let closed = false;
    let promptText = inp.prompt || "> ";
    let buffer = "";
    const pending = [];
    const queued = [];
    function pushLine(line) {
      if (closed) return;
      rl.emit("line", line);
      const waiter = pending.shift();
      if (waiter) waiter({ value: line, done: false });
      else queued.push(line);
    }
    function handleInputText(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\r" || ch === "\\n") {
          if (ch === "\\r" && text[i + 1] === "\\n") i++;
          const line = buffer;
          buffer = "";
          pushLine(line);
          continue;
        }
        if (ch === "\\x7f" || ch === "\\b") {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        if (ch === "\\x03") {
          rl.emit("SIGINT");
          continue;
        }
        buffer += ch;
      }
    }
    function onData(chunk) {
      const text = chunk instanceof Uint8Array
        ? new TextDecoder("utf-8").decode(chunk)
        : String(chunk);
      handleInputText(text);
    }
    function onEnd() {
      if (buffer) {
        const tail = buffer;
        buffer = "";
        pushLine(tail);
      }
      rl.close();
    }
    try {
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      if (typeof input.resume === "function") input.resume();
    } catch {}
    rl.close = () => {
      if (closed) return;
      closed = true;
      try { input.removeListener?.("data", onData); } catch {}
      try { input.removeListener?.("end", onEnd); } catch {}
      try { input.removeListener?.("close", onEnd); } catch {}
      for (const waiter of pending.splice(0)) waiter({ value: undefined, done: true });
      rl.emit("close");
    };
    rl.question = (q, o, cb) => {
      if (typeof o === "function") cb = o;
      if (output && typeof output.write === "function") output.write(q);
      const onLine = (line) => {
        rl.removeListener("line", onLine);
        if (typeof cb === "function") cb(line);
      };
      rl.on("line", onLine);
    };
    rl.prompt = () => { if (output && typeof output.write === "function") output.write(promptText); };
    rl.setPrompt = (p) => { promptText = String(p); return rl; };
    rl.getPrompt = () => promptText;
    rl.pause = () => { try { input.pause?.(); } catch {} return rl; };
    rl.resume = () => { try { input.resume?.(); } catch {} return rl; };
    rl.write = (data) => { onData(data); return rl; };
    rl[Symbol.asyncIterator] = async function*() {
      while (!closed) {
        if (queued.length > 0) {
          yield queued.shift();
          continue;
        }
        const next = await new Promise((resolve) => pending.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    };
    return rl;
  }
  function clearLine(stream, dir, cb) { return __nimbusClearLine(stream, dir, cb); }
  function clearScreenDown(stream, cb) { return __nimbusClearScreenDown(stream, cb); }
  function cursorTo(stream, x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); }
  function moveCursor(stream, dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); }
  const promises = {
    createInterface(opts) {
      const iface = createInterface(opts);
      const originalQuestion = iface.question.bind(iface);
      iface.question = (query, options) => new Promise((resolve) => {
        void options;
        originalQuestion(query, (answer) => resolve(answer));
      });
      return iface;
    },
  };
  return {
    createInterface,
    Interface: __eventsMod,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    emitKeypressEvents,
    promises,
  };
})();
builtins.perf_hooks = { performance: globalThis.performance || { now:()=>Date.now(), mark:()=>{}, measure:()=>{}, getEntriesByName:()=>[], clearMarks:()=>{}, clearMeasures:()=>{} } };
// X.5-Z5 §3 follow-on: minimal v8 stub for jiti (used transitively by
// @tailwindcss/vite). jiti reads v8.startupSnapshot.isBuildingSnapshot()
// to decide whether to skip JIT compilation; workerd never builds v8
// snapshots, so 'false' is the correct answer. Other v8 introspection
// APIs (cachedDataVersionTag, getHeapStatistics, etc.) return inert
// values that satisfy the shape contract without offering real data.
builtins.v8 = {
  startupSnapshot: {
    isBuildingSnapshot: () => false,
    addSerializeCallback: () => {},
    addDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
    setDeserializeData: () => {},
  },
  cachedDataVersionTag: () => 0,
  getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  setFlagsFromString: () => {},
  serialize: (v) => __BufferMod.from(JSON.stringify(v)),
  deserialize: (b) => JSON.parse(__BufferMod.from(b).toString()),
  writeHeapSnapshot: () => "",
};
const __workerThreadsUntransferable = new WeakSet();
const __workerThreadsUncloneable = new WeakSet();
builtins.worker_threads = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
  Worker: class extends __eventsMod {
    constructor() { super(); }
    terminate() { return Promise.resolve(0); }
    postMessage() {}
  },
  MessageChannel: globalThis.MessageChannel,
  MessagePort: globalThis.MessagePort,
  BroadcastChannel: globalThis.BroadcastChannel,
  receiveMessageOnPort: () => undefined,
  markAsUntransferable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUntransferable.add(value);
    }
  },
  isMarkedAsUntransferable(value) {
    return !!(value && (typeof value === "object" || typeof value === "function") &&
      __workerThreadsUntransferable.has(value));
  },
  markAsUncloneable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUncloneable.add(value);
    }
  },
};

// ── W3 additions: builtins forwarded/shimmed for axios/jsdom/fastify/
//                 puppeteer-core/ts-node + Node 20 surface completeness.
builtins.vm = __vmMod;
builtins.http2 = __http2Mod;
builtins.repl = __replMod;
builtins.diagnostics_channel = __diagChannelMod;
builtins.tls = __tlsMod;
builtins.async_hooks = __asyncHooksMod;
builtins.inspector = __inspectorMod;
// node:inspector/promises — the promisified Session surface. workerd
// exposes it natively; fall back to a Promise-shaped wrapper otherwise.
builtins["inspector/promises"] = (() => {
  const real = (typeof __real_inspector !== 'undefined') ? (__real_inspector.default ?? __real_inspector) : null;
  if (real && real.promises && typeof real.promises.Session === 'function') return real.promises;
  return {
    Session: class { connect() {} disconnect() {} post(_m, _p) { return Promise.resolve({}); } on() { return this; } },
    console: __inspectorMod.console, url: __inspectorMod.url,
    open: __inspectorMod.open, close: __inspectorMod.close, waitForDebugger: __inspectorMod.waitForDebugger,
  };
})();
builtins["node:inspector/promises"] = builtins["inspector/promises"];
// Subpath-style require() — the shim's __requireFrom strips a 'node:'
// prefix to look up bare names, so we expose both bare and prefixed
// keys explicitly for grep-friendliness and to handle any future call
// site that bypasses the strip path.
builtins["fs/promises"] = __fsMod.promises;
builtins["node:fs/promises"] = __fsMod.promises;
builtins["readline/promises"] = builtins.readline.promises;
builtins["node:readline/promises"] = builtins.readline.promises;

// stream/promises — promise-wrapped versions of pipeline + finished.
// Surfaced by sv (svelte CLI, the new replacement for create-svelte
// v6.x) at /tmp/.npx-cache/node_modules/sv/dist/bin.mjs — it imports
// 'node:stream/promises' for promise-style pipeline composition.
// signal-exit, gulp's vinyl streams, tar-fs, and many node-only build
// scripts use this subpath too.
//
// Real Node's stream/promises wraps the callback-style pipeline/
// finished from 'stream' into Promise-returning variants. The
// __streamMod above already ships pipeline() and finished() in their
// callback form (src/runtime/streams.ts:339/361); the promise wrapper
// is a thin shim that returns a Promise resolving on success +
// rejecting on the callback's err arg.
builtins["stream/promises"] = (() => {
  const promisifyOp = (op) => (...args) => new Promise((res, rej) => {
    // op signature: op(...streamsOrTarget, callback)
    op(...args, (err, value) => {
      if (err) rej(err);
      else res(value);
    });
  });
  return {
    pipeline: promisifyOp(__streamMod.pipeline),
    finished: promisifyOp(__streamMod.finished),
  };
})();
builtins["node:stream/promises"] = builtins["stream/promises"];

// stream/consumers — Promise-returning helpers that drain a Readable.
// Node 16.7+. Used by undici, tar-stream, multiple "consume the whole
// body" patterns. Each helper takes a readable stream and returns a
// Promise<Buffer | string | object | array>.
builtins["stream/consumers"] = (() => {
  function readAll(stream) {
    return new Promise((res, rej) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => res(chunks));
      stream.on('error', rej);
    });
  }
  return {
    buffer: async (stream) => {
      const chunks = await readAll(stream);
      // Concat Buffers / Uint8Arrays / strings.
      if (chunks.length === 0) return __BufferMod.alloc(0);
      if (typeof chunks[0] === 'string') {
        return __BufferMod.from(chunks.join(''));
      }
      return __BufferMod.concat(chunks);
    },
    text: async (stream) => {
      const chunks = await readAll(stream);
      if (chunks.length === 0) return '';
      if (typeof chunks[0] === 'string') return chunks.join('');
      return __BufferMod.concat(chunks).toString('utf8');
    },
    json: async (stream) => {
      const chunks = await readAll(stream);
      const text = typeof chunks[0] === 'string'
        ? chunks.join('')
        : __BufferMod.concat(chunks).toString('utf8');
      return JSON.parse(text);
    },
    arrayBuffer: async (stream) => {
      const chunks = await readAll(stream);
      const buf = __BufferMod.concat(chunks);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    blob: async () => {
      throw new Error('stream/consumers.blob not implemented');
    },
  };
})();
builtins["node:stream/consumers"] = builtins["stream/consumers"];

// stream/web — Web Streams API namespace. Node 17+. Userland CLIs
// occasionally pull \`ReadableStream\` from here for portability. The
// platform exposes these globals already; we just re-export them.
builtins["stream/web"] = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
  ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
  CountQueuingStrategy: globalThis.CountQueuingStrategy,
  ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
  ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
  WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
};
builtins["node:stream/web"] = builtins["stream/web"];
builtins["timers/promises"] = (() => {
  return {
    setTimeout: (ms, value) => new Promise(res => setTimeout(() => res(value), ms || 0)),
    setImmediate: (value) => new Promise(res => queueMicrotask(() => res(value))),
    setInterval: async function* (ms, value) {
      while (true) { await new Promise(r => setTimeout(r, ms || 0)); yield value; }
    },
  };
})();
builtins["node:timers/promises"] = builtins["timers/promises"];

// X.5-M (M-2): dns/promises subpath registration for redis.
// @redis/client/dist/lib/client does require('dns/promises') to do
// hostname → IP resolution. Pre-fix the only exposure was
// builtins.dns.promises (an object property of the parent dns shim);
// __requireFrom matches keys exactly, so 'dns/promises' missed.
// Mirror the timers/promises pattern above. builtins.dns.promises is
// already a complete object (DoH-backed lookup/resolve/resolve4) —
// re-exposing it as a subpath builtin is a 2-line registration.
builtins["dns/promises"] = builtins.dns.promises;
builtins["node:dns/promises"] = builtins["dns/promises"];

// X.5-Q: util/types subpath registration for jsdom's bundled undici.
// undici@7.x calls require('node:util/types').{isUint8Array,isArrayBuffer}
// directly from lib/web/fetch/util.js + body.js + websocket/websocket.js.
// __requireFrom matches keys exactly; pre-fix the only exposure was
// builtins.util.types (object property of parent util shim), so the
// subpath missed. Mirror the dns/promises (M-2) pattern. The
// builtins.util.types object is the X.5-Q-expanded 17-method polyfill
// (see line 707), sufficient for undici@7.25.0 + undici@8.2.0.
builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];

// undici (npm, not node core) — Nimbus provides it instead of node_modules.
// __requireFrom checks this table BEFORE resolving, so this wins over any
// installed copy, and esbuild lowers every ESM import of "undici" into the
// same require. Rationale for shadowing it at all: runtime/undici-shim.ts.
// No "node:undici" alias — it is not a node builtin, and the prefetch walker
// skips it via the same FACET_PROVIDED_PACKAGES list.
builtins.undici = __undiciMod;

// ═══════════════════════════════════════════════════════════════════════
// ──  require() — full Node.js module resolution ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __moduleCache = new Map();

/**
 * Direct VFS bundle access for module resolution.
 * These bypass the fs shim's _resolve() (which prepends cwd)
 * because resolver paths are already in VFS format (no leading /).
 */
function __readFileOr(path, fallback) {
  const k = path.replace(/^\\/+/, "");
  // binary-fs: bundle/writes cells may be Uint8Array; module-resolution
  // callers (package.json parse, source compile) want strings. Decode
  // bytes lossily — same as Node's Buffer.toString('utf8').
  function _coerceStr(v) {
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array) {
      try { return new TextDecoder().decode(v); } catch { return fallback; }
    }
    return fallback;
  }
  if (__vfsBundle && k in __vfsBundle) return _coerceStr(__vfsBundle[k]);
  if (__vfsWrites && k in __vfsWrites) return _coerceStr(__vfsWrites[k]);
  // Fallback: try through fs shim (handles _resolve for user-facing paths)
  try { return __fsMod.readFileSync("/" + k, "utf8"); } catch { return fallback; }
}
function __fileExists(path) {
  const k = path.replace(/^\\/+/, "");
  if (__vfsBundle && k in __vfsBundle) return true;
  if (__vfsWrites && k in __vfsWrites) return true;
  if (__vfsDirs && k in __vfsDirs) return true;
  // Consult the uncapped manifest (directory shape) so resolution sees
  // installed files whose content was excluded from the bounded snapshot
  // (e.g. web-streams-polyfill's ponyfill/package.json, reached via a
  // parent-relative main). Mirrors existsSync's manifest probe.
  if (__vfsManifest) {
    if (k in __vfsManifest) return true;
    const slash = k.lastIndexOf("/");
    const parent = slash >= 0 ? k.slice(0, slash) : "";
    const name = slash >= 0 ? k.slice(slash + 1) : k;
    const sib = __vfsManifest[parent];
    if (sib && sib.indexOf(name) !== -1) return true;
  }
  // Check for directory by looking for any key with this prefix
  if (__vfsBundle && __residentAnyUnder(k + "/")) return true;
  return false;
}
// W3.5 Fix A: strict-file membership probe. __fileExists also returns true for
// directories (it has to — __resolveNodeModule and __resolveImportsField call
// it to check whether a node_modules/<pkg> directory exists). __resolveFile's
// empty-extension probe needs the inverse: "is this an actual file?" — so the
// loop falls through to /index.js when "base" is a directory rather than
// short-circuiting and returning the directory path (which __loadModule then
// can't read, throwing "Cannot read module: <dir>"). See W3 retro §S3 for
// the fastify ret/dist/types failure.
function __pathIsFile(path) {
  const k = path.replace(/^\\/+/, "");
  if (__vfsBundle && k in __vfsBundle) return true;
  if (__vfsWrites && k in __vfsWrites) return true;
  // Consult the manifest as a strict-file probe: a name listed in its
  // parent's manifest entry is a file (directories are manifest KEYS).
  // This lets resolution find files whose content was excluded from the
  // bounded snapshot without re-introducing the directory short-circuit
  // (__vfsManifest[k] being a directory key is deliberately NOT matched).
  if (__vfsManifest) {
    const slash = k.lastIndexOf("/");
    const parent = slash >= 0 ? k.slice(0, slash) : "";
    const name = slash >= 0 ? k.slice(slash + 1) : k;
    const sib = __vfsManifest[parent];
    if (sib && sib.indexOf(name) !== -1 && !(k in __vfsManifest)) return true;
  }
  // Last resort: the full fs view (live SQLite VFS) for paths outside the
  // bounded snapshot/manifest entirely — e.g. the /tmp/.npx-cache tree,
  // which the project snapshot never covers. stat-as-file only.
  try { const st = __fsMod.statSync("/" + k); if (st && st.isFile && st.isFile()) return true; } catch {}
  // Deliberately does NOT consult __vfsDirs nor do the prefix scan.
  return false;
}
function __resolveFile(base) {
  // Mirrors Node's LOAD_AS_FILE + LOAD_AS_DIRECTORY (require_2 spec):
  //
  //   1. LOAD_AS_FILE -- try base, base.js, base.mjs, base.cjs, base.json
  //      as a regular file. The empty-ext probe uses __pathIsFile (not
  //      __fileExists) so a directory at "base" does NOT short-circuit
  //      here; it falls through to the LOAD_AS_DIRECTORY block below.
  //      See W3.5-plan.md §1 Failure 1.
  //
  //   2. LOAD_AS_DIRECTORY -- if "base" resolves to a directory:
  //      a. If <base>/package.json has a "main" field -- recurse on it.
  //         (Bug class C, audit 2026-05-11: this branch was missing,
  //          so require("./mod") where mod/package.json#main="entry.js"
  //          and no mod/index.js -- "Cannot find module ./mod".)
  //      b. Else fall through to <base>/index.{js,cjs,mjs,json}.
  //
  // Must mirror the install-time pre-bundler at require-resolver.ts:
  // resolveFile so prefetch + runtime agree on which file a given
  // require() will load.
  const fileExts = ["", ".js", ".mjs", ".cjs", ".json"];
  for (const ext of fileExts) {
    const cand = base + ext;
    if (ext === "") {
      if (__pathIsFile(cand)) return cand;
      continue;
    }
    if (__fileExists(cand)) return cand;
  }
  // LOAD_AS_DIRECTORY: prefer package.json#main over index.*
  const pkgJsonPath = base.replace(/\\/+$/, "") + "/package.json";
  if (__pathIsFile(pkgJsonPath)) {
    let pkg = null;
    try { pkg = JSON.parse(__readFileOr(pkgJsonPath, "null")); } catch { /* fall through */ }
    if (pkg && typeof pkg.main === "string" && pkg.main.length > 0) {
      const mainStripped = pkg.main.replace(/^\\.\\/+/, "").replace(/^\\/+/, "");
      // Normalize so a parent-relative main (e.g. web-streams-polyfill's
      // ponyfill/package.json declaring main "../dist/ponyfill") collapses
      // its ".." segments instead of probing a literal "dir/../dist" path
      // that __fileExists never matches.
      const mainBase = __pathMod.normalize(base.replace(/\\/+$/, "") + "/" + mainStripped).replace(/^\\/+/, "");
      // Recurse: main itself may be a directory (e.g. main: "lib") or
      // a file without extension. Guard against pkg.main === "." which
      // would re-enter this same base and stack-overflow.
      if (mainBase !== base && mainBase !== base.replace(/\\/+$/, "")) {
        const resolved = __resolveFile(mainBase);
        if (resolved) return resolved;
      }
    }
  }
  const indexExts = ["/index.js", "/index.cjs", "/index.mjs", "/index.json"];
  for (const ext of indexExts) {
    const cand = base + ext;
    if (__fileExists(cand)) return cand;
  }
  // TypeScript sources, probed only once every candidate above has missed, so
  // the specifiers whose resolution changes are exactly those that resolve to
  // nothing today. Must agree with the prefetch resolver or a file is shipped
  // that this cannot find; both come from src/_shared/typescript-specifiers.ts
  // and tests/unit/typescript-specifier-resolution.mjs compares them.
  const baseTrim = base.replace(/\\/+$/, "");
  for (const cand of __typescriptFallbackCandidates(baseTrim)) {
    if (__pathIsFile(cand)) return cand;
  }
  for (const ext of __TYPESCRIPT_INDEX_CANDIDATES) {
    const cand = baseTrim + ext;
    if (__pathIsFile(cand)) return cand;
  }
  return null;
}

// __compiledModules is defined at MODULE TOP LEVEL in the generator code
// (facet-manager.ts) so new Function() runs during module evaluation.

// ── Single-source-of-truth exports/imports resolver (W2) ───────────────
// Emitted from src/_shared/exports-resolver.ts via getExportsResolverJS().
// Declares: resolveExports, resolveConditionValue, resolvePackageEntry,
//           DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS.
// the prior hand-rolled __resolvePkgEntry only honoured top-level
// require|default|import and dropped subpath maps, wildcards, nested
// conditions, the imports field, and null-target enforcement.
${EXPORTS_RESOLVER_JS}

// ── TypeScript specifier fallbacks ────────────────────────────────────────
// Emitted from src/_shared/typescript-specifiers.ts. Declares:
// __typescriptFallbackCandidates, __TYPESCRIPT_INDEX_CANDIDATES.
${TYPESCRIPT_SPECIFIERS_JS}

/** Conditions for runtime CJS resolution (user-shell node). */
const __NIMBUS_CJS_CONDITIONS = ["require", "node", "default"];

/**
 * Read and parse a package.json from VFS. Returns null on miss/parse-fail.
 */
function __readPkgJson(pkgDir) {
  const s = __readFileOr(pkgDir + "/package.json", null);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Resolve a single subpath inside an installed package (pkgDir).
 *   - subpath: '.' for root entry, './foo' for explicit subpath, etc.
 *   - Honours pkg.exports (subpath maps, wildcards, conditions).
 *   - Falls back to module/main for root, raw subpath probing otherwise.
 *   - Final filesystem probe via __resolveFile (extension list).
 *
 * Returns a VFS-relative path to the resolved file, or null.
 */
function __resolvePkgSubpath(pkgDir, pkg, subpath) {
  if (!pkg) pkg = __readPkgJson(pkgDir);
  if (!pkg) {
    // No package.json — try direct probe
    if (subpath === ".") return __resolveFile(pkgDir + "/index");
    return __resolveFile(pkgDir + "/" + subpath.replace(/^\\.\\/+/, ""));
  }
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  // X.5-F R3: ESM-condition fallback for pure-ESM packages whose
  // dist/.mjs files were transformed to CJS by transformEsmInBundle
  // at install time (facet-manager.ts:842, W3.5 Fix B). Without this,
  // packages like nuxt — whose exports map only contains
  // {types, import} for the root subpath — return null from the CJS
  // walk and dead-end with "Cannot find module 'nuxt'" even though
  // dist/index.mjs is in the bundle and runnable as CJS. We only fall
  // back when the package actually declares an exports map (so we
  // don't shadow legit "package not installed" misses).
  if (entry == null && pkg.exports != null) {
    entry = resolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    // Strip leading ./ from the resolver result
    const stripped = entry.replace(/^\\.\\/+/, "");
    const resolved = __resolveFile(pkgDir + "/" + stripped);
    if (resolved) return resolved;
    // W2.6a D2: exports/main yielded a target but the file doesn't exist
    // in the bundle (capped out, or the package mis-declares its main).
    // Fall through to the direct-probe path so we get index.js when the
    // declared entry is missing. Without this fallback, packages whose
    // exports point at a file evicted by the content cap return null and
    // the require chain dead-ends with "Cannot find module" — even though
    // a perfectly good index.js sits next to it.
  }
  // Fallback: probe the directory for a usable entry. This catches
  //   (a) exports map yielded null (forbidden / no condition matched)
  //   (b) exports map yielded a path whose file isn't on disk
  //   (c) main yielded a path whose file isn't on disk
  if (subpath === ".") {
    // Try main again under the extension-list resolver, then fall through
    // to /index probing. The shared resolvePackageEntry already prefers
    // exports → module → main, so re-probing main here only triggers when
    // entry was null OR entry's file was missing.
    if (typeof pkg.main === 'string') {
      const mainStripped = pkg.main.replace(/^\\.\\/+/, "");
      const r = __resolveFile(pkgDir + "/" + mainStripped);
      if (r) return r;
    }
    return __resolveFile(pkgDir + "/index");
  }
  const rel = subpath.replace(/^\\.\\/+/, "");
  return __resolveFile(pkgDir + "/" + rel);
}

/** Back-compat name used elsewhere in this file. */
function __resolvePkgEntry(pkgDir) {
  return __resolvePkgSubpath(pkgDir, null, ".");
}

/**
 * Resolve a bare specifier (e.g. "react", "@scope/pkg", "pkg/sub/path")
 * by walking up node_modules from fromDir. Returns the resolved file or null.
 */
function __resolveNodeModule(name, fromDir) {
  // Split into pkgName + subpath
  let pkgName, subpath;
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length < 2) return null;
    pkgName = parts.slice(0, 2).join("/");
    subpath = parts.length > 2 ? "./" + parts.slice(2).join("/") : ".";
  } else {
    const slashIdx = name.indexOf("/");
    if (slashIdx > 0) {
      pkgName = name.substring(0, slashIdx);
      subpath = "./" + name.substring(slashIdx + 1);
    } else {
      pkgName = name;
      subpath = ".";
    }
  }

  // Walk up directories looking for node_modules/<pkgName>.
  // Audit §3.7 (P7 fastify case): the prior loop was right, but the
  // visited-set keyed on dir-with-leading-slash-stripped while node_modules
  // existence checks used the same form, so iteration COULD terminate early
  // when hitting "" (empty string) at the root. Explicit termination on
  // empty string + always-also-check root node_modules covers both.
  let dir = (fromDir || "").replace(/^\\/+/, "");
  const visited = new Set();
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const nmDir = (dir ? dir + "/" : "") + "node_modules/" + pkgName;
    if (__fileExists(nmDir)) {
      const resolved = __resolvePkgSubpath(nmDir, null, subpath);
      if (resolved) return resolved;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
  return null;
}

/**
 * Resolve a #name imports-field specifier from the nearest enclosing
 * package.json. Returns the resolved file or null.
 */
function __resolveImportsField(name, fromDir) {
  // Walk up looking for the nearest package.json. Stop at the first one
  // (Node spec: imports field of the importing module's package).
  let dir = (fromDir || "").replace(/^\\/+/, "");
  while (true) {
    const pkgJsonPath = (dir ? dir + "/" : "") + "package.json";
    if (__fileExists(pkgJsonPath)) {
      const pkg = __readPkgJson(dir);
      if (pkg && pkg.imports) {
        const target = resolveExports(pkg.imports, name, __NIMBUS_CJS_CONDITIONS);
        if (target) {
          // Imports targets are relative to the package root (dir)
          if (target.startsWith("./")) {
            return __resolveFile((dir ? dir + "/" : "") + target.slice(2));
          }
          if (target.startsWith("/")) {
            return __resolveFile(target.slice(1));
          }
          // Bare specifier — re-resolve as a node_module from this dir
          return __resolveNodeModule(target, dir);
        }
      }
      return null; // first package.json wins, even if no imports field
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ──  X.5-S: __mkCompiledFn — conditional-param-rename wrap for new Function
// ═══════════════════════════════════════════════════════════════════════
//
// vite's chunks/node.js (transitive bundle of open@10.2.0) contains the
// ESM idiom \`const __dirname = path.dirname(fileURLToPath(import.meta.url))\`.
// W3.5 Fix B's esbuild ESM→CJS transform preserves that line verbatim
// while substituting \`import.meta\` with \`const import_meta = {}\`. Wrapping
// the body in \`new Function("exports","require","module","__filename","__dirname", code)\`
// then collides at parse time:
//
//     SyntaxError: Identifier '__dirname' has already been declared
//
// (VERIFY-23417C5 §4 #1 / X5M3-retro §"Next bucket".) The helper RENAMES
// the conflicting param to a placeholder name so the body's own
// \`const __dirname\` becomes the single declarer. We rename rather than
// drop because callers pass 5 positional arguments and dropping a slot
// would mis-align downstream slots (e.g. the USER_CODE wrap appends
// \`console\` / \`process\` / etc. after \`__dirname\`). Renaming preserves
// slot alignment while letting the body's binding win.
//
// Symmetric for \`__filename\` because open@10's idiom often emits both.
function __mkCompiledFn(code) {
  const reFn = /(?:^|\\n|;)\\s*(?:const|let|var)\\s+__filename\\s*=/m;
  const reDn = /(?:^|\\n|;)\\s*(?:const|let|var)\\s+__dirname\\s*=/m;
  const fnName = reFn.test(code) ? "__filename__nimbus_unused" : "__filename";
  const dnName = reDn.test(code) ? "__dirname__nimbus_unused"  : "__dirname";
  return new Function("exports", "require", "module", fnName, dnName, code);
}

function __exportsTarget(mod) {
  const value = mod.exports;
  if (value && (typeof value === "object" || typeof value === "function")) return value;
  return Object(value);
}

function __isTdzExportRead(error) {
  const message = error && typeof error.message === "string"
    ? error.message
    : String(error);
  return message.includes("before initialization") ||
    message.includes("Cannot read properties of undefined (reading");
}

function __makeLoadingExports(mod) {
  return new Proxy({}, {
    get(_target, prop) {
      try {
        return Reflect.get(__exportsTarget(mod), prop);
      } catch (error) {
        if (__isTdzExportRead(error)) return undefined;
        throw error;
      }
    },
    set(_target, prop, value) {
      if (!mod.exports || (typeof mod.exports !== "object" && typeof mod.exports !== "function")) {
        mod.exports = {};
      }
      return Reflect.set(mod.exports, prop, value);
    },
    has(_target, prop) {
      return Reflect.has(__exportsTarget(mod), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(__exportsTarget(mod));
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(__exportsTarget(mod), prop);
      return desc ? { ...desc, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(__exportsTarget(mod));
    },
  });
}

/**
 * Load and execute a JS/JSON module from VFS.
 * Returns the module.exports value.
 */
function __loadModule(resolvedPath) {
  if (__moduleCache.has(resolvedPath)) return __moduleCache.get(resolvedPath);

  const mod = { exports: {} };
  __moduleCache.set(resolvedPath, __makeLoadingExports(mod));

  const code = __readFileOr(resolvedPath, null);
  if (code === null) throw new Error("Cannot read module: " + resolvedPath);

  // JSON
  if (resolvedPath.endsWith(".json")) {
    mod.exports = JSON.parse(code);
    __moduleCache.set(resolvedPath, mod.exports);
    return mod.exports;
  }

  // JS — wrap in function and execute with scoped require
  const modDir = resolvedPath.includes("/") ? resolvedPath.substring(0, resolvedPath.lastIndexOf("/")) : ".";
  const scopedRequire = (id) => __requireFrom(id, modDir);
  scopedRequire.resolve = (id) => {
    const r = __resolveFrom(id, modDir);
    if (!r) throw new Error("Cannot resolve '" + id + "'");
    return r;
  };
  scopedRequire.cache = __moduleCache;
  scopedRequire.main = __require.main;

  // X.5-M3: thread currently-loading module path through globalThis so the
  // URL shim null-base fallback (in node-shims url module) can compose
  // relative URLs against the real module location — synthesizing
  // import.meta.url semantics for ESM that esbuild CJS-emit reduced to
  // const import_meta = {}. Save+restore for recursive __loadModule.
  const __prevModulePath = globalThis.__currentModulePath;
  globalThis.__currentModulePath = resolvedPath;
  try {
    // Use pre-compiled function from startup (new Function allowed at module eval time)
    // Normalize path to match VFS bundle key format (no leading /)
    const normalizedPath = resolvedPath.replace(/^\\/+/, "");
    const precompiled = __compiledModules.get(normalizedPath) || __compiledModules.get(resolvedPath);
    if (precompiled) {
      precompiled(
        mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir,
      );
    } else {
      // Try new Function at request time when the file was not part of the
      // startup precompile set.
      // X.5-S: conditional-param-rename via __mkCompiledFn — see helper
      // comment above. Without this, esbuild-transformed ESM that declares
      // \`const __dirname = …\` at top level (e.g. vite's chunks/node.js)
      // collides with the previously hardcoded \`__dirname\` parameter.
      try {
        const fn = __mkCompiledFn(code);
        fn(
          mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir,
        );
      } catch (evalErr) {
        // W3.5 Fix C: if the file was in the bundle but its pre-compile
        // failed at facet startup, surface the original SyntaxError
        // instead of the misleading "file was not pre-bundled" text.
        const normalizedPath2 = resolvedPath.replace(/^\\/+/, "");
        const compileErr =
          (typeof __compileFailures !== "undefined" && __compileFailures &&
            (__compileFailures.get(normalizedPath2) || __compileFailures.get(resolvedPath))) || null;
        if (compileErr) {
          throw new Error(
            "Cannot load module '" + resolvedPath +
            "': pre-compile failed at facet startup: " + compileErr,
          );
        }
        if (evalErr.message && evalErr.message.includes("Code generation from strings disallowed")) {
          throw new Error("Cannot load module '" + resolvedPath + "': file was not pre-bundled. Add it to the VFS bundle.");
        }
        throw evalErr;
      }
    }
  } catch (e) {
    __moduleCache.delete(resolvedPath);
    if (e && typeof e === "object" && !e.__nimbusModulePath) {
      try {
        e.__nimbusModulePath = resolvedPath;
        if (typeof e.message === "string") {
          e.message += "\\nNimbus module: " + resolvedPath;
        }
        if (typeof e.stack === "string" && !e.stack.includes("Nimbus module:")) {
          e.stack += "\\nNimbus module: " + resolvedPath;
        }
      } catch {}
    }
    throw e;
  } finally {
    globalThis.__currentModulePath = __prevModulePath;
  }

  // Update cache with final exports (module.exports may have been reassigned)
  __moduleCache.set(resolvedPath, mod.exports);
  return mod.exports;
}

/**
 * Resolve a module ID from a given directory.
 * Returns the resolved VFS path, or null.
 */
function __resolveFrom(id, fromDir) {
  // X.5-P: literal "." / ".." are CommonJS aliases for "./" / "../".
  // Pre-fix they slipped past the startsWith("./")/("../") guards (which
  // require >= 3 / >= 4 chars respectively) and fell into the bare-spec
  // branch — querying __resolveNodeModule for a package literally named
  // "." → "Cannot find module '.'" (verify-90993b3 §3 bucket P:
  // fastify via ajv/dist/compile/jtd, redis via @redis/client/dist/lib/client).
  // Normalize so they take the relative-resolve branch (which then probes
  // index.js / package.json#main via __resolveFile). See
  if (id === ".") id = "./";
  else if (id === "..") id = "../";
  // Relative path
  if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) {
    let base;
    if (id.startsWith("/")) {
      base = id.replace(/^\\/+/, "");
    } else {
      // VFS paths are stored without leading /. __pathMod.resolve treats
      // a non-absolute fromDir as relative-to-cwd which would corrupt the
      // result (audit §3.7-bug). Force-absolutise fromDir before resolving,
      // then strip the leading / again.
      const absFromDir = fromDir.startsWith("/") ? fromDir : "/" + fromDir;
      base = __pathMod.resolve(absFromDir, id).replace(/^\\/+/, "");
    }
    return __resolveFile(base);
  }
  // imports field (#name)
  if (id.startsWith("#")) {
    return __resolveImportsField(id, fromDir);
  }
  // Bare specifier → node_modules resolution
  return __resolveNodeModule(id, fromDir);
}

globalThis.__nimbusImportMetaResolve = function __nimbusImportMetaResolve(specifier, parentUrl) {
  const currentFromParent = typeof parentUrl === "string" && parentUrl.startsWith("file:")
    ? parentUrl.replace(/^file:\\/\\/\\/+/, "")
    : "";
  const current = currentFromParent || (
    typeof globalThis.__currentModulePath === "string"
      ? globalThis.__currentModulePath.replace(/^\\/+/, "")
      : ""
  );
  const fromDir = current.includes("/") ? current.substring(0, current.lastIndexOf("/")) : "";
  const text = String(specifier);
  if (text.startsWith("file:")) return text;
  if (text.startsWith("./") || text.startsWith("../") || text.startsWith("/")) {
    return new URL(text, current ? "file:///" + current : "file:///").href;
  }
  const resolved = __resolveFrom(text, fromDir);
  // Node throws ERR_MODULE_NOT_FOUND rather than answering with the specifier
  // it could not resolve, and packages are written against that: the standard
  // shape is a try/catch that reports something the user can act on. Handing
  // back the bare specifier passes the "unresolved" case off as a URL, so
  // fileURLToPath downstream yields a path that was never on disk and the
  // eventual error names a phantom file instead of the missing package.
  // typescript@7 does exactly this: with the specifier echoed back it reports
  // "Executable not found: @typescript/typescript-linux-x64/lib/tsc", where
  // its own catch would have said the platform package is missing.
  if (!resolved) {
    const err = new Error(
      "Cannot find package '" + text + "' imported from " + (current || fromDir || "<unknown>"),
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return "file:///" + resolved.replace(/^\\/+/, "");
};

/**
 * require() from a specific directory context.
 * This is what each loaded module gets as its require function.
 */
function __requireFrom(id, fromDir) {
  // Check builtins first (always takes priority)
  if (builtins[id]) return builtins[id];
  if (id.startsWith("node:")) {
    const bare = id.substring(5);
    if (builtins[bare]) return builtins[bare];
  }

  const resolved = __resolveFrom(id, fromDir);
  if (!resolved) throw new Error("Cannot find module '" + id + "' (from " + fromDir + ")");

  return __loadModule(resolved);
}

function __requireBaseDir(specifier) {
  const text = String(specifier || "");
  const filePath = text.startsWith("file:")
    ? builtins.url.fileURLToPath(text)
    : text;
  const normalized = filePath.replace(/^\\/+/, "");
  const fullPath = normalized || (dirname || cwd || "/home/user").replace(/^\\/+/, "");
  const slash = fullPath.lastIndexOf("/");
  return slash >= 0 ? fullPath.substring(0, slash) : "";
}

function __makeRequire(fromDir) {
  const localRequire = (id) => __requireFrom(id, fromDir);
  localRequire.resolve = (id) => {
    const r = __resolveFrom(id, fromDir);
    if (!r) throw new Error("Cannot resolve '" + id + "'");
    return "/" + r;
  };
  localRequire.cache = __moduleCache;
  localRequire.main = __require.main;
  return localRequire;
}

/**
 * Top-level require() — resolves from cwd/dirname.
 * This is the require passed to the user's entry script.
 */
function __require(id) {
  return __requireFrom(id, dirname || cwd || "/home/user");
}
__require.resolve = (id) => {
  const r = __resolveFrom(id, dirname || cwd || "/home/user");
  if (!r) throw new Error("Cannot resolve '" + id + "'");
  return "/" + r;
};
__require.cache = __moduleCache;
__require.main = null;

// ═══════════════════════════════════════════════════════════════════════
// ── END OF GENERATED SHIMS — closing marker ─────────────────────────
// (builtins block has been moved above the resolver functions)
// ═══════════════════════════════════════════════════════════════════════
`;
}
