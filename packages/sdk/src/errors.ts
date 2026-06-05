/**
 * @nimbus-sh/sdk/errors — Typed error classes re-exported from the
 * worker auth module.
 *
 * Every error in `@nimbus-sh/sdk` extends `NimbusAuthError`, which has
 * a stable `.code` property for catch-site discrimination and an
 * `.httpStatus` hint for response mapping. The class hierarchy is
 * `instanceof`-friendly: a blanket `catch (e instanceof NimbusAuthError)`
 * catches every subclass.
 *
 * @example
 * ```ts
 * import {
 *   NimbusAuthError,
 *   NimbusTokenExpiredError,
 *   NimbusScopeError,
 * } from '@nimbus-sh/sdk/errors';
 *
 * try {
 *   await verifyNimbusToken(env, token);
 * } catch (e) {
 *   if (e instanceof NimbusTokenExpiredError) {
 *     return Response.json({ refresh: true }, { status: 401 });
 *   }
 *   if (e instanceof NimbusScopeError) {
 *     return Response.json({ missingScope: e.requiredScope }, { status: 403 });
 *   }
 *   if (e instanceof NimbusAuthError) {
 *     return Response.json({ error: e.message, code: e.code }, { status: e.httpStatus });
 *   }
 *   throw e;
 * }
 * ```
 */

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
} from '@nimbus-sh/worker/auth';
