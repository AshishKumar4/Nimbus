/**
 * apps/dogfood/src/index.ts — Nimbus live-demo embedder.
 *
 * This file IS the live demo at https://nimbus.ashishkmr472.workers.dev
 * AND the canonical reference embedder for `@nimbus-sh/worker`. Any
 * third-party project ships a file identical to this.
 *
 * Three-and-a-half lines of content (excluding comments + imports):
 *
 *   import { NimbusSession, createNimbusHandler, ...nimbusRpcClasses }
 *     from '@nimbus-sh/worker';
 *   export { NimbusSession, ...nimbusRpcClasses };
 *   export default createNimbusHandler();
 *
 * Why re-export the RPC classes? Cloudflare's `enable_ctx_exports`
 * feature (default at compat-date ≥ 2026-04-01) walks the *main
 * module's* exports to find DO + RPC classes. Nimbus uses these
 * classes internally for loopback bindings (env.SUPERVISOR,
 * env.ASSETS-via-RPC, etc.). Without the re-export, the runtime can't
 * find them and child facets get `env.SUPERVISOR === undefined`.
 *
 * The convenience: `@nimbus-sh/worker` re-exports every required class
 * by name, so an `export { ... } from '@nimbus-sh/worker'` does the
 * whole job.
 */

import {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
  createNimbusHandler,
} from '@nimbus-sh/worker';

// Re-export the DO class + every RPC class so wrangler discovers them
// for `durable_objects.bindings[].class_name` and `enable_ctx_exports`
// auto-populates loopback bindings.
export {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
};

// `auth: { mode: 'auto' }` (the default) honors NIMBUS_LEGACY_PUBLIC=1
// from env.vars. The live demo runs in legacy mode (no JWT verification);
// flipping the env var to enforce mode is a one-line config change.
export default createNimbusHandler();
