/**
 * @nimbus-sh/sdk — Client SDK for Nimbus.
 *
 * The SDK is the **environment-agnostic** half of Nimbus: token mint /
 * verify, typed errors, session-handle types, and the HTTP fallback for
 * non-Worker consumers. Everything in this package is safe to import
 * from a Node SSR layer, a Worker, an Edge function, or a browser
 * build.
 *
 * For the Worker runtime itself (the Durable Object, the router, the
 * facet machinery), see `@nimbus-sh/worker`.
 *
 * @example mint a token in your Worker's `/api/auth/mint` route
 * ```ts
 * import { issueNimbusToken } from '@nimbus-sh/sdk/token';
 * export default {
 *   async fetch(req: Request, env: Env) {
 *     const { tenant, sub } = await req.json();
 *     const token = await issueNimbusToken(env, { tn: tenant, sub });
 *     return Response.json({ token });
 *   },
 * };
 * ```
 */

export * from './token.js';
export * from './errors.js';
export * from './session.js';
