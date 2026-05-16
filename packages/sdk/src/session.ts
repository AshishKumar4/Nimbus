/**
 * @nimbus-sh/sdk/session — High-level session handle helpers.
 *
 * Useful for embedders who want to compute a session URL ahead of time
 * (e.g. for sharing) or attach to a known session ID. The helpers in
 * this module are pure URL/token plumbing; no network calls.
 */

import { issueNimbusToken, type NimbusAuthEnv } from '@nimbus-sh/worker/auth';
import type { IssueTokenOptions } from '@nimbus-sh/worker/auth';

/**
 * Compute the canonical attach URL for a session. The returned URL
 * embeds the token in the `?nimbus_token=` query so an `<iframe src>`
 * can carry it without custom headers.
 *
 * @param endpoint Base URL of the Nimbus deploy (e.g. `https://my.workers.dev`).
 *                 No trailing slash required.
 * @param sessionId Session ID (e.g. `pretty-otter-1234`).
 * @param token Verified Nimbus JWT.
 * @returns Fully-qualified URL: `${endpoint}/s/${sessionId}/?nimbus_token=${token}`.
 *
 * @example
 * ```ts
 * import { sessionAttachUrl, issueNimbusToken } from '@nimbus-sh/sdk';
 * const token = await issueNimbusToken(env, { tn: 'acme', sub: 'alice' });
 * const url = sessionAttachUrl('https://my-nimbus.workers.dev', 'pretty-otter-1234', token);
 * // → "https://my-nimbus.workers.dev/s/pretty-otter-1234/?nimbus_token=eyJ…"
 * ```
 */
export function sessionAttachUrl(
  endpoint: string,
  sessionId: string,
  token: string,
): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/s/${sessionId}/?nimbus_token=${encodeURIComponent(token)}`;
}

/**
 * Convenience: mint a token AND build the attach URL in one call.
 *
 * @param env Env with `JWT_SECRET` (and optionally `JWT_SECRET_PREVIOUS`).
 * @param input Token claims minus iat/exp/scope.
 * @param opts Mint options ({@link IssueTokenOptions}) plus endpoint + sessionId.
 *
 * @example
 * ```ts
 * const { token, url } = await mintAndAttach(env,
 *   { tn: 'acme', sub: 'alice' },
 *   { endpoint: 'https://my-nimbus.workers.dev', sessionId: 'pretty-otter-1234' });
 * ```
 */
export async function mintAndAttach(
  env: NimbusAuthEnv,
  input: { tn: string; sub?: string; scopes?: string[]; sid?: string },
  opts: IssueTokenOptions & { endpoint: string; sessionId: string },
): Promise<{ token: string; url: string }> {
  const token = await issueNimbusToken(env, input, opts);
  const url = sessionAttachUrl(opts.endpoint, opts.sessionId, token);
  return { token, url };
}
