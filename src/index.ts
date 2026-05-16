/**
 * index.ts — Workers entrypoint.
 *
 * Two responsibilities, kept here because both must execute on every
 * request before any DO dispatch:
 *
 *   1. Re-export the DO classes + RPC service bindings so wrangler
 *      bundles them and `enable_ctx_exports` (compat date 2026-04-01+)
 *      auto-populates them under ctx.exports. NimbusSession
 *      (the Durable Object) and SupervisorRPC + the inner-Worker
 *      binding shims (NimbusAssetsRPC, NimbusLoaderRPC,
 *      NimbusLoadedWorker, NimbusLoadedEntrypoint,
 *      NimbusDurableObjectNamespace, NimbusDOStub) all need to be
 *      reachable as exports of the entrypoint module.
 *
 *   2. Route HTTP/WS requests to the right session via the session
 *      ID embedded in /s/<id>/* paths. URL → DO mapping is a stable
 *      contract delegated to {@link createNimbusHandler}.
 *
 * The fetch handler delegates to `createNimbusHandler({ auth: { mode:
 * 'auto' } })` — same shape an external embedder uses via
 * `@nimbus-sh/worker`. This file's only deploy-specific logic is the
 * W6.5 registry-event sink installed at module-load time.
 */

import {
  NimbusSession,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
} from './session/nimbus-session.js';
import { SupervisorRPC } from './session/supervisor-rpc.js';
import { CirrusHmrRPC } from './facets/real-vite-hmr.js';
import { createNimbusHandler } from './router/index.js';
import { getCtxExports as _getCtxExports } from './session/ctx-exports.js';
import { setRegistryEventSink } from './facets/wasm-swap-registry.js';

// W6.5: install the default registry-event sink at module top so events
// emitted from any code path (supervisor BFS, facet drain, applyW6Registry)
// land in `wrangler tail` as one JSON line per event. When F-observability
// lands, replace this with `env.INSTALL_METRICS.writeDataPoint(...)`.
//
// Format: `[w6.5/registry] {"type":"swap","from":"...","to":"...","ctx":"top"}`
setRegistryEventSink((e) => {
  try {
    console.log(`[w6.5/registry] ${JSON.stringify(e)}`);
  } catch {
    // Defensive — never break the install path on telemetry serialization.
  }
});

// Re-export inner-Worker binding shims so wrangler bundles them AND
// ctx.exports auto-populates Service Bindings for them (via
// enable_ctx_exports; default at compat date 2026-04-01+).
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

/**
 * Module-level reference to ctx.exports from the fetch handler.
 * Used by NimbusSession to create loopback bindings for facets.
 * Set once on the first fetch() call by createNimbusHandler.
 */
export function getCtxExports(): any {
  return _getCtxExports();
}

// Worker default export — a `createNimbusHandler()` instance running in
// auto auth mode. The live demo and dogfood embedder are bit-identical
// from here on; the only difference is `NIMBUS_LEGACY_PUBLIC=1` env var
// (set on the live demo, unset for the dogfood) flipping auth.mode to
// 'legacy' inside the auto-resolver.
export default createNimbusHandler();
