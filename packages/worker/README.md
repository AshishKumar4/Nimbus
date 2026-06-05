# @nimbus-sh/worker

The Nimbus runtime package: Durable Object, router, assets, VFS, runtime
manager, and facet machinery.

Application code should import the deploy-time API through
`@nimbus-sh/sdk/worker`. This package is still installed because it carries
the runtime implementation and static assets used by the SDK entrypoint.

## Install

```bash
npm install @nimbus-sh/sdk @nimbus-sh/worker @nimbus-sh/config
# or
bun add @nimbus-sh/sdk @nimbus-sh/worker @nimbus-sh/config
```

## Quickstart

`src/index.ts`:

```ts
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
import { defineNimbusConfig } from '@nimbus-sh/config';

// Re-export the DO + every RPC class so wrangler's `class_name` lookup +
// `enable_ctx_exports` find them in your Worker's main-module exports.
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

const nimbusConfig = defineNimbusConfig({
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: { preinstall: ['python'], onDemand: true },
      tools: { namespace: 'sandbox', kind: 'sandbox' },
    },
  },
});

export default createNimbusHandler({
  sdk: {
    remote: true,
    config: nimbusConfig,
  },
});
```

`wrangler.jsonc` (use `@nimbus-sh/config` to generate, or adapt
`apps/hosted-demo/wrangler.jsonc`):

```jsonc
{
  "name": "my-nimbus",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "placement": { "mode": "smart" },
  "assets": {
    "directory": "node_modules/@nimbus-sh/worker/public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/s/*", "/new"]
  },
  "alias": {
    "@lifo-sh/ui": "./node_modules/@nimbus-sh/worker/dist/stubs/lifo-ui.js",
    "clean-git-ref": "clean-git-ref/lib/index.js",
    "is-git-ref-name-valid": "is-git-ref-name-valid/index.js",
    "crc-32": "crc-32",
    "sha.js": "sha.js",
    "pako": "pako", "pify": "pify", "diff": "diff", "diff3": "diff3",
    "ignore": "ignore", "readable-stream": "readable-stream",
    "simple-get": "simple-get", "minimisted": "minimisted"
  },
  "durable_objects": {
    "bindings": [{ "name": "NIMBUS_SESSION", "class_name": "NimbusSession" }]
  },
  "migrations": [
    { "tag": "nimbus-v1", "new_sqlite_classes": ["NimbusSession"] }
  ],
  "worker_loaders": [{ "binding": "LOADER" }],
  "r2_buckets": [
    { "binding": "NPM_TARBALL_CACHE",    "bucket_name": "my-nimbus-npm-cache" },
    { "binding": "NPM_PACKUMENT_CACHE",  "bucket_name": "my-nimbus-npm-packument-cache" },
    { "binding": "NIMBUS_RUNTIME_CACHE", "bucket_name": "nimbus-runtime-cache-public" }
  ]
}
```

Then:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus
npx wrangler secret put JWT_SECRET     # 32+ hex chars
npx wrangler deploy
```

If setup reports Cloudflare R2 error `10042`, enable R2 in the
Cloudflare Dashboard once for the account, then rerun the setup command.

`JWT_SECRET` is required for token-enforced deployments. Legacy-public
single-tenant demos can set `NIMBUS_LEGACY_PUBLIC=1` and rely on URL
possession instead.

## Composable API

`createNimbusHandler(options)` accepts:

```ts
{
  auth?: { mode?: 'auto' | 'enforce' | 'legacy'; legacyPublic?: boolean };
  hooks?: {
    onSessionStart?: (ctx) => void | Promise<void>;
    onSessionEnd?:   (ctx) => void | Promise<void>;  // reserved v0.2
  };
  routes?: (request, env, ctx) => Response | null | Promise<Response | null>;
  sdk?: {
    remote?: boolean | { enabled?: boolean; basePath?: string; allowLegacy?: boolean };
    config?: NimbusConfig;
  };
}
```

### Custom routes

Routes that return non-`null` short-circuit Nimbus's router. Use them
for a token-mint endpoint, `/healthz`, SDK smoke tests, or backend
sandbox jobs.

```ts
import { issueNimbusToken } from '@nimbus-sh/sdk/token';

