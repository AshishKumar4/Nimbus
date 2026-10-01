/**
 * The Durable Object namespace a Worker under `wrangler dev` sees.
 *
 * Cloudflare's DurableObjectNamespace is synchronous where it can be:
 * `idFromName`, `newUniqueId`, `idFromString`, `get` and `getByName` return at
 * once, and only a stub's `fetch` and RPC methods are calls. Nimbus reaches an
 * inner object through a loopback entrypoint (NimbusDurableObjectNamespace),
 * whose every method is an RPC call, so ids and stubs are made here, inside the
 * Worker, and only a stub's calls cross to the session. Code written for the
 * real API runs unchanged: `env.NS.get(env.NS.idFromName("a")).fetch(req)`.
 *
 * Module source for the Worker's own module map, beside the bundle.
 * `nimbusDurableObjectEnv(env, names)` swaps each named binding in `env`
 * for a namespace over it, in place and once, and returns `env`. In place
 * because `import { env } from "cloudflare:workers"` reads the same bindings.
 */
export declare const DO_NAMESPACE_SHIM_MODULE = "nimbus-do-namespace.js";
export declare const DO_NAMESPACE_SHIM_SOURCE: string;
/**
 * The Worker's main module when it binds Durable Objects: the bundle as
 * `user.js`, every export passed through, and each entry that receives `env`
 * — the default handlers and the bound classes' constructors — handed it with
 * the namespaces in place.
 */
export declare function doNamespaceWrapperSource(bindingNames: readonly string[], classNames: readonly string[]): string;
//# sourceMappingURL=do-namespace-shim.d.ts.map