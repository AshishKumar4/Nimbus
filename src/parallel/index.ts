/**
 * Parallel dispatch utilities for Nimbus.
 *
 * Only the Nimbus-scoped pool is re-exported. The vendored
 * cloudflare-parallel surface is intentionally NOT exposed here — callers
 * must use the wrapper so they inherit stable-slot isolate reuse, Nimbus
 * compat flags, and SupervisorRPC autoinjection.
 *
 * [D'.2] Renamed file: src/parallel/facet-pool.ts → loader-pool.ts.
 * The pool is genuinely a Worker Loader pool (env.LOADER.get/load),
 * not a DO Facet pool — the old "Facet" name collided with the
 * platform's actual ctx.facets primitive (per dossier R3.1). The
 * runtime behaviour is unchanged; only the name is corrected.
 *
 * See src/parallel/loader-pool.ts for the pool implementation and
 * src/parallel/vendor/ for the upstream cloudflare-parallel library.
 */

export { NimbusLoaderPool } from './loader-pool.js';
export type {
  NimbusLoaderPoolOptions,
  NimbusLoaderCallOptions,
  NimbusLoaderMapOptions,
} from './loader-pool.js';
export {
  BindingError,
  ExecutionError,
  RetryExhaustedError,
  TimeoutError,
} from './loader-pool.js';
