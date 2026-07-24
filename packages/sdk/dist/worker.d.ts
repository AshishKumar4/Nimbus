/**
 * @nimbus-sh/sdk/worker - Cloudflare Worker embedder surface.
 *
 * This is the public entrypoint for deploying Nimbus itself inside a
 * Worker. The implementation is provided by @nimbus-sh/worker, but apps
 * should import through the SDK so the interactive app and programmatic
 * sandbox APIs share one public package surface.
 */
export { NimbusSession, SupervisorRPC, NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub, CirrusHmrRPC, base64Utf8, base64Url, base64UrlDecode, clearNimbusAgentOAuthCookie, createNimbusHandler, createNimbusAgentOAuthCookie, decodeJsonBase64Url, encodeJsonBase64Url, fetchNimbusCloudflareAccounts, fetchNimbusCloudflareUserInfo, generateSessionId, isNimbusCloudflareAccountId, isNimbusTenantSegment, isPreviewHostRequest, isValidSessionId, issueNimbusToken, loadNimbusAgentOAuthFromRequest, nimbusAgentAuthCookiePath, nimbusAgentRouteContext, NIMBUS_AGENT_AUTH_COOKIE, NIMBUS_AGENT_AUTH_COOKIE_PURPOSE, NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS, NIMBUS_CF_OAUTH_AUTH_URL, NIMBUS_CF_OAUTH_TOKEN_URL, NIMBUS_CF_OAUTH_USERINFO_URL, NIMBUS_CLOUDFLARE_API, pkceChallenge, randomBase64Url, readNimbusAgentCookieSecret, readNimbusCookie, requestNimbusCloudflareOAuthToken, sealJson, serializeNimbusCookie, sha256Base64Url, unsealJson, verifyNimbusToken, NimbusAuthError, } from '@nimbus-sh/worker';
export type { NimbusHandler, NimbusHooks, NimbusHookContext, CustomRoutes, CreateNimbusHandlerOptions, NimbusRemoteApiConfig, NimbusRuntimePolicy, NimbusSandboxProfile, NimbusSdkConfig, NimbusSdkRouterConfig, AuthMode, NimbusAuthConfig, NimbusAuthEnv, NimbusAgentAuthCookieResult, NimbusAgentOAuthCookie, NimbusCloudflareAccount, NimbusTokenClaims, VerifiedNimbusToken, } from '@nimbus-sh/worker';
//# sourceMappingURL=worker.d.ts.map