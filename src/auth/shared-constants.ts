/**
 * auth/shared-constants.ts — small constants split out so middleware
 * and routes can both import them without dragging in the crypto-using
 * `shared.ts` module.
 */

/**
 * Reserved DO name for the singleton auth DO. Routing rules:
 *
 *   1. The Worker entry rejects /s/<this>/* with 403 ("reserved").
 *   2. The Worker entry routes /__auth__/* internally to this DO.
 *   3. Public admin paths /auth/keys/* are also proxied to this DO
 *      via the same internal /__auth__/* handler.
 *
 * The literal `__nimbus_auth__` is bracketed by double underscores so
 * it can never collide with a user-chosen session ID (which must match
 * `[0-9a-z-]{12,64}` per `_shared/session-id.ts`).
 */
export const AUTH_DO_NAME = '__nimbus_auth__';
