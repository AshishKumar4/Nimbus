/**
 * apps/probe/src/index.ts — authenticated behavioral-probe target.
 *
 * A minimal Nimbus embedder with JWT auth enforced and the remote SDK
 * API enabled. CI and local behavioral runs point BASE at this Worker
 * so the public hosted demo can stay behind interactive Cloudflare
 * login. Aside from `DELETE /s/<id>/` cleanup, this is exactly the
 * shape a third-party embedder ships.
 *
 * The class re-exports let wrangler and `enable_ctx_exports` discover
 * the DO/RPC classes from the main module — see apps/hosted-demo.
 */
import {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
  createNimbusHandler,
} from '@nimbus-sh/sdk/worker';
import { Nimbus } from '@nimbus-sh/sdk';
import {
  verifyRequestToken,
  requireScopes,
  requireSessionPin,
  authErrorResponse,
  NimbusAuthError,
} from '@nimbus-sh/worker/auth';

export {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
};

const nimbus = createNimbusHandler({
  auth: { mode: 'enforce' },
  sdk: { remote: true },
});

const SESSION_DELETE_RE = /^\/s\/([A-Za-z0-9._-]+)\/?$/;

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'DELETE') {
      const match = SESSION_DELETE_RE.exec(new URL(request.url).pathname);
      if (match) return destroySession(request, env, match[1]);
    }
    return nimbus.fetch(request, env, ctx);
  },
};

/**
 * DELETE /s/<id>/ — destroy the backing sandbox so probes can clean up
 * after themselves. Requires a `session:destroy` token. Tenant and
 * subject come from the verified claims, so the DO addressed is exactly
 * the one the token's sessions live under
 * (`${tn}:${sub ?? '_'}:${sessionId}`).
 */
async function destroySession(request: Request, env: any, sessionId: string): Promise<Response> {
  try {
    const verified = await verifyRequestToken(request, env);
    if (!verified) return authRequiredResponse();
    requireScopes(verified, ['session:destroy']);
    requireSessionPin(verified, sessionId);
    const result = await Nimbus.fromEnv(env)
      .sandbox(sessionId, {
        tenant: verified.claims.tn,
        subject: verified.claims.sub ?? '_',
      })
      .destroy();
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof NimbusAuthError) return authErrorResponse(e);
    throw e;
  }
}

function authRequiredResponse(): Response {
  return Response.json(
    { error: 'Authentication required', code: 'E_TOKEN_REQUIRED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
