/**
 * apps/dogfood/src/index.ts — Nimbus live-demo embedder.
 *
 * This file IS the live demo at https://nimbus.ashishkmr472.workers.dev
 * AND the canonical reference embedder for `@nimbus-sh/worker`. Any
 * third-party project ships a file identical to this minus the
 * `NIMBUS_LEGACY_PUBLIC=1` env (set in wrangler.jsonc#vars below).
 *
 * Six lines of content (excluding comments + imports). That's the SDK's
 * goal: a worker entry point should be as small as a "hello world"
 * Worker but bring full Nimbus capabilities.
 */

import { NimbusSession, createNimbusHandler } from '@nimbus-sh/worker';

// Re-export the DO class so wrangler's `durable_objects.bindings[].class_name`
// lookup finds it in this module's exports.
export { NimbusSession };

// `auth: { mode: 'auto' }` (the default) honors NIMBUS_LEGACY_PUBLIC=1
// from env.vars. The live demo runs in legacy mode (no JWT verification);
// flipping the env var to enforce mode is a one-line config change.
export default createNimbusHandler();
