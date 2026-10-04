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
import { ESBUILD_NAME_MODULE_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
/**
 * The id string a name gives: deterministic (FNV-style, 64-bit hex), with the
 * prefix `name:` so it never collides with a `uniq:` id. Self-contained: its
 * source also runs in the inner isolate (innerDoAdapter).
 */
export function innerDoIdFromName(name) {
    let h1 = 0xdeadbeef ^ name.length;
    let h2 = 0x41c6ce57 ^ name.length;
    for (let i = 0; i < name.length; i++) {
        const ch = name.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'name:' + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
/**
 * The adapter, as it runs in the inner isolate: `wrapEnv(env, names)` answers
 * `env` with each of `names` a local DurableObjectNamespace over the binding
 * it holds. Self-contained (serialized with toString): it reaches nothing
 * outside itself but `idFromName`, its argument.
 */
export function innerDoAdapter(idFromName) {
    /** A Durable Object id: its string, and the name it was made from. */
    class DurableObjectId {
        name;
        #id;
        constructor(id, name) {
            this.#id = id;
            if (name !== undefined)
                this.name = name;
        }
        toString() { return this.#id; }
        equals(other) { return other instanceof DurableObjectId && String(other) === this.#id; }
    }
    /**
     * The stub for one object. `fetch` is the object's fetch; any other name is
     * its RPC method, called with the arguments given and answering the
     * binding's RpcPromise. Not thenable, as a stub is not.
     */
    function stubFor(remote, id) {
        const key = String(id);
        const objectFetch = (input, init) => remote.fetchOn(key, new Request(input, init));
        const calls = new Map();
        return new Proxy(Object.freeze({}), {
            get(_target, prop) {
                if (prop === 'id')
                    return id;
                if (prop === 'name')
                    return id.name;
                if (prop === 'fetch')
                    return objectFetch;
                if (typeof prop !== 'string' || prop === 'then')
                    return undefined;
                const known = calls.get(prop);
                if (known !== undefined)
                    return known;
                // The binding's method is a wildcard property: called on it, never through call().
                const call = (...args) => remote.callOn(key, prop, args);
                calls.set(prop, call);
                return call;
            },
        });
    }
    /** Whether `value` is a binding the loader passed (an RPC stub's methods are its properties). */
    function isRemote(value) {
        return value !== null && (typeof value === 'object' || typeof value === 'function')
            && typeof Reflect.get(value, 'fetchOn') === 'function' && typeof Reflect.get(value, 'callOn') === 'function';
    }
    /** env.MY_DO: the namespace, made locally; only its stubs' calls cross. */
    class DurableObjectNamespace {
        #remote;
        constructor(remote) { this.#remote = remote; }
        idFromName(name) { return new DurableObjectId(idFromName(String(name)), String(name)); }
        newUniqueId() { return new DurableObjectId('uniq:' + crypto.randomUUID().replaceAll('-', '')); }
        idFromString(id) { return new DurableObjectId(String(id)); }
        get(id) {
            return stubFor(this.#remote, id instanceof DurableObjectId ? id : new DurableObjectId(String(id)));
        }
        getByName(name) { return this.get(this.idFromName(name)); }
        jurisdiction() { return this; }
    }
    const wrapped = new WeakMap();
    return {
        wrapEnv(env, names) {
            if (env === null || typeof env !== 'object' || names.length === 0)
                return env;
            let out = wrapped.get(env);
            if (out === undefined) {
                const namespaces = new Map();
                for (const name of names) {
                    const remote = Reflect.get(env, name);
                    if (isRemote(remote))
                        namespaces.set(name, new DurableObjectNamespace(remote));
                }
                // Every other binding as the loader passed it.
                out = new Proxy(env, {
                    get: (target, prop, receiver) => (namespaces.has(prop) ? namespaces.get(prop) : Reflect.get(target, prop, receiver)),
                });
                wrapped.set(env, out);
            }
            return out;
        },
    };
}
/** The inner Worker's own module, as bundled. */
const USER_MODULE = 'worker.js';
const ADAPTER_MODULE = 'nimbus-do-env.js';
const MAIN_MODULE = 'nimbus-main.js';
/**
 * The modules an inner Worker runs with Durable Object bindings `bindings`
 * (binding name, class name): its bundle, the adapter, and a main module
 * that re-exports the bundle with each handler of the default export, the
 * default export's class, and each Durable Object class handed the wrapped
 * env. A Worker with no such binding runs its bundle as it is.
 */
export function innerWorkerModules(bundle, bindings) {
    if (bindings.length === 0)
        return { mainModule: USER_MODULE, modules: { [USER_MODULE]: bundle } };
    const names = JSON.stringify(bindings.map((b) => b.name));
    const classes = [...new Set(bindings.map((b) => b.class_name))];
    const main = [
        `import * as user from './${USER_MODULE}';`,
        `import { wrapEnv } from './${ADAPTER_MODULE}';`,
        `export * from './${USER_MODULE}';`,
        `const wrap = (env) => wrapEnv(env, ${names});`,
        ...classes.map((name, i) => {
            const local = `NimbusDurableObject${i}`;
            return `const ${local} = class extends user[${JSON.stringify(name)}] { constructor(ctx, env) { super(ctx, wrap(env)); } };\nexport { ${local} as ${JSON.stringify(name)} };`;
        }),
        // A handler takes env second: fetch, scheduled, queue, email, tail, trace.
        'const base = user.default;',
        'export default typeof base === "function"',
        '  ? class extends base { constructor(ctx, env) { super(ctx, wrap(env)); } }',
        '  : base !== null && typeof base === "object"',
        '    ? Object.fromEntries(Object.entries(base).map(([key, value]) => [key, typeof value === "function"',
        '      ? function (event, env, ...rest) { return value.call(base, event, wrap(env), ...rest); }',
        '      : value]))',
        '    : base;',
    ].join('\n');
    const adapter = [
        // The functions below are serialized from the bundled worker, which wraps them in __name.
        ESBUILD_NAME_MODULE_SHIM,
        `const { wrapEnv } = (${innerDoAdapter.toString()})(${innerDoIdFromName.toString()});`,
        'export { wrapEnv };',
    ].join('\n');
    return { mainModule: MAIN_MODULE, modules: { [USER_MODULE]: bundle, [ADAPTER_MODULE]: adapter, [MAIN_MODULE]: main } };
}
