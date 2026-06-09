/**
 * apps/hosted-demo/src/index.ts — Nimbus live-demo embedder.
 *
 * This file is the live demo at https://nimbus.ashishkumarsingh.com
 * and the canonical reference embedder for `@nimbus-sh/sdk/worker`.
 * It also mounts SDK smoke routes that prove the deployed app can use
 * Nimbus through the same SDK surface external applications use.
 *
 * Why re-export the RPC classes? Cloudflare's `enable_ctx_exports`
 * feature (default at compat-date ≥ 2026-04-01) walks the *main
 * module's* exports to find DO + RPC classes. Nimbus uses these
 * classes internally for loopback bindings (env.SUPERVISOR,
 * env.ASSETS-via-RPC, etc.). Without the re-export, the runtime can't
 * find them and child facets get `env.SUPERVISOR === undefined`.
 *
 * The convenience: `@nimbus-sh/sdk/worker` re-exports every required
 * class by name, so an `export { ... } from '@nimbus-sh/sdk/worker'`
 * does the whole job.
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
import { Nimbus, type NimbusConfig } from '@nimbus-sh/sdk';
import {
  completeDemoLogin,
  demoAuthRequiredResponse,
  loadDemoAuth,
  logoutDemo,
  shouldHandleDemoOAuthCallback,
  startDemoLogin,
  type DemoAuth,
} from './demo-auth.js';
import { createDemoAgentAuthCookie } from './demo-agent-auth.js';
import { cleanupExpiredDemoSessions } from './demo-cleanup.js';
import { issueDemoSandboxToken, withInternalNimbusAuth } from './demo-nimbus.js';
import {
  createDemoSession,
  loadOwnedDemoSession,
  markDemoSessionDestroyed,
  markDemoSessionDestroyFailed,
  renderExpiredSession,
  renderForbiddenSession,
  renderLaunchPage,
  sessionIdFromPath,
  touchDemoSession,
  type DemoSession,
} from './demo-sessions.js';

// Re-export the DO class + every RPC class so wrangler discovers them
// for `durable_objects.bindings[].class_name` and `enable_ctx_exports`
// auto-populates loopback bindings.
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

const sandboxConfig = {
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: { onDemand: true },
    },
  },
} satisfies NimbusConfig;

const nimbus = createNimbusHandler({
  auth: { mode: 'enforce' },
  sdk: {
    remote: true,
    config: sandboxConfig,
  },
});

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return handleHostedDemoRequest(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: any, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cleanupExpiredDemoSessions(env, sandboxConfig)
        .then((result) => console.log('[nimbus/demo-cleanup]', JSON.stringify(result)))
        .catch((e) => console.error('[nimbus/demo-cleanup] failed:', e?.stack || e)),
    );
  },
};

async function handleHostedDemoRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/login') return startDemoLogin(request, env);
  if (url.pathname === '/logout') return logoutDemo(request);
  if (url.pathname === '/api/demo/oauth/callback') return completeDemoLogin(request, env);
  if (url.pathname === '/api/nimbus/oauth/callback' && await shouldHandleDemoOAuthCallback(request, env)) {
    return completeDemoLogin(request, env);
  }
  if (url.pathname === '/api/demo/auth/me') return handleDemoAuthMe(request, env);
  if (url.pathname === '/new') return handleNew(request, env);
  if (url.pathname === '/api/sdk-smoke') return handleSdkSmoke(request, env);
  if (url.pathname === '/api/sdk-remote-smoke') return handleSdkRemoteSmoke(request, env, ctx);

  const sessionId = sessionIdFromPath(url.pathname);
  if (sessionId) return handleSessionRequest(request, env, ctx, sessionId);

  return nimbus.fetch(request, env, ctx);
}

async function handleNew(request: Request, env: any): Promise<Response> {
  const auth = await loadDemoAuth(request, env);
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (url.searchParams.get('launch') === '1') {
      if (!auth) return demoAuthRequiredResponse(request, '/new?launch=1');
      const session = await createDemoSession(env, auth);
      return launchRedirectResponse(env, auth, session.sessionId);
    }
    return renderLaunchPage(auth);
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' },
    });
  }
  if (!auth) return demoAuthRequiredResponse(request, '/new');
  const session = await createDemoSession(env, auth);
  return launchRedirectResponse(env, auth, session.sessionId);
}

async function launchRedirectResponse(env: any, auth: DemoAuth, sessionId: string): Promise<Response> {
  const headers = new Headers({
    Location: `/s/${encodeURIComponent(sessionId)}/`,
    'Cache-Control': 'no-store',
  });
  const agentCookie = await createDemoAgentAuthCookie(env, auth, sessionId);
  if (agentCookie) headers.append('Set-Cookie', agentCookie);
  return new Response(null, { status: 303, headers });
}

async function handleDemoAuthMe(request: Request, env: any): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }
  const auth = await loadDemoAuth(request, env);
  return Response.json({
    authenticated: !!auth,
    user: auth
      ? {
        id: auth.userId,
        displayName: auth.displayName,
      }
      : null,
  }, {
    status: auth ? 200 : 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function handleSessionRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const auth = await loadDemoAuth(request, env);
  if (!auth) return demoAuthRequiredResponse(request, `/s/${sessionId}/`);

  const session = await loadOwnedDemoSession(env, sessionId, auth);
  if (!session) return renderForbiddenSession();
  if (request.method === 'DELETE') {
    return destroyOwnedDemoSession(request, env, auth, session);
  }
  if (session.status !== 'active' || session.expiresAt <= Date.now()) {
    return renderExpiredSession(sessionId);
  }

  ctx.waitUntil(touchDemoSession(env, session));
  const authorized = await withInternalNimbusAuth(request, env, auth, sessionId);
  return nimbus.fetch(authorized, env, ctx);
}

async function destroyOwnedDemoSession(
  request: Request,
  env: any,
  auth: DemoAuth,
  session: DemoSession,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== `/s/${session.sessionId}` && url.pathname !== `/s/${session.sessionId}/`) {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, DELETE', 'Cache-Control': 'no-store' },
    });
  }
  if (session.status === 'destroyed') {
    return Response.json({ ok: true, sessionId: session.sessionId, status: 'destroyed' }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const box = Nimbus.fromEnv(env, sandboxConfig).sandbox(session.sessionId, {
    tenant: 'demo',
    subject: auth.userId,
  });
  try {
    const result = await box.destroy({ reason: 'demo-user-delete' });
    await markDemoSessionDestroyed(env, session.sessionId, 'demo-user-delete');
    return Response.json({ ok: true, sessionId: session.sessionId, result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await markDemoSessionDestroyFailed(env, session.sessionId, message);
    return Response.json({
      ok: false,
      sessionId: session.sessionId,
      error: message,
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

async function handleSdkSmoke(request: Request, env: any): Promise<Response> {
  const auth = await requireDemoAuth(request, env);
  if (auth instanceof Response) return auth;
  const session = await createDemoSession(env, auth, `sdk-smoke-${Date.now()}`);
  const box = Nimbus.fromEnv(
    env,
    {
      ...sandboxConfig,
      endpoint: new URL(request.url).origin,
    },
  ).sandbox(session.sessionId, {
    tenant: 'demo',
    subject: auth.userId,
  });

  try {
    const result = await box.exec('node -e "console.log(2 + 2)"');
    await box.destroy({ reason: 'sdk-smoke-complete' });
    await markDemoSessionDestroyed(env, session.sessionId, 'sdk-smoke-complete');
    return Response.json({
      ok: result.success && result.stdout.trim() === '4',
      result,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    try { await box.destroy({ reason: 'sdk-smoke-error' }); } catch {}
    await markDemoSessionDestroyFailed(env, session.sessionId, e?.message || String(e));
    throw e;
  }
}

async function handleSdkRemoteSmoke(
  request: Request,
  env: any,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await requireDemoAuth(request, env);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const session = await createDemoSession(env, auth, `sdk-remote-smoke-${Date.now()}`);
  const token = await issueDemoSandboxToken(env, auth, session.sessionId, ['sandbox:use']);
  const remoteBox = Nimbus.connect({
    endpoint: url.origin,
    token,
    fetch: (input, init) => {
      const loopbackRequest = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return nimbus.fetch(loopbackRequest, env, ctx);
    },
    config: {
      ...sandboxConfig,
      endpoint: url.origin,
    },
  }).sandbox(session.sessionId);
  const localBox = Nimbus.fromEnv(env, sandboxConfig).sandbox(session.sessionId, {
    tenant: 'demo',
    subject: auth.userId,
  });

  try {
    await remoteBox.files.write('/home/user/remote-bytes.bin', new Uint8Array([0, 1, 2, 255]));
    const bytes = await remoteBox.files.readBytes('/home/user/remote-bytes.bin');
    const result = await remoteBox.exec('node -e "console.log(3 + 4)"');
    await localBox.destroy({ reason: 'sdk-remote-smoke-complete' });
    await markDemoSessionDestroyed(env, session.sessionId, 'sdk-remote-smoke-complete');

    return Response.json({
      ok: result.success
        && result.stdout.trim() === '7'
        && bytes instanceof Uint8Array
        && bytes.length === 4
        && bytes[3] === 255,
      result,
      bytes: Array.from(bytes ?? []),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    try { await localBox.destroy({ reason: 'sdk-remote-smoke-error' }); } catch {}
    await markDemoSessionDestroyFailed(env, session.sessionId, e?.message || String(e));
    throw e;
  }
}

async function requireDemoAuth(request: Request, env: any): Promise<DemoAuth | Response> {
  const auth = await loadDemoAuth(request, env);
  if (auth) return auth;
  return demoAuthRequiredResponse(request, new URL(request.url).pathname);
}
