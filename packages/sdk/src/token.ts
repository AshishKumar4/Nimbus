/**
 * @nimbus-sh/sdk/token — JWT mint + verify, re-exported from the worker
 * auth module.
 *
 * Why a re-export and not a copy? The auth module is the single source
 * of truth — both Worker (verify) and SDK (mint) call the same code
 * paths so wire-format drift is structurally impossible. The
 * `@nimbus-sh/worker` peer-dependency is OPTIONAL (declared in
 * package.json#peerDependenciesMeta); consumers who only mint tokens
 * outside a Worker can install just `@nimbus-sh/sdk` and the
 * worker peer-dep is tree-shaken to its auth subpath.
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

export {
  issueNimbusToken,
  verifyNimbusToken,
  type NimbusAuthEnv,
} from '@nimbus-sh/worker/auth';

export {
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  ID_COMPONENT_RE,
  type NimbusTokenClaims,
  type VerifiedNimbusToken,
  type IssueTokenOptions,
} from '@nimbus-sh/worker/auth';
