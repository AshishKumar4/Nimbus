# @nimbus-sh/sdk

SDK for Nimbus — Worker embedder, programmatic sandbox handles,
token mint/verify, typed errors, and session URL helpers.

## Install

```bash
npm install @nimbus-sh/sdk @nimbus-sh/worker @nimbus-sh/config
```

Use `@nimbus-sh/sdk/worker` as the public Worker embedder entrypoint.
`@nimbus-sh/worker` is still installed because it carries the runtime assets
and Durable Object implementation, but application code imports the
deploy-time API through the SDK.

Create a deployable Nimbus Worker:

```bash
npx create-nimbus-app my-nimbus-worker
cd my-nimbus-worker
npm install
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus-worker
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

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

## Programmatic sandbox quickstart

The same sandbox handle API works in two modes:

- `Nimbus.fromEnv(env, config)` for a Worker or Durable Object with the
  `NIMBUS_SESSION` binding.
- `Nimbus.connect({ endpoint, token, config })` for any backend that can reach
  a deployed Nimbus Worker.

```ts
import { Nimbus } from '@nimbus-sh/sdk';
import { defineNimbusConfig } from '@nimbus-sh/config';

const nimbusConfig = defineNimbusConfig({
  sandboxes: {
    default: {
      root: '/home/user',
      tools: { namespace: 'sandbox', kind: 'sandbox' },
      runtimes: {
        preinstall: ['python', 'clang'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
    },
  },
});

export default {
  async fetch(_request: Request, env: Env) {
    const box = Nimbus.fromEnv(env, nimbusConfig).sandbox('job-123', {
      tenant: 'acme',
      subject: 'agent',
    });

    await box.files.write('/home/user/app/main.py', 'print(2 + 2)\n');
    await box.runtimes.ensure('python');
    const result = await box.exec('python /home/user/app/main.py');

    return Response.json(result);
  },
};
```

Remote use:

```ts
import { Nimbus, issueNimbusToken } from '@nimbus-sh/sdk';

const token = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'agent',
  scopes: ['sandbox:use'],
  sid: 'job-123',
});

const box = Nimbus.connect({
  endpoint: 'https://my-nimbus.workers.dev',
  token,
  config: nimbusConfig,
}).sandbox('job-123');

const result = await box.exec('python -c "print(2 + 2)"');
```

Enable the remote API in the Nimbus Worker:

```ts
export default createNimbusHandler({
  sdk: {
    remote: true,
    config: nimbusConfig,
  },
});
```

`Nimbus.connect()` calls the versioned `/api/nimbus/v1` API internally. The
Worker verifies the JWT, enforces `sid` pins and `sandbox:use` scope, applies
the configured runtime policy, and delegates to the same `NimbusSession` RPC
methods used by `Nimbus.fromEnv()`.

## Sandbox handle API

```ts
const nimbus = Nimbus.fromEnv(env, config, { binding: 'NIMBUS_SESSION' });
// or:
const nimbus = Nimbus.connect({ endpoint, token, config });

const box = nimbus.sandbox('session-or-job-id', {
  profile: 'default',
  tenant: 'acme',
  subject: 'agent-7',
  root: '/home/user',
});

await box.ready();
await box.exec('node -e "console.log(2 + 2)"');
await box.startProcess('node --watch /home/user/app/server.js');
await box.runCode('print(2 + 2)', { language: 'python', install: 'ifMissing' });

await box.files.write('/home/user/app/a.txt', 'hello');
await box.files.read('/home/user/app/a.txt');
await box.files.list('/home/user/app');
await box.files.delete('/home/user/app/a.txt');

await box.runtimes.available();
await box.runtimes.installed();
await box.runtimes.install('python');
await box.runtimes.ensure(['python', 'clang']);

await box.processes.list();
await box.processes.logs(7);
await box.processes.kill(7);

const port = await box.ports.expose(3000);
// port.url => https://my-nimbus.workers.dev/s/<session-or-job-id>/port/3000/
await box.ports.unexpose(3000);
```

Runtime policy comes from the sandbox profile:

- `runtimes.preinstall` is applied by `box.ready()`.
- `runtimes.allow` gates SDK runtime operations and `runCode()` language use.
- `runtimes.onDemand: false` blocks installing runtimes that are not listed
  in `preinstall`.

## Proteus-style tools

`box.tools({ namespace: 'sandbox', kind: 'sandbox' })` returns a provider-like
object with `tools.exec.execute`, `runCode`, `readFile`, `writeFile`,
`listFiles`/`readdir`, `deleteFile`, `exists`, `startProcess`, `killProcess`,
`logs`, `exposePort`, `unexposePort`, `listPorts`, `installRuntime`, and
`listRuntimes`.

`provider.capabilities` is intentionally honest: Nimbus claims shell,
JavaScript/TypeScript, npm, git, owned filesystem, outbound fetch, inbound
HTTP-like port routing, process spawn/long-running processes, Python/Ruby
when allowed, and clang as WASI-native. It does not claim Docker, apt, GPU,
custom Linux images, native Linux ELF execution, or raw TCP listeners.

## Quickstart — mint a session token

```ts
import { issueNimbusToken } from '@nimbus-sh/sdk/token';

