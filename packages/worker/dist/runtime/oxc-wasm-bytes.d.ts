/**
 * oxc-wasm-bytes.ts — supervisor-side fetcher for what the transform facet is
 * built from: the Oxc wasm (scripts/bundle-oxc-wasm.mjs) and the facet's
 * runtime script (scripts/bundle-facet-workers.mjs). Both are staged in the
 * static-assets layer under names carrying a prefix of their digest, read
 * through the colo cache (runtime/staged-source.ts), and verified against
 * their pins before the loader compiles or evaluates them.
 *
 * Neither is kept in module scope: they are read only when the facet's
 * loader has no worker cached under the facet's id, and that loader holds
 * the only long-lived copy, as compiled code. The host Worker never compiles
 * the wasm.
 */
import { type StagedSourceEnv } from './staged-source.js';
/** The Oxc wasm's bytes, for the transform facet's module map. */
export declare function fetchOxcWasmBytes(env: StagedSourceEnv): Promise<ArrayBuffer>;
/** The transform facet's runtime: a script that installs the globals its class reads. */
export declare function fetchOxcFacetRuntime(env: StagedSourceEnv): Promise<string>;
//# sourceMappingURL=oxc-wasm-bytes.d.ts.map