# @nimbus-sh/sdk

Environment-agnostic SDK for Nimbus — token mint/verify, typed errors,
session-handle helpers. Safe to import from any JS runtime: workerd,
Node, Bun, browsers.

## Install

```bash
npm install @nimbus-sh/sdk
```

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
