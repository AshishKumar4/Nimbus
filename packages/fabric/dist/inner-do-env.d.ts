/**
 * inner-do-env.ts — a classic Durable Object binding inside an inner Worker.
 *
 * `nimbus wrangler dev` loads the user's Worker as a dynamic worker, and its
 * Durable Object bindings run as facets of the session Durable Object. The
 * binding the loader passes (`NimbusDurableObjectNamespace`, an entrypoint of
 * the session's isolate) answers RPC, so it cannot be the inner Worker's
 * namespace: a DurableObjectNamespace's API is synchronous (`env.P.get(
 * env.P.idFromName('x'))` takes no await), and an RpcPromise cannot travel as
 * an argument ("Could not serialize object of type RpcPromise").
 *
 * So a module the inner Worker runs before any of its own code (its main
 * module's first import, `innerWorkerModules`) replaces each such binding in
 * the isolate's env, which every handler, entrypoint and Durable Object of the
 * isolate sees, with a local namespace. Ids are made locally, and `get`
 * answers at once an RPC stub (`new RpcStub(target)`) of a local target that
 * relays each member the stub's caller reaches (a call, a read, or a path
 * through members, fetch included) to the binding's `callOn` or `getOn`,
 * which the session runs on the object's facet. An RPC stub is what a
 * Durable Object stub is to the runtime: callable by any method name, read by
 * any property name, pipelined, bound to its request, and transferable, as an
 * argument or an answer, where an entrypoint of a dynamically-loaded Worker
 * is not. Arguments and answers cross natively, stubs, functions and streams
 * included.
 *
 * It differs from a Durable Object stub in one way the runtime fixes: `typeof`
 * is 'function'. Its own `dup` and `Symbol.dispose` are shadowed, so `dup` is
 * the object's (which refuses it, as Cloudflare does) and it is not
 * disposable. And it is not persistent, so a Worker Loader env cannot carry
 * it ("RpcStub cannot be serialized in this context because it is not a
 * persistent stub"): the loader shim (NimbusLoaderRPC) keeps a child's code
 * and loads it again in each later request, so the child's env can carry
 * nothing made in one request, the session's own stubs included.
 */
import type { RpcStub, WorkerEntrypoint } from 'cloudflare:workers';
/**
 * The id string a name gives: deterministic (FNV-style, 64-bit hex), with the
 * prefix `name:` so it never collides with a `uniq:` id. Self-contained: its
 * source also runs in the inner isolate (innerDoAdapter).
 */
export declare function innerDoIdFromName(name: string): string;
/** What the binding the loader passes answers: one access to one object. */
export interface InnerDoRemote {
    /** The member of object `id` at `path` (names from the object down), called with `args`. */
    callOn(id: string, path: string[], args: unknown[]): Promise<unknown>;
    /** The member of object `id` at `path`, read. */
    getOn(id: string, path: string[]): Promise<unknown>;
}
/** What the adapter runs over: the inner isolate's `cloudflare:workers`. */
export interface InnerDoRuntime {
    env: object;
    WorkerEntrypoint: typeof WorkerEntrypoint;
    RpcStub: typeof RpcStub;
}
/** The entrypoint a build asks which Durable Object classes are missing. */
export declare const CLASSES_ENTRYPOINT = "NimbusDurableObjectClasses";
/**
 * The adapter, as it runs in the inner isolate: it replaces each of `names`
 * in `runtime.env` that holds the binding with a local DurableObjectNamespace,
 * and answers the class check the main module exports. `main` is the main
 * module's namespace. Self-contained (serialized with toString): it reaches
 * nothing outside itself but its arguments.
 */
export declare function innerDoAdapter(idFromName: (name: string) => string, names: readonly string[], main: object, runtime: InnerDoRuntime): {
    NimbusDurableObjectClasses: unknown;
};
/**
 * The modules an inner Worker runs with Durable Object bindings `names`: its
 * bundle as the main module, whose first import is the adapter (so the
 * adapter has run before any of the Worker's code) and which exports the
 * class check, and the adapter. The import shares the bundle's first line,
 * so line numbers stay the bundle's. A Worker with no such binding runs its
 * bundle as it is.
 */
export declare function innerWorkerModules(bundle: string, names: readonly string[]): {
    mainModule: string;
    modules: Record<string, string>;
};
//# sourceMappingURL=inner-do-env.d.ts.map