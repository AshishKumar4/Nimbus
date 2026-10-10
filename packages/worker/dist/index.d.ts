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
import { NimbusSession, NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub } from './session/nimbus-session.js';
import { NimbusPublicDirectory } from './router/public-directory-do.js';
import { SupervisorRPC } from './session/supervisor-rpc.js';
import { CirrusHmrRPC } from './facets/real-vite-hmr.js';
export { createNimbusHandler } from './router/index.js';
export type { NimbusHandler, NimbusHooks, NimbusHookContext, CustomRoutes, CreateNimbusHandlerOptions, AuthMode, NimbusAuthConfig, NimbusRemoteApiConfig, NimbusRuntimePolicy, NimbusSandboxProfile, NimbusSdkConfig, NimbusSdkRouterConfig, } from './router/index.js';
export { issueNimbusToken, verifyNimbusToken, NimbusAuthError, } from './auth/index.js';
export { generateSessionId, isValidSessionId, } from './_shared/session-id.js';
export { isPreviewHostRequest } from './_shared/preview-host.js';
export { NimbusWorkspace } from '@nimbus-sh/core/workspace/nimbus-workspace.js';
export type { NimbusWorkspaceOptions } from '@nimbus-sh/core/workspace/nimbus-workspace.js';
export type { SqlDatabase, SqlTransactions, SqlRow, SqlValue, TransactionHost, } from '@nimbus-sh/core/runtime/os-contracts.js';
export type { NimbusAuthEnv, NimbusTokenClaims, VerifiedNimbusToken, } from './auth/index.js';
export { NimbusSession, NimbusPublicDirectory, SupervisorRPC, NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub, CirrusHmrRPC, };
/**
 * Module-level reference to ctx.exports from the fetch handler.
 * Used by NimbusSession to create loopback bindings for facets.
 * Set once on the first fetch() call by createNimbusHandler.
 */
export declare function getCtxExports(): any;
declare const _default: import("./index.js").NimbusHandler;
export default _default;
//# sourceMappingURL=index.d.ts.map