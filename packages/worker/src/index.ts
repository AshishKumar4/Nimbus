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
 * Application embedders import this deploy-time surface through
 * `@nimbus-sh/sdk/worker`. This implementation package keeps the
 * runtime and generated assets in one place.
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

// Re-export the composable factory + companion types. The SDK worker
// subpath re-exports these for application embedders:
//   import { createNimbusHandler, NimbusSession } from '@nimbus-sh/sdk/worker';
//   export { NimbusSession };
//   export default createNimbusHandler();
export { createNimbusHandler } from './router/index.js';
export type {
  NimbusHandler,
  NimbusHooks,
  NimbusHookContext,
  CustomRoutes,
  CreateNimbusHandlerOptions,
  AuthMode,
  NimbusAuthConfig,
  NimbusRemoteApiConfig,
  NimbusRuntimePolicy,
  NimbusSandboxProfile,
  NimbusSdkConfig,
  NimbusSdkRouterConfig,
} from './router/index.js';
// Auth surface — embedders need `issueNimbusToken` / `verifyNimbusToken`
// to mint tokens from custom routes. `@nimbus-sh/sdk/token` re-exports
// from the dedicated auth subpath for application callers.
export {
  issueNimbusToken,
  verifyNimbusToken,
  NimbusAuthError,
} from './auth/index.js';
export {
  generateSessionId,
  isValidSessionId,
} from './_shared/session-id.js';
// Embedders that run their own route table ahead of the Nimbus handler MUST
// test this first — see the doc comment on `isPreviewHostRequest`.
export { isPreviewHostRequest } from './_shared/preview-host.js';
export {
  base64Utf8,
  base64Url,
  base64UrlDecode,
  decodeJsonBase64Url,
  encodeJsonBase64Url,
  pkceChallenge,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
  unsealJson,
} from './_shared/crypto.js';
export {
  clearNimbusAgentOAuthCookie,
  createNimbusAgentOAuthCookie,
  fetchNimbusCloudflareAccounts,
  fetchNimbusCloudflareUserInfo,
  isNimbusCloudflareAccountId,
  isNimbusTenantSegment,
  loadNimbusAgentOAuthFromRequest,
  nimbusAgentAuthCookiePath,
  nimbusAgentRouteContext,
  NIMBUS_AGENT_AUTH_COOKIE,
  NIMBUS_AGENT_AUTH_COOKIE_PURPOSE,
  NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS,
  NIMBUS_CF_OAUTH_AUTH_URL,
  NIMBUS_CF_OAUTH_TOKEN_URL,
  NIMBUS_CF_OAUTH_USERINFO_URL,
  NIMBUS_CLOUDFLARE_API,
  readNimbusAgentCookieSecret,
  readNimbusCookie,
  requestNimbusCloudflareOAuthToken,
  serializeNimbusCookie,
} from './session/agent-oauth.js';
export type {
  NimbusAgentOAuthCookie,
  NimbusCloudflareAccount,
} from './session/agent-oauth.js';
export type {
  NimbusAuthEnv,
  NimbusTokenClaims,
  VerifiedNimbusToken,
} from './auth/index.js';

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
// auto auth mode. The live demo and hosted-demo embedder are bit-identical
// from here on; the only difference is `NIMBUS_LEGACY_PUBLIC=1` env var
// (set on the live demo, unset for the hosted-demo) flipping auth.mode to
// 'legacy' inside the auto-resolver.
export default createNimbusHandler();
