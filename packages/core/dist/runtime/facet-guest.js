/**
 * A facet of the local facet host, inside the worker or process that is its
 * realm (local-facet-host.ts).
 *
 * The scope a facet needs is built here, in the realm's own globals: the
 * wasm table filled with the modules the host compiled, the preamble
 * evaluated once, and each submitted function evaluated inside it. A program
 * the facet runs that reaches JavaScript (Ruby's `js` bridge evaluates code
 * and reads any global) reaches this realm's, never the host's.
 *
 * The session capability crosses as calls (runtime/realm-guest.ts). On a
 * host that parks (JSPI) the supervisor's methods settle with the host's
 * answer, so a guest parks on them as on any syscall (in a process realm the
 * answer is waited for first, so the guest parks on a settled promise). On
 * one that cannot, they wait for the answer, holding this thread, as the
 * same-isolate supervisor answered at once; its synchronous view's methods
 * always wait.
 */
import { joinRealm } from './realm-guest.js';
import { realmOutcome } from './realm.js';
import { isFacetPayload, isFacetSubmit, wasmCompiler } from './local-facet-host.js';
const isScopedFn = (value) => typeof value === 'function';
const isEvaluator = (value) => typeof value === 'function';
/**
 * `new Function`, but for a body that may `await` at its top level.
 *
 * A facet preamble is written as a MODULE body, and the WASI shim uses that:
 * it resolves `cloudflare:sockets` with a top-level `await import(...)` inside a
 * try/catch, so a host that does not have the module gets a shim without
 * sockets instead of a shim that fails to parse. `new Function` cannot hold
 * that; an async function body can, and the rejected import lands in the same
 * catch it was written for.
 */
const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
const joined = await joinRealm();
if (!isFacetPayload(joined.payload))
    throw new Error('facet-guest: started without a facet');
const { tag, parking, preamble, supervisor } = joined.payload;
const isTypedArray = (value) => ArrayBuffer.isView(value) && !(value instanceof DataView);
/**
 * A copy of `value` that owns its bytes when it is a view on more of them (a
 * view crosses with its whole buffer, and a guest's is its whole memory),
 * the same kind of view: a typed array its own type, a DataView a DataView.
 */
const own = (value) => {
    if (!ArrayBuffer.isView(value) || value.byteLength === value.buffer.byteLength)
        return value;
    if (isTypedArray(value))
        return value.slice();
    return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
};
/** The supervisor's methods (or its synchronous view's), each a call to the host. */
function view(name, methods) {
    const call = name === 'supervisor' && parking === 'jspi' ? joined.callAsync : joined.call;
    return Object.fromEntries(methods.map((method) => [
        method,
        (...args) => call({ op: 'supervisor', view: name, method, args: args.map(own) }),
    ]));
}
const bindings = supervisor
    ? {
        SUPERVISOR: {
            ...view('supervisor', supervisor.methods),
            ...(supervisor.synchronous ? { synchronous: view('synchronous', supervisor.synchronous) } : {}),
        },
    }
    : {};
const wasmTable = {};
let evaluate = null;
const scoped = new Map();
/**
 * The facet's scope, built once.
 *
 * The returned closure's `eval` is a DIRECT eval inside the body the preamble
 * was evaluated in, which is what puts the preamble's top-level declarations
 * in scope for every function submitted afterwards.
 *
 * Both wasm tables are filled BEFORE that body runs, per-call images merged
 * over the spec's. A preamble may boot its runtime as it is evaluated — Ruby
 * instantiates the interpreter right there — so it reads the table at that
 * moment and an image added afterwards would arrive to a facet that had
 * already given up on it. workerd has the same ordering for the same reason:
 * per-call images ride in the module map the inner worker is built from.
 *
 * `globalThis` inside the scope is the facet's own scope object: preambles
 * publish their entry points on it and runners read them back from it.
 */
async function scope() {
    if (evaluate)
        return evaluate;
    const globals = { __NIMBUS_WASM: wasmTable };
    const build = new AsyncFunction('globalThis', `${preamble ?? ''}\nreturn (source) => eval(source);`);
    const built = await build.call(globals, globals);
    if (!isEvaluator(built))
        throw new Error(`Nimbus: facet '${tag}' built no scope`);
    evaluate = built;
    return built;
}
/** Adds the submit's modules to the table: every one, or (when one fails to compile) none. */
async function install(submit) {
    const compiled = {};
    for (const [name, module] of Object.entries(submit.modules)) {
        compiled[name] = module instanceof WebAssembly.Module ? module : await wasmCompiler()(module);
    }
    Object.assign(wasmTable, compiled);
}
async function run(submit) {
    const evaluateIn = await scope();
    let fn = scoped.get(submit.source);
    if (!fn) {
        const value = evaluateIn(`(${submit.source})`);
        if (!isScopedFn(value))
            throw new Error(`Nimbus: facet '${tag}' was submitted a value that is not a function`);
        fn = value;
        scoped.set(submit.source, fn);
    }
    return own(await fn(submit.args, bindings));
}
// Submits arrive one at a time (the host orders them), each answered by its id.
joined.events.on('message', (event) => {
    if (!isFacetSubmit(event))
        return;
    void (async () => {
        const installing = await realmOutcome(() => install(event));
        const outcome = 'error' in installing ? installing : await realmOutcome(() => run(event));
        joined.post({ type: 'done', id: event.id, installed: !('error' in installing), ...outcome });
    })();
});
