/**
 * undici-shim.ts — the `undici` npm package, mapped onto the platform HTTP stack.
 *
 * Like streams.ts / sqlite-shim.ts, this emits a raw JS string embedded in the
 * generated facet module (interpolated by node-shims.ts). It defines
 * `__undiciMod`, which node-shims registers as `builtins.undici`.
 *
 * Why this exists
 * ───────────────
 * `undici` is Node's reference `fetch` implementation and one of the most
 * common transitive dependencies on npm. Its own implementation speaks HTTP
 * over raw TCP sockets through Node internals a Worker facet does not have, so
 * inside a facet it is doubly broken:
 *
 *   1. `undici.install()` REPLACES `globalThis.fetch` with undici's, which then
 *      throws `TypeError: addAbortListenerNative is not a function` on its
 *      first call. Any tool that installs it (pi's dist/core/http-dispatcher.js
 *      does, at import time) loses fetch entirely — surfacing to the user as an
 *      unexplained "Connection error".
 *   2. That replacement also silently defeats Nimbus's own machinery. In-session
 *      loopback routing (`127.0.0.1:<port>` → the facet owning that port) and
 *      AI-egress mediation (a request presenting the session's AI capability
 *      token is served by the session's own gateway) both live on the patched
 *      `globalThis.fetch` in node-shims.ts. Swapping in undici's fetch drops
 *      both.
 *
 * Making undici's socket path work is not the fix — the facet has no sockets.
 * The fix is that in Nimbus, the thing undici exists to provide is already
 * there: WHATWG `fetch`/`Request`/`Response`, patched with loopback + egress
 * mediation. So `require('undici')` resolves here instead of to node_modules,
 * and every export is backed by that same patched fetch.
 *
 * Registration goes in the `builtins` table, which `__requireFrom` consults
 * BEFORE node_modules resolution — so this wins over any installed copy of the
 * real package without a second module-resolution path, and the ESM→CJS
 * pre-pass (facets/manager.ts `transformEsmInBundle`, plus esbuild's
 * `dynamic-import: false` lowering) rewrites every `import`/`import()` of
 * 'undici' into that same `require`, so both module systems land here.
 *
 * Honesty contract
 * ────────────────
 * Every export exists. Each one is either backed by the platform, inert in a
 * way that cannot change the answer a caller gets, or a named thrower stating
 * exactly what is missing. Nothing silently returns something other than what
 * was asked for:
 *
 *   - Connection-pool tuning (`Agent`/`Pool`/`Client` options: keep-alive,
 *     pipelining, connections, timeouts) is accepted and ignored — connection
 *     management is the platform's and none of it changes the response.
 *   - Anything that reroutes or intercepts traffic — `ProxyAgent`, mocks, the
 *     low-level `dispatch()` protocol, interceptors — throws, because ignoring
 *     it would send traffic the caller believes it redirected or stubbed.
 *   - `EnvHttpProxyAgent` is inert when no proxy environment variable is set
 *     (which is what it does in Node too) and throws when one is, rather than
 *     quietly bypassing it.
 *
 * Runtime scope dependencies (in scope where the shim block is interpolated):
 *   - globalThis.fetch — ALREADY patched by node-shims.ts (loopback + AI egress)
 *   - __streamMod (Readable.fromWeb, pipeline), __eventsMod, env
 */
export declare function generateUndiciShimCode(): string;
//# sourceMappingURL=undici-shim.d.ts.map