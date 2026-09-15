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
  NimbusPublicDirectory,
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
  NimbusPublicDirectory,
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
const EMBEDDER_WORKER_RE = /^\/api\/embedder\/([A-Za-z0-9._-]+)\/spawn-worker$/;

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'DELETE') {
      const match = SESSION_DELETE_RE.exec(new URL(request.url).pathname);
      if (match) return destroySession(request, env, match[1]);
    }
    if (request.method === 'POST') {
      const match = EMBEDDER_WORKER_RE.exec(new URL(request.url).pathname);
      if (match) return spawnEmbedderWorker(request, env, match[1]);
    }
    return nimbus.fetch(request, env, ctx);
  },
};

/**
 * POST /api/embedder/<id>/spawn-worker — what a colocated embedder does with
 * the session's programmatic `spawnWorker`, driven from outside so the
 * behavioral suite can observe it: a Worker-class program whose main module
 * is `runner.js` and whose `lib.js` is a content-addressed text module read
 * from the session filesystem by path, booted as a resident process; a
 * request through the returned facet; the pid killed; the facet dead after.
 * Requires a `sandbox:use` token pinned (or unpinned) to the session.
 */
async function spawnEmbedderWorker(request: Request, env: any, sessionId: string): Promise<Response> {
  try {
    const verified = await verifyRequestToken(request, env);
    if (!verified) return authRequiredResponse();
    requireScopes(verified, ['sandbox:use']);
    requireSessionPin(verified, sessionId);
    const tenant = verified.claims.tn;
    const subject = verified.claims.sub ?? '_';
    const box = Nimbus.fromEnv(env).sandbox(sessionId, { tenant, subject });
    await box.ready();

    // The text module lives on the session disk under its own digest — the
    // shape the loader verifies on read.
    const lib = 'export const answer = "forty-two";\n';
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lib))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const libPath = `/home/user/${digest}.js`;
    await box.files.write(libPath, lib);

    const runner = [
      'import { DurableObject } from "cloudflare:workers";',
      'import { answer } from "./lib.js";',
      'export class NimbusProcess extends DurableObject {',
      '  async startProcess() { return { ok: true, main: "runner.js", answer }; }',
      '  async fetch(req) { return this.handleHttpRequest(req); }',
      '  async handleHttpRequest(req) {',
      '    return Response.json({ main: "runner.js", answer, path: new URL(req.url).pathname });',
      '  }',
      '}',
    ].join('\n');

    // The same DO the SDK addresses, reached directly for the RPC the SDK's
    // remote surface does not carry.
    const stub = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(`${tenant}:${subject}:${sessionId}`));
    const spawned = await stub._rpcSpawnWorker(runner, 'embedder worker', '/home/user', {
      mainModule: 'runner.js',
      vfsTextModules: { 'lib.js': libPath },
    });
    const first = await spawned.facet.fetch(new Request('http://worker.local/hello?via=facet'));
    const firstBody = await first.json();
    const killed = await stub._rpcKillProcess(spawned.pid);
    let afterKill: { status: number } | { error: string };
    try {
      const second = await spawned.facet.fetch(new Request('http://worker.local/after-kill'));
      afterKill = { status: second.status };
    } catch (e) {
      afterKill = { error: e instanceof Error ? e.message : String(e) };
    }
    return Response.json(
      { pid: spawned.pid, boot: spawned.boot, first: { status: first.status, body: firstBody }, killed, afterKill, libPath },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof NimbusAuthError) return authErrorResponse(e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

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
