# @nimbus-sh/sdk

SDK for Nimbus: the Worker embedder, programmatic sandbox handles, token
mint/verify, typed errors, and session URL helpers.

## Install

```bash
npm install @nimbus-sh/sdk @nimbus-sh/worker @nimbus-sh/config
```

Use `@nimbus-sh/sdk/worker` as the public Worker embedder entrypoint.
`@nimbus-sh/worker` is still installed because it carries the runtime assets
and the Durable Object implementation. Application code imports the
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

The bundled session UI includes an Agent surface in the editor workspace.
Configure it with the Worker vars `NIMBUS_CF_OAUTH_CLIENT_ID`,
`NIMBUS_CF_OAUTH_SCOPES`, `NIMBUS_AGENT_MODEL`, and
`NIMBUS_AGENT_GATEWAY_ID`. Add the secret `NIMBUS_AGENT_COOKIE_SECRET` or
`NIMBUS_CLOUDFLARE_API_TOKEN` when you want Cloudflare OAuth or owner-token
Workers AI access. User OAuth uses Authorization Code + PKCE and encrypted
browser cookies. Nimbus does not store user OAuth tokens in Durable Object
storage.

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
Worker verifies the JWT, enforces `sid` pins and `sandbox:use` scope, and
applies the configured runtime policy. It then delegates to the same
`NimbusSession` RPC methods that `Nimbus.fromEnv()` uses.

Sandbox destruction is a separate lifecycle operation. Tokens that call
`box.destroy()` must include `session:destroy` or `session:admin` in addition
to the normal sandbox scope.

## Flue connector

Use `@nimbus-sh/sdk/flue` when an agent runtime expects Flue's sandbox
provider contract:

```ts
import { Nimbus } from '@nimbus-sh/sdk/sandbox';
import { nimbusFlue } from '@nimbus-sh/sdk/flue';

const box = Nimbus.fromEnv(env, nimbusConfig).sandbox('job-123');
await box.ready();

const factory = nimbusFlue(box);
const sessionEnv = await factory.createSessionEnv({
  id: 'job-123',
  cwd: '/home/user',
});

await sessionEnv.writeFile('/home/user/main.py', 'print(2 + 2)\n');
const result = await sessionEnv.exec('python /home/user/main.py');
```

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
const proc = await box.startProcess('node --watch /home/user/app/server.js');
// returns immediately with proc.pid; poll box.processes.logs(proc.pid) for
// output and the exit record, or box.processes.kill(proc.pid) to stop it
await box.runCode('print(2 + 2)', { language: 'python', install: 'ifMissing' });

await box.files.write('/home/user/app/a.txt', 'hello');
await box.files.read('/home/user/app/a.txt');
await box.files.list('/home/user/app');
await box.files.stat('/home/user/app/a.txt');
await box.files.lstat('/home/user/app/link');
await box.files.rename('/home/user/app/a.txt', '/home/user/app/b.txt');
await box.files.chmod('/home/user/app/b.txt', 0o755);
await box.files.readRange('/home/user/app/b.txt', 0, 64);
await box.files.delete('/home/user/app/b.txt');

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

On deployments with a preview host suffix configured (the hosted product sets
`NIMBUS_PREVIEW_HOST_SUFFIX=nimbus-os.dev`), `port.url` takes the hostname
form `https://<port>--<session-id>.<suffix>/` instead. The
`/s/<id>/port/<n>/` path route works on every deployment.

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

`provider.capabilities` reports what Nimbus can do. Nimbus claims shell,
JavaScript/TypeScript, npm, git, owned filesystem, outbound fetch, inbound
HTTP-like port routing, process spawn/long-running processes, Python/Ruby
when allowed, and clang-backed WASI/WebAssembly execution. It does not claim
Docker, apt, GPU, custom Linux images, native Linux ELF execution, or raw TCP
listeners.

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

Both `tn` and `sub` must match `[A-Za-z0-9._-]{1,128}`. The pattern is
exported as `ID_COMPONENT_RE` if you need to validate user input.

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
