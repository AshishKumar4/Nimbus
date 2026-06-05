/**
 * Parallel dispatch utilities for Nimbus.
 *
 * Only the Nimbus-scoped pool is re-exported. The vendored
 * cloudflare-parallel surface is intentionally NOT exposed here — callers
 * must use the wrapper so they inherit stable-slot isolate reuse, Nimbus
 * compat flags, and SupervisorRPC autoinjection.
 *
 * See src/loaders/loader-pool.ts for the pool implementation and
 * src/loaders/vendor/ for the upstream cloudflare-parallel library.
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
