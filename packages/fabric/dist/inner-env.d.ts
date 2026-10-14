/**
 * inner-env.ts — the modules a `nimbus wrangler dev` Worker runs: its bundle,
 * whose first import is the module that adapts the isolate's env before any
 * of the Worker's code runs. That module runs the adapters compiled from
 * inner-do-env.ts (a classic Durable Object binding as a local namespace)
 * and inner-storage-env.ts (a D1 or R2 binding as the platform's API), each
 * over the binding the loader passes.
 */
import type { InnerStorageNames } from './inner-storage-env.js';
/** The bindings of an inner Worker's env that the adapter replaces, by name. */
export interface InnerBindingNames extends InnerStorageNames {
    durableObjects: readonly string[];
}
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
export declare function innerWorkerModules(bundle: string, names: InnerBindingNames): {
    mainModule: string;
    modules: Record<string, string>;
    classesEntrypoint: string | null;
};
//# sourceMappingURL=inner-env.d.ts.map