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
 * Its prototype is not RpcStub's but one shaped as a Durable Object stub's:
 * its constructor is a class `DurableObject` that cannot be constructed, its
 * tag is 'DurableObject', and it has no `dup` or Symbol.dispose of its own,
 * so `dup` is a member, which the runtime refuses as on Cloudflare. It
 * differs from a Durable Object stub in two ways the runtime fixes. `typeof`
 * is 'function'. And it is not persistent, so a Worker Loader env cannot carry
 * it ("RpcStub cannot be serialized in this context because it is not a
 * persistent stub"): the loader shim (NimbusLoaderRPC) keeps a child's code
 * and loads it again in each later request, so the child's env can carry
 * nothing made in one request, the session's own stubs included.
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
/** The entrypoint a build asks which Durable Object classes are missing, unless the bundle spells it. */
const CLASSES_ENTRYPOINT = 'NimbusDurableObjectClasses';
/**
 * The adapter, as it runs in the inner isolate: it replaces each of `names`
 * in `runtime.env` that holds the binding with a local DurableObjectNamespace,
 * and answers the class check the main module exports. `main` is the main
 * module's namespace. Self-contained (serialized with toString): it reaches
 * nothing outside itself but its arguments.
 */
export function innerDoAdapter(idFromName, names, main, runtime) {
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
    /** Whether `value` is the binding the loader passes (an RPC stub's methods are its properties). */
    function isRemote(value) {
        return value !== null && (typeof value === 'object' || typeof value === 'function')
            && typeof Reflect.get(value, 'callOn') === 'function' && typeof Reflect.get(value, 'getOn') === 'function';
    }
    /**
     * The member of object `id` at `path`, as the runtime reaches it in an RPC
     * to the stub: called, read (it is thenable, and the runtime awaits what a
     * read answers), or walked through to one of its own members (the runtime
     * walks a path through own properties only, so every name is reported as
     * one). At the empty path it is the stub's target.
     */
    function member(remote, id, path) {
        const next = (name) => member(remote, id, [...path, name]);
        return new Proxy((..._args) => undefined, {
            apply: (_target, _self, args) => remote.callOn(id, [...path], args),
            get: (target, name) => {
                if (name === 'then') {
                    return (resolve, reject) => remote.getOn(id, [...path]).then(resolve, reject);
                }
                return typeof name === 'string' ? next(name) : Reflect.get(target, name);
            },
            getOwnPropertyDescriptor: (target, name) => (typeof name === 'string' && name !== 'then'
                ? { value: next(name), writable: true, enumerable: true, configurable: true }
                : Reflect.getOwnPropertyDescriptor(target, name)),
        });
    }
    /**
     * A stub's prototype, as a Durable Object stub's shows: its constructor
     * cannot be called or constructed, and it is tagged 'DurableObject'.
     */
    const stubPrototype = Object.create(Object.prototype, {
        constructor: {
            value: function DurableObject() { throw new TypeError('Illegal constructor'); },
            writable: true,
            configurable: true,
        },
        [Symbol.toStringTag]: { value: 'DurableObject', configurable: true },
    });
    /** Asked once by a build: which classes the main module does not export. */
    class NimbusDurableObjectClasses extends runtime.WorkerEntrypoint {
        missing(classNames) {
            return classNames.filter((name) => typeof Reflect.get(main, name) !== 'function');
        }
    }
    /** env.MY_DO: the namespace, made locally; its stubs relay to `remote`. */
    class DurableObjectNamespace {
        #remote;
        constructor(remote) { this.#remote = remote; }
        idFromName(name) { return new DurableObjectId(idFromName(String(name)), String(name)); }
        newUniqueId() { return new DurableObjectId('uniq:' + crypto.randomUUID().replaceAll('-', '')); }
        idFromString(id) { return new DurableObjectId(String(id)); }
        get(id) {
            const at = id instanceof DurableObjectId ? id : new DurableObjectId(String(id));
            const stub = Object.setPrototypeOf(new runtime.RpcStub(member(this.#remote, String(at), [])), stubPrototype);
            // As a Durable Object stub has them: its own, enumerable, in this order.
            return Object.defineProperties(stub, {
                name: { value: at.name, enumerable: true },
                id: { value: at, enumerable: true },
            });
        }
        getByName(name) { return this.get(this.idFromName(name)); }
        jurisdiction() { return this; }
    }
    for (const name of names) {
        const remote = Reflect.get(runtime.env, name);
        if (isRemote(remote))
            Reflect.set(runtime.env, name, new DurableObjectNamespace(remote));
    }
    return { NimbusDurableObjectClasses };
}
/** The inner Worker's own module, as bundled, and the adapter's. */
const MAIN_MODULE = 'worker.js';
const ADAPTER_MODULE = 'nimbus-do-env.js';
/**
 * The modules an inner Worker runs with Durable Object bindings `names`: its
 * bundle as the main module, whose first import is the adapter (so the
 * adapter has run before any of the Worker's code) and which exports the
 * class check as `classesEntrypoint`, and the adapter. The import shares the
 * bundle's first line, so line numbers stay the bundle's. A Worker with no
 * such binding runs its bundle as it is, and has no class check (null).
 *
 * `classesEntrypoint` is a name the bundle never spells, so it exports no
 * such name itself (a bundler prints an ASCII name as it is).
 */
export function innerWorkerModules(bundle, names) {
    if (names.length === 0)
        return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: bundle }, classesEntrypoint: null };
    let classesEntrypoint = CLASSES_ENTRYPOINT;
    for (let n = 2; bundle.includes(classesEntrypoint); n++)
        classesEntrypoint = `${CLASSES_ENTRYPOINT}_${n}`;
    const head = `export { ${CLASSES_ENTRYPOINT} as ${classesEntrypoint} } from './${ADAPTER_MODULE}';`;
    // A hashbang must stay first.
    const at = bundle.startsWith('#!') ? bundle.indexOf('\n') + 1 : 0;
    const main = bundle.slice(0, at) + head + bundle.slice(at);
    const adapter = [
        "import { env, RpcStub, WorkerEntrypoint } from 'cloudflare:workers';",
        `import * as main from './${MAIN_MODULE}';`,
        // The functions below are serialized from the bundled worker, which wraps them in __name.
        ESBUILD_NAME_MODULE_SHIM,
        `const { ${CLASSES_ENTRYPOINT} } = (${innerDoAdapter.toString()})(${innerDoIdFromName.toString()}, ${JSON.stringify(names)}, main, { env, RpcStub, WorkerEntrypoint });`,
        `export { ${CLASSES_ENTRYPOINT} };`,
    ].join('\n');
    return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: main, [ADAPTER_MODULE]: adapter }, classesEntrypoint };
}
