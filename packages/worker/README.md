# @nimbus-sh/worker

The Nimbus runtime — Durable Object + router + facet machinery — packaged
for embedding in any Cloudflare Workers project.

## Install

```bash
npm install @nimbus-sh/worker
# or
bun add @nimbus-sh/worker
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
} from '@nimbus-sh/worker';

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

export default createNimbusHandler();
```

`wrangler.jsonc` (use `@nimbus-sh/config` to generate, or copy from
`@nimbus-sh/worker/templates/wrangler.jsonc`):

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
    "run_worker_first": ["/s/*", "/new"]
  },
  "alias": {
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
wrangler secret put JWT_SECRET     # 32+ hex chars
wrangler deploy
```

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
}
```

### Custom routes

Routes that return non-`null` short-circuit Nimbus's router. Use them
for a token-mint endpoint, `/healthz`, etc.

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
| `@nimbus-sh/worker` | `NimbusSession`, `SupervisorRPC` + other RPC classes, `createNimbusHandler`, auth types. |
| `@nimbus-sh/worker/router` | `createNimbusHandler`, hooks types. |
| `@nimbus-sh/worker/auth` | HS256 JWT issue/verify, typed errors. |
| `@nimbus-sh/worker/templates/wrangler.jsonc` | Canonical embedder template. |

## Required bindings

Every binding is load-bearing — see `@nimbus-sh/worker/templates/wrangler.jsonc`
for the canonical set:

- `NIMBUS_SESSION` (Durable Object) — per-session SQLite state
- `LOADER` (Worker Loader) — dynamic-isolate spawning for npm + vite + facets
- `NPM_TARBALL_CACHE` + `NPM_PACKUMENT_CACHE` + `NIMBUS_RUNTIME_CACHE` (R2)
- `ASSETS` — serves the xterm shell + lazy-loaded WASM/JS blobs
- `JWT_SECRET` (secret) — HS256 signing key

## Status

v0.1 — first public release. SemVer not yet stable; expect breaking
changes through v0.x. Issues + PRs welcome.

MIT. © Ashish Kumar Singh + contributors.
