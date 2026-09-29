/**
 * host-wasm.ts — what the fabric knows about a WebAssembly.Module a host
 * hands a dynamic worker already compiled.
 *
 * workerd accepts a compiled module in a Worker Loader module map and lets
 * the dynamic worker share its compiled code (src/workerd/api/
 * worker-loader.c++, extractWasmModuleContent), so a host that bundles a
 * fixed wasm (esbuild's, say) hands that module over instead of fetching a
 * second copy of the bytes and having the guest compile them again. Two
 * things the fabric needs about a member are unreadable from JS for a
 * Module:
 *   - its size: the module's wire bytes still count toward the 64 MiB
 *     dynamic-worker code limit (worker-loader.c++ sums every member), and
 *     assertModuleMapWithinCodeLimit must count them;
 *   - its identity: a pool folds its wasm into the loader cache key, and a
 *     Module has no bytes to fingerprint.
 * The host that owns the module states both once, here.
 */
const described = new WeakMap();
/** Record what `module` is, and return it. */
export function describeHostWasm(module, identity) {
    if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
        throw new RangeError(`describeHostWasm: '${identity.id}' needs its wire size in bytes, got ${identity.bytes}`);
    }
    described.set(module, identity);
    return module;
}
/** What a host said `module` is, or undefined for a module nobody described. */
export function hostWasmIdentity(module) {
    return described.get(module);
}
