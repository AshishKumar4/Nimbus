/**
 * inner-env.ts — the modules a `nimbus wrangler dev` Worker runs: its bundle,
 * whose first import is the module that adapts the isolate's env before any
 * of the Worker's code runs. That module runs the adapters compiled from
 * inner-do-env.ts (a classic Durable Object binding as a local namespace)
 * and inner-storage-env.ts (a D1 or R2 binding as the platform's API), each
 * over the binding the loader passes.
 */
import { INNER_DO_ADAPTER_SOURCE, INNER_STORAGE_ADAPTER_SOURCE } from './compiled-bodies.generated.js';
/** The entrypoint a build asks which Durable Object classes are missing, unless the bundle spells it. */
const CLASSES_ENTRYPOINT = 'NimbusDurableObjectClasses';
/** The inner Worker's own module, as bundled, and the adapter's. */
const MAIN_MODULE = 'worker.js';
const ADAPTER_MODULE = 'nimbus-do-env.js';
/**
 * The modules an inner Worker runs with the bindings `names`: its bundle as
 * the main module, whose first import is the adapter (so the adapter has run
 * before any of the Worker's code), and the adapter. With Durable Object
 * bindings the main module also exports the class check as
 * `classesEntrypoint`. The import shares the bundle's first line, so line
 * numbers stay the bundle's. A Worker with no such binding runs its bundle
 * as it is; one with no Durable Object binding has no class check (null).
 *
 * `classesEntrypoint` is a name the bundle never spells, so it exports no
 * such name itself (a bundler prints an ASCII name as it is).
 */
export function innerWorkerModules(bundle, names) {
    const storage = names.kv.length > 0 || names.d1.length > 0 || names.r2.length > 0;
    if (names.durableObjects.length === 0 && !storage)
        return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: bundle }, classesEntrypoint: null };
    const adapter = ["import { env, RpcStub, WorkerEntrypoint } from 'cloudflare:workers';"];
    let head = `import './${ADAPTER_MODULE}';`;
    let classesEntrypoint = null;
    if (names.durableObjects.length > 0) {
        classesEntrypoint = CLASSES_ENTRYPOINT;
        for (let n = 2; bundle.includes(classesEntrypoint); n++)
            classesEntrypoint = `${CLASSES_ENTRYPOINT}_${n}`;
        head = `export { ${CLASSES_ENTRYPOINT} as ${classesEntrypoint} } from './${ADAPTER_MODULE}';`;
        adapter.push(`import * as main from './${MAIN_MODULE}';`, `const { innerDoAdapter, innerDoIdFromName } = ${INNER_DO_ADAPTER_SOURCE};`, `const { ${CLASSES_ENTRYPOINT} } = innerDoAdapter(innerDoIdFromName, ${JSON.stringify(names.durableObjects)}, main, { env, RpcStub, WorkerEntrypoint });`, `export { ${CLASSES_ENTRYPOINT} };`);
    }
    if (storage) {
        adapter.push(`const { innerStorageAdapter } = ${INNER_STORAGE_ADAPTER_SOURCE};`, `innerStorageAdapter(${JSON.stringify({ kv: names.kv, d1: names.d1, r2: names.r2 })}, env);`);
    }
    // A hashbang must stay first.
    const at = bundle.startsWith('#!') ? bundle.indexOf('\n') + 1 : 0;
    const main = bundle.slice(0, at) + head + bundle.slice(at);
    return { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: main, [ADAPTER_MODULE]: adapter.join('\n') }, classesEntrypoint };
}
