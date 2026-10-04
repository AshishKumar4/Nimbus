/**
 * inner-do-env.ts — a classic Durable Object binding inside an inner Worker.
 *
 * `nimbus wrangler dev` loads the user's Worker as a dynamic worker, and its
 * Durable Object bindings run as facets of the session Durable Object. A
 * binding cannot be handed to the inner Worker as an RPC stub: a
 * DurableObjectNamespace's API is synchronous (`env.P.get(env.P.idFromName(
 * 'x'))` takes no await), and an RpcPromise cannot travel as an argument
 * ("Could not serialize object of type RpcPromise"). So the binding the
 * loader passes (`NimbusDurableObjectNamespace`, an entrypoint of the session's
 * isolate) is wrapped, inside the inner isolate, by a local namespace: ids
 * are made locally, `get` answers a local stub at once, and only the stub's
 * calls cross, each one RPC (`fetchOn`, `callOn`), so a call answers an
 * RpcPromise as on Cloudflare: awaited for its value, or pipelined
 * (`stub.info().field`).
 *
 * The wrap is module code the inner Worker runs: `innerWorkerModules` adds it
 * and a main module that hands the wrapped env to the default export (each
 * handler, or its class) and to each Durable Object class.
 */
/**
 * The id string a name gives: deterministic (FNV-style, 64-bit hex), with the
 * prefix `name:` so it never collides with a `uniq:` id. Self-contained: its
 * source also runs in the inner isolate (innerDoAdapter).
 */
export declare function innerDoIdFromName(name: string): string;
/** What the binding the loader passes answers: one call on one object. */
export interface InnerDoRemote {
    fetchOn(id: string, request: Request): Promise<Response>;
    callOn(id: string, method: string, args: unknown[]): Promise<unknown>;
}
/**
 * The adapter, as it runs in the inner isolate: `wrapEnv(env, names)` answers
 * `env` with each of `names` a local DurableObjectNamespace over the binding
 * it holds. Self-contained (serialized with toString): it reaches nothing
 * outside itself but `idFromName`, its argument.
 */
export declare function innerDoAdapter(idFromName: (name: string) => string): {
    wrapEnv(env: object, names: readonly string[]): object;
};
/**
 * The modules an inner Worker runs with Durable Object bindings `bindings`
 * (binding name, class name): its bundle, the adapter, and a main module
 * that re-exports the bundle with each handler of the default export, the
 * default export's class, and each Durable Object class handed the wrapped
 * env. A Worker with no such binding runs its bundle as it is.
 */
export declare function innerWorkerModules(bundle: string, bindings: readonly {
    name: string;
    class_name: string;
}[]): {
    mainModule: string;
    modules: Record<string, string>;
};
//# sourceMappingURL=inner-do-env.d.ts.map