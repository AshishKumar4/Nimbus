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
import { ESBUILD_NAME_MODULE_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';

/**
 * The id string a name gives: deterministic (FNV-style, 64-bit hex), with the
 * prefix `name:` so it never collides with a `uniq:` id. Self-contained: its
 * source also runs in the inner isolate (innerDoAdapter).
 */
export function innerDoIdFromName(name: string): string {
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
export const CLASSES_ENTRYPOINT = 'NimbusDurableObjectClasses';
/**
 * The adapter, as it runs in the inner isolate: it replaces each of `names`
 * in `runtime.env` that holds the binding with a local DurableObjectNamespace,
 * and answers the class check the main module exports. `main` is the main
 * module's namespace. Self-contained (serialized with toString): it reaches
 * nothing outside itself but its arguments.
 */
export function innerDoAdapter(
  idFromName: (name: string) => string,
  names: readonly string[],
  main: object,
  runtime: InnerDoRuntime,
): { NimbusDurableObjectClasses: unknown } {
  /** A Durable Object id: its string, and the name it was made from. */
  class DurableObjectId {
    readonly name?: string;
    readonly #id: string;
    constructor(id: string, name?: string) {
      this.#id = id;
      if (name !== undefined) this.name = name;
    }
    toString(): string { return this.#id; }
    equals(other: unknown): boolean { return other instanceof DurableObjectId && String(other) === this.#id; }
  }

  /** Whether `value` is the binding the loader passes (an RPC stub's methods are its properties). */
  function isRemote(value: unknown): value is InnerDoRemote {
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
  function member(remote: InnerDoRemote, id: string, path: readonly string[]): (...args: unknown[]) => unknown {
    const next = (name: string) => member(remote, id, [...path, name]);
    return new Proxy((..._args: unknown[]): unknown => undefined, {
      apply: (_target, _self, args: unknown[]) => remote.callOn(id, [...path], args),
      get: (target, name) => {
        if (name === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => remote.getOn(id, [...path]).then(resolve, reject);
        }
        return typeof name === 'string' ? next(name) : Reflect.get(target, name);
      },
      getOwnPropertyDescriptor: (target, name) => (typeof name === 'string' && name !== 'then'
        ? { value: next(name), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, name)),
    });
  }

  /** Asked once by a build: which classes the main module does not export. */
  class NimbusDurableObjectClasses extends runtime.WorkerEntrypoint {
    missing(classNames: string[]): string[] {
      return classNames.filter((name) => typeof Reflect.get(main, name) !== 'function');
    }
  }

  /** env.MY_DO: the namespace, made locally; its stubs relay to `remote`. */
  class DurableObjectNamespace {
    readonly #remote: InnerDoRemote;
    constructor(remote: InnerDoRemote) { this.#remote = remote; }
    idFromName(name: string): DurableObjectId { return new DurableObjectId(idFromName(String(name)), String(name)); }
    newUniqueId(): DurableObjectId { return new DurableObjectId('uniq:' + crypto.randomUUID().replaceAll('-', '')); }
    idFromString(id: string): DurableObjectId { return new DurableObjectId(String(id)); }
    get(id: DurableObjectId | string): object {
      const at = id instanceof DurableObjectId ? id : new DurableObjectId(String(id));
      return Object.defineProperties(new runtime.RpcStub(member(this.#remote, String(at), [])), {
        // As a Durable Object stub has them: its own, enumerable, in this order.
        name: { value: at.name, enumerable: true },
        id: { value: at, enumerable: true },
        // A Durable Object stub has neither: `dup` is the object's, and it is not disposable.
        dup: { value: member(this.#remote, String(at), ['dup']) },
        [Symbol.dispose]: { value: undefined },
      });
    }
    getByName(name: string): object { return this.get(this.idFromName(name)); }
    jurisdiction(): DurableObjectNamespace { return this; }
  }

  for (const name of names) {
    const remote: unknown = Reflect.get(runtime.env, name);
    if (isRemote(remote)) Reflect.set(runtime.env, name, new DurableObjectNamespace(remote));
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
 * class check, and the adapter. The import shares the bundle's first line,
 * so line numbers stay the bundle's. A Worker with no such binding runs its
 * bundle as it is.
 */
export function innerWorkerModules(bundle: string, names: readonly string[]): { mainModule: string; modules: Record<string, string> } {
  if (names.length === 0) return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: bundle } };
  const head = `export { ${CLASSES_ENTRYPOINT} } from './${ADAPTER_MODULE}';`;
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
  return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: main, [ADAPTER_MODULE]: adapter } };
}
