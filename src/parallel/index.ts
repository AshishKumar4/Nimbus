/**
 * Parallel dispatch utilities for Nimbus.
 *
 * Only the Nimbus-scoped pool is re-exported. The vendored
 * cloudflare-parallel surface is intentionally NOT exposed here — callers
 * must use the wrapper so they inherit stable-slot isolate reuse, Nimbus
 * compat flags, and SupervisorRPC autoinjection.
 *
 * See src/parallel/facet-pool.ts for the pool implementation and
 * src/parallel/vendor/ for the upstream library.
 */

export { NimbusFacetPool } from './facet-pool.js';
export type {
  NimbusFacetPoolOptions,
  NimbusFacetCallOptions,
  NimbusFacetMapOptions,
} from './facet-pool.js';
export {
  BindingError,
  ExecutionError,
  RetryExhaustedError,
  TimeoutError,
} from './facet-pool.js';
