/**
 * @nimbus-sh/sdk/token — JWT mint + verify, re-exported from the worker
 * auth module.
 *
 * Why a re-export and not a copy? The auth module is the single source
 * of truth — both Worker (verify) and SDK (mint) call the same code
 * paths so wire-format drift is structurally impossible. The
 * `@nimbus-sh/worker` provides the shared auth implementation. The SDK
 * package depends on that single source of truth so token wire-format
 * drift is structurally impossible.
 *
 * @example mint
 * ```ts
 * import { issueNimbusToken } from '@nimbus-sh/sdk/token';
 * const jwt = await issueNimbusToken({ JWT_SECRET: 'hex' }, {
 *   tn: 'acme', sub: 'alice'
 * });
 * ```
 *
 * @example verify in a Worker
 * ```ts
 * import { verifyNimbusToken } from '@nimbus-sh/sdk/token';
 * const { claims, doInstanceName } = await verifyNimbusToken(env, jwt);
 * ```
 */
export { issueNimbusToken, verifyNimbusToken, } from '@nimbus-sh/worker/auth';
export { DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS, ID_COMPONENT_RE, } from '@nimbus-sh/worker/auth';