export default createNimbusHandler({
  routes: async (req, env) => {
    if (new URL(req.url).pathname === '/api/auth/mint' && req.method === 'POST') {
      const { tenant, sub } = await req.json();
      const token = await issueNimbusToken(env, { tn: tenant, sub });
      return Response.json({ token });
    }
    return null;
  },
});
```

Programmatic sandbox route:

```ts
import { Nimbus } from '@nimbus-sh/sdk';

export default createNimbusHandler({
  routes: async (req, env) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/run-python') {
      const nimbus = Nimbus.fromEnv(env, {
        endpoint: url.origin,
        sandboxes: {
          default: {
            root: '/home/user',
            runtimes: { preinstall: ['python'], onDemand: true },
          },
        },
      });
      const box = nimbus.sandbox('api-job-1', { tenant: 'api', subject: 'python' });
      const result = await box.runCode('print(2 + 2)', {
        language: 'python',
        install: 'ifMissing',
      });
      return Response.json(result);
    }
    return null;
  },
});
```

Remote SDK API:

```ts
export default createNimbusHandler({
  sdk: {
    remote: true,
    config: nimbusConfig,
  },
});
```

Remote calls use `POST /api/nimbus/v1/sandboxes/<id>/rpc` internally.
Applications normally call it through `Nimbus.connect({ endpoint, token,
config })`. The route requires a valid Nimbus JWT and `sandbox:use` scope.

For long-running app servers, start an explicit long-running process and
expose the virtual port:

```ts
await box.files.write('/home/user/app/server.js', serverSource);
await box.startProcess('node --watch /home/user/app/server.js');
const port = await box.ports.expose(3000);
```

### Hooks

```ts
export default createNimbusHandler({
  hooks: {
    onSessionStart: ({ sessionId, tenantSegment, request }) => {
      console.log(`[${tenantSegment}] session ${sessionId} attached from ${request.headers.get('cf-connecting-ip')}`);
    },
  },
});
```

### Auth modes

| Mode | Meaning |
|---|---|
| `'auto'` (default) | Verify token when `JWT_SECRET` is set AND `NIMBUS_LEGACY_PUBLIC` is unset. Otherwise legacy-public. |
| `'enforce'` | Always verify token; fail closed if `JWT_SECRET` is missing. |
| `'legacy'` | Never verify; all requests route to the single `legacy:public:_` tenant. Use only for single-tenant demos. |

## Subpath exports

| Subpath | What |
|---|---|
| `@nimbus-sh/sdk/worker` | Public Worker embedder API: `NimbusSession`, RPC classes, `createNimbusHandler`, auth helpers. |
| `@nimbus-sh/worker` | Runtime implementation package used by the SDK entrypoint. |
| `@nimbus-sh/worker/router` | Runtime router implementation and hook types. |
| `@nimbus-sh/worker/auth` | Runtime auth implementation re-exported by `@nimbus-sh/sdk/token`. |

## Required bindings

Every binding is load-bearing — see `apps/hosted-demo/wrangler.jsonc` or
`@nimbus-sh/config` for the canonical set:

- `NIMBUS_SESSION` (Durable Object) — per-session SQLite state
- `LOADER` (Worker Loader) — dynamic-isolate spawning for npm + vite + facets
- `NPM_TARBALL_CACHE` + `NPM_PACKUMENT_CACHE` + `NIMBUS_RUNTIME_CACHE` (R2)
- `ASSETS` — serves the xterm shell + lazy-loaded WASM/JS blobs
- `JWT_SECRET` (secret) — HS256 signing key for token-enforced deployments

## Status

v0.1 — first public release. SemVer not yet stable; expect breaking
changes through v0.x. Issues + PRs welcome.

MIT. © Ashish Kumar Singh + contributors.
