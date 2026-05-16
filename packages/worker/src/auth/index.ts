/**
 * auth/index.ts — Public re-exports for the Nimbus auth surface.
 *
 * Imported by:
 *   - `src/index.ts` (worker entry) for verify + idFromName scoping.
 *   - `src/_shared/session-router.ts` for the tenant-scoped DO instance name.
 *   - `@nimbus-sh/sdk/token` subpath re-exports issue/verify for embedder
 *     use in their own Worker (token mint endpoint) and CLI (`token mint`).
 *
 * Stable surface — anything not exported here is considered internal and
 * may move/rename without notice. Anything exported here follows semver.
 */

export {
  issueNimbusToken,
  verifyNimbusToken,
  type NimbusAuthEnv,
} from './token.js';

export {
  extractBearerToken,
  verifyRequestToken,
  requireScopes,
  requireSessionPin,
  setNimbusTokenCookie,
  authErrorResponse,
  NIMBUS_TOKEN_COOKIE,
  NIMBUS_TOKEN_QUERY,
} from './middleware.js';

export {
  NimbusAuthError,
  NimbusAuthConfigError,
  NimbusTokenMalformedError,
  NimbusTokenSignatureError,
  NimbusTokenClaimsError,
  NimbusTokenExpiredError,
  NimbusTokenTtlError,
  NimbusScopeError,
  NimbusSessionPinError,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  ID_COMPONENT_RE,
  type NimbusTokenClaims,
  type VerifiedNimbusToken,
  type IssueTokenOptions,
} from './types.js';
