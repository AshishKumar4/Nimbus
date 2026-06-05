/**
 * @nimbus-sh/sdk — Public SDK for Nimbus.
 *
 * The SDK is the public surface for Nimbus applications: token mint /
 * verify, typed errors, session-handle helpers, programmatic sandboxes,
 * and the Worker embedder subpath.
 *
 * Import the deployed Worker embedder from `@nimbus-sh/sdk/worker`.
 * The Durable Object, router, assets, VFS, and facet implementation live
 * in `@nimbus-sh/worker` and are re-exported through that public SDK
 * subpath.
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
export * from './sandbox.js';
//# sourceMappingURL=index.d.ts.map