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
  issueNimbusToken,
} from '@nimbus-sh/sdk/worker';
import { Nimbus } from '@nimbus-sh/sdk';

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
};

const handler = createNimbusHandler({
  auth: { mode: 'legacy' },
  sdk: {
    remote: true,
    config: sandboxConfig,
  },
  routes: async (request, env, ctx) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/sdk-smoke') {
      const nimbus = Nimbus.fromEnv(
        env,
        {
          ...sandboxConfig,
          endpoint: url.origin,
        },
      );
      const box = nimbus.sandbox(`sdk-smoke-${Date.now()}`, {
        tenant: 'hosted-demo',
        subject: 'sdk-smoke',
      });
      const result = await box.exec('node -e "console.log(2 + 2)"');
      return Response.json({
        ok: result.success && result.stdout.trim() === '4',
        result,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/sdk-remote-smoke') {
      const sandboxId = `sdk-remote-smoke-${Date.now()}`;
      const token = await issueNimbusToken(
        env,
        {
          tn: 'hosted-demo',
          sub: 'sdk-remote-smoke',
          scopes: ['sandbox:use'],
          sid: sandboxId,
        },
        { ttlMs: 5 * 60 * 1000 },
      );
      const box = Nimbus.connect({
        endpoint: url.origin,
        token,
        fetch: (input, init) => {
          const loopbackRequest = input instanceof Request
            ? new Request(input, init)
            : new Request(input, init);
          return handler.fetch(loopbackRequest, env, ctx);
        },
        config: {
          ...sandboxConfig,
          endpoint: url.origin,
        },
      }).sandbox(sandboxId);

      await box.files.write('/home/user/remote-bytes.bin', new Uint8Array([0, 1, 2, 255]));
      const bytes = await box.files.readBytes('/home/user/remote-bytes.bin');
      const result = await box.exec('node -e "console.log(3 + 4)"');

      return Response.json({
        ok: result.success
          && result.stdout.trim() === '7'
          && bytes instanceof Uint8Array
          && bytes.length === 4
          && bytes[3] === 255,
        result,
        bytes: Array.from(bytes ?? []),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return null;
  },
});

export default handler;