const token = await issueNimbusToken(
  { JWT_SECRET: process.env.JWT_SECRET! },
  { tn: 'acme', sub: 'alice' },
  { ttlMs: 60 * 60 * 1000 },  // 1h
);
// → 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6Im5pbWJ1cyIsInRu...'
```

## Verify a token (typically in a Worker)

```ts
import { verifyNimbusToken } from '@nimbus-sh/sdk/token';

try {
  const { claims, doInstanceName } = await verifyNimbusToken(env, token);
  // claims.tn, claims.sub, claims.scopes, claims.sid
  // doInstanceName = `${tn}:${sub || '_'}` — feed to idFromName
} catch (e) {
  // every error extends NimbusAuthError with stable .code + .httpStatus
}
```

## Typed errors

```ts
import {
  NimbusAuthError,
  NimbusTokenExpiredError,
  NimbusScopeError,
} from '@nimbus-sh/sdk/errors';

try { await verifyNimbusToken(env, token); }
catch (e) {
  if (e instanceof NimbusTokenExpiredError) return Response.json({ refresh: true }, { status: 401 });
  if (e instanceof NimbusScopeError)        return Response.json({ scope: e.requiredScope }, { status: 403 });
  if (e instanceof NimbusAuthError)         return Response.json({ error: e.message, code: e.code }, { status: e.httpStatus });
  throw e;
}
```

| Error class | code | httpStatus |
|---|---|---|
| `NimbusAuthConfigError` | `E_AUTH_CONFIG_MISSING` | 500 |
| `NimbusTokenMalformedError` | `E_TOKEN_MALFORMED` | 401 |
| `NimbusTokenSignatureError` | `E_TOKEN_SIGNATURE` | 401 |
| `NimbusTokenClaimsError` | `E_TOKEN_CLAIMS` | 401 |
| `NimbusTokenExpiredError` | `E_TOKEN_EXPIRED` | 401 |
| `NimbusTokenTtlError` | `E_TOKEN_TTL_TOO_LARGE` | 400 |
| `NimbusScopeError` | `E_SCOPE_MISSING` | 403 |
| `NimbusSessionPinError` | `E_SESSION_PIN_MISMATCH` | 403 |

## Session URL helpers

```ts
import { sessionAttachUrl, mintAndAttach } from '@nimbus-sh/sdk';

const url = sessionAttachUrl(
  'https://my-nimbus.workers.dev',
  'pretty-otter-1234',
  token,
);
// → "https://my-nimbus.workers.dev/s/pretty-otter-1234/?nimbus_token=…"

// Or combined in one call:
const { token, url } = await mintAndAttach(
  env,
  { tn: 'acme', sub: 'alice' },
  { endpoint: 'https://my-nimbus.workers.dev', sessionId: 'pretty-otter-1234' },
);
```

## Subpath exports

| Subpath | What |
|---|---|
| `@nimbus-sh/sdk` | Everything re-exported from a single entry. |
| `@nimbus-sh/sdk/token` | `issueNimbusToken`, `verifyNimbusToken`, types. |
| `@nimbus-sh/sdk/errors` | `NimbusAuthError` class hierarchy. |
| `@nimbus-sh/sdk/session` | `sessionAttachUrl`, `mintAndAttach`. |
| `@nimbus-sh/sdk/sandbox` | `Nimbus`, `NimbusSandbox`, programmatic exec/files/runtimes/processes/ports/tools. |
| `@nimbus-sh/sdk/worker` | Worker embedder entrypoint: `NimbusSession`, RPC classes, `createNimbusHandler`, auth helpers. |

## Token wire format

JWT (HS256) with these claims:

```ts
{
  scope: 'nimbus',           // always — discriminator vs other JWTs
  tn:    'acme',             // tenant (required)
  sub?:  'alice',            // user within tenant (optional)
  scopes?: ['session:create','session:attach'],  // capability list
  sid?:  'pretty-otter-1234', // pin to a specific session (optional)
  iat:   1731612345,         // issued-at (UNIX seconds)
  exp:   1731615945,         // expires-at (UNIX seconds)
}
```

Both `tn` and `sub` must match `[A-Za-z0-9._-]{1,128}` — exported as
`ID_COMPONENT_RE` if you need to validate user input.

The `scope` discriminator means a token minted for another product
(e.g. Mossaic VFS, `scope: "vfs"`) is rejected even when signed with
the same secret.

## Secret rotation

Set `JWT_SECRET_PREVIOUS` during a rotation window. Both old and new
secrets verify; new tokens are always signed with the primary.

```bash
# Phase 1: New secret in place, old secret as fallback.
wrangler secret put JWT_SECRET           # the new one
wrangler secret put JWT_SECRET_PREVIOUS  # the old one

# Phase 2 (after the longest token TTL has elapsed):
wrangler secret delete JWT_SECRET_PREVIOUS
```

MIT.
