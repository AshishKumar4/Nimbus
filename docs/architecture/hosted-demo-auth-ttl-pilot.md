# Hosted Demo Auth And Idle TTL Pilot

Last refreshed: 2026-07-24

Status: pilot implementation plan. This document describes the code changes
needed before implementation. It is scoped to the hosted demo plus the
Nimbus core hardening the hosted demo depends on.

## Objective

Make the public hosted demo safe to open up without making Nimbus feel capped
or constrained:

- Require Cloudflare login before creating or using hosted-demo sandboxes.
- Keep sandbox creation unlimited for logged-in users.
- Do not add agent step limits or arbitrary session count caps.
- Delete hosted-demo sandboxes only after an idle TTL.
- Keep all demo-specific product policy in `apps/hosted-demo`.
- Harden weak core primitives that the demo needs, especially auth scopes,
  session-pin enforcement, secure destruction, and token handling.

## Non-Goals

- No global rate limiting in the pilot. Rate limits can come later if real
  abuse appears.
- No per-user session count caps.
- No absolute lifetime for actively used sandboxes.
- No Cloudflare OAuth requirement for third-party Nimbus deployments.
- No public share links in the pilot. A share-link feature needs a separate
  token model.
- No persistent storage of Cloudflare OAuth access tokens for demo login.
  Agent OAuth remains a separate flow for user-owned AI access.

## Current Source Of Truth

Relevant current files:

| Area | Source |
|---|---|
| Hosted demo entry | `apps/hosted-demo/src/index.ts` |
| Hosted demo config | `apps/hosted-demo/wrangler.jsonc` |
| Core router/auth gate | `packages/worker/src/router/index.ts` |
| Remote SDK router | `packages/worker/src/router/remote-api.ts` |
| JWT issue/verify | `packages/worker/src/auth/token.ts` |
| Auth helpers | `packages/worker/src/auth/middleware.ts` |
| Auth claim types | `packages/worker/src/auth/types.ts` |
| Session route to DO mapping | `packages/worker/src/_shared/session-router.ts` |
| Session DO RPC delegators | `packages/worker/src/session/nimbus-session.ts` |
| Programmatic session helpers | `packages/worker/src/session/programmatic.ts` |
| SDK sandbox handle | `packages/sdk/src/sandbox.ts` |
| Agent OAuth flow | `packages/worker/src/session/agent.ts` |

Current hosted-demo state:

- `apps/hosted-demo/src/index.ts` uses `createNimbusHandler({ auth: { mode:
  'legacy' } })`, so `/new` and `/s/<id>/...` are anonymous.
- Core session DO naming already supports tenant scoping:
  `${tenantSegment}:${sessionId}`, where `tenantSegment` comes from verified
  Nimbus JWTs when auth is enforced.
- The remote SDK API already checks token scopes and session pinning.
- The browser session route does not currently enforce `session:attach` scope
  or `sid` pinning.
- `auth/middleware.ts` documents `nimbus_token` query-to-cookie behavior, but
  the router does not currently set that cookie.
- The SDK exposes `destroy()` for deleting a whole sandbox and reclaiming DO
  SQLite storage; remote calls require `session:destroy` or `session:admin`.

## Design Principles

1. Demo policy lives in the demo app.

   `apps/hosted-demo` may require Cloudflare login, keep a D1 registry, and
   run cleanup cron jobs. The reusable Nimbus packages should not inherit
   these hosted-demo policies by default.

2. Core security invariants live in core.

   Token scope enforcement, session-pin enforcement, session destruction, and
   auth-token handling are core correctness issues. Do not work around them
   with hosted-demo-only hacks.

3. Browser users should not receive Nimbus JWTs in the hosted demo.

   The hosted demo Worker should authenticate the user and verify sandbox
   ownership. It should then mint a short-lived session-pinned Nimbus JWT
   internally, inject it as an `Authorization` header, and call the Nimbus
   handler. The browser should only hold the demo login cookie.

4. Cloudflare login and agent OAuth are separate.

   Demo login proves the user may use the hosted demo. Agent OAuth proves the
   session agent may call Cloudflare APIs or spend the user's Workers AI quota.
   Do not use the broad agent OAuth scopes for basic demo login.

5. Idle TTL, not absolute TTL.

   A sandbox can live indefinitely if it is used. It is eligible for deletion
   only after `last_seen_at + idle_ttl`.

## Target Request Flow

### Public Landing

`GET /`

- Served as the current landing page.
- No login required.
- The Launch control should submit a POST to `/new`.

### Demo Login

`GET /login?return_to=<path>`

- Starts Cloudflare OAuth for the hosted demo if the user is not logged in.
- Uses PKCE.
- Uses a sealed, HttpOnly, Secure, SameSite=Lax state cookie.
- Requests only the minimum identity scope needed to fetch a stable user id.
- Does not request account list, Workers AI, AI Gateway, or API-token-like
  permissions.

`GET /api/demo/oauth/callback`

- Validates the OAuth `state` parameter against the sealed state cookie.
- Exchanges the authorization code.
- Fetches user info.
- Computes a stable internal user id:

  ```text
  demo_user_id = "cf_" + base64url(sha256(<cloudflare_user_stable_id>))
  ```

- Stores or updates a `demo_users` row.
- Does not persist the Cloudflare OAuth access token or refresh token.
- Sets a sealed demo auth cookie:

  ```text
  __Host-nimbus_demo_auth
  HttpOnly
  Secure
  SameSite=Lax
  Path=/
  Max-Age=<DEMO_AUTH_COOKIE_DAYS>
  ```

- Redirects to the original `return_to`, or `/new` if login was initiated by
  Launch.

### Session Creation

`POST /new`

- Requires a valid demo auth cookie.
- If unauthenticated, redirects to `/login?return_to=/new`.
- Generates a session id.
- Inserts a `demo_sessions` row owned by the logged-in user.
- Redirects to `/s/<sessionId>/`.
- Does not put a Nimbus JWT in the URL.
- Does not set `nimbus_token`.

`GET /new`

- Should not create a sandbox. It may render a tiny launch page or redirect to
  `/` to avoid state-changing GET behavior.

### Session Access

`/s/<sessionId>/*`

The hosted-demo wrapper handles this before calling Nimbus:

1. Verify the demo auth cookie.
2. Lookup `demo_sessions.session_id`.
3. Require `status = "active"`.
4. Require `user_id` matches the logged-in demo user.
5. If expired, return an expired-session page and do not forward to Nimbus.
6. Touch `last_seen_at` and `expires_at` using debounce.
7. Mint a short-lived, session-pinned Nimbus JWT internally:

   ```ts
   await issueNimbusToken(
     env,
     {
       tn: 'demo',
       sub: demoUserId,
       sid: sessionId,
       scopes: ['session:attach', 'sandbox:use'],
     },
     { ttlMs: DEMO_NIMBUS_JWT_TTL_MS },
   )
   ```

8. Clone the inbound request and inject:

   ```text
   Authorization: Bearer <internal Nimbus JWT>
   ```

9. Call the core Nimbus handler configured with `auth: { mode: 'enforce' }`.

The injected JWT is generated per request or per short cache window inside the
Worker. It is never exposed to client-side JavaScript, URLs, localStorage, or
non-HttpOnly cookies.

### Agent OAuth Callback

`GET /api/nimbus/oauth/callback`

- Keep routed by the core Nimbus handler because the agent state includes
  the target `sessionId` and `tenantSegment`.
- The hosted-demo wrapper should allow this path through to core.
- The agent OAuth state cookie and callback validation remain in
  `packages/worker/src/session/agent.ts`.
- Demo login must not reuse the agent OAuth cookie names or scopes.

### SDK Smoke Routes

Current routes:

- `/api/sdk-smoke`
- `/api/sdk-remote-smoke`

Pilot behavior:

- Gate these behind demo auth or a private env flag such as
  `DEMO_ENABLE_SMOKE_ROUTES=1`.
- If they create sandboxes in production, they must insert rows in
  `demo_sessions` and use the same idle cleanup path.
- Prefer moving production smoke to behavioral tests rather than leaving
  endpoints that create sandboxes without authentication.

## Demo D1 Registry

Add a demo-only D1 database binding, for example `DEMO_DB`.

Suggested migration:

```sql
CREATE TABLE demo_users (
  user_id TEXT PRIMARY KEY,
  cf_subject_hash TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE demo_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'destroying', 'destroyed', 'failed')),
  destroyed_at INTEGER,
  destroy_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES demo_users(user_id)
);

CREATE INDEX demo_sessions_by_user
ON demo_sessions(user_id, status, created_at DESC);

CREATE INDEX demo_sessions_by_expiry
ON demo_sessions(status, expires_at);
```

Use Unix milliseconds for all timestamps.

Recommended pilot defaults:

```text
DEMO_SESSION_IDLE_TTL_DAYS=3
DEMO_TOUCH_DEBOUNCE_SECONDS=600
DEMO_AUTH_COOKIE_DAYS=30
DEMO_NIMBUS_JWT_TTL_SECONDS=900
DEMO_CLEANUP_BATCH_SIZE=100
```

`DEMO_CLEANUP_BATCH_SIZE` is not a user-facing session cap. It only bounds one
cron pass so cleanup does not exceed Worker execution limits.

## Hosted Demo Code Changes

### `apps/hosted-demo/src/index.ts`

Replace the single exported `createNimbusHandler(...)` object with a composed
handler:

```ts
const nimbus = createNimbusHandler({
  auth: { mode: 'enforce' },
  sdk: {
    remote: true,
    config: sandboxConfig,
  },
  routes: hostedDemoNimbusRoutes,
});

export default {
  async fetch(request, env, ctx) {
    return handleHostedDemoRequest(request, env, ctx, nimbus);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanupExpiredDemoSessions(env, ctx));
  },
};
```

New hosted-demo helpers should live beside `index.ts`, not in
`packages/worker`:

| File | Purpose |
|---|---|
| `apps/hosted-demo/src/demo-auth.ts` | Cloudflare OAuth start/callback, demo auth cookie sealing, logout |
| `apps/hosted-demo/src/demo-sessions.ts` | D1 session registry, session ownership, touch debounce, expired page |
| `apps/hosted-demo/src/demo-nimbus.ts` | Internal Nimbus JWT minting and request header injection |
| `apps/hosted-demo/src/demo-cleanup.ts` | Cron cleanup of expired demo sessions |
| `packages/worker/src/_shared/crypto.ts` | Shared WebCrypto helpers for sealed JSON, PKCE, random nonces, and base64url encoding |

Keep `apps/hosted-demo/src/index.ts` small enough to show the composition
clearly.

The hosted demo should not carry its own cookie crypto implementation. Use the
shared helper through `@nimbus-sh/sdk/worker`; it relies on WebCrypto primitives
only:

- `crypto.getRandomValues` for nonces and AES-GCM IVs.
- HKDF-SHA256 for purpose-specific AES-GCM keys.
- AES-GCM authenticated encryption with additional authenticated data binding
  each sealed value to its cookie purpose.
- SHA-256 base64url for PKCE and stable demo user hashes.

Base64url helpers are encoding only; they are not cryptographic primitives.

### `apps/hosted-demo/wrangler.jsonc`

Add:

- D1 binding `DEMO_DB`.
- Scheduled trigger.
- Demo-only non-secret vars.
- Production overlay redeclarations for non-inheritable bindings.

Suggested config shape:

```jsonc
"d1_databases": [
  {
    "binding": "DEMO_DB",
    "database_name": "nimbus-demo",
    "database_id": "<created-by-wrangler>"
  }
],
"triggers": {
  "crons": ["17 * * * *"]
},
"vars": {
  "DEMO_SESSION_IDLE_TTL_DAYS": "3",
  "DEMO_TOUCH_DEBOUNCE_SECONDS": "600",
  "DEMO_AUTH_COOKIE_DAYS": "30",
  "DEMO_NIMBUS_JWT_TTL_SECONDS": "900",
  "DEMO_CLEANUP_BATCH_SIZE": "100"
}
```

Also update `assets.run_worker_first` so `/login` and `/logout` go through
the Worker:

```jsonc
"run_worker_first": ["/api/*", "/s/*", "/new", "/login", "/logout"]
```

Secrets:

```text
JWT_SECRET
DEMO_AUTH_COOKIE_SECRET
DEMO_CF_OAUTH_CLIENT_ID
```

Optional only if Cloudflare OAuth requires it for the configured app type:

```text
DEMO_CF_OAUTH_CLIENT_SECRET
```

Do not reuse `NIMBUS_AGENT_COOKIE_SECRET` for demo auth. The two flows have
different trust boundaries.

## Core Hardening Changes

The hosted-demo pilot should not proceed with weak core auth. Harden these
items first or in the same implementation branch.

### 1. Enforce Browser Session Scopes And Session Pinning

Files:

- `packages/worker/src/router/index.ts`
- `packages/worker/src/auth/middleware.ts`
- `packages/worker/src/auth/types.ts`
- tests under `tests/behavioral/auth/`

Current weakness:

- Remote SDK auth checks scopes and `sid`.
- Browser session auth only verifies the JWT and returns a tenant segment.
- `session:create`, `session:attach`, and `sid` are documented claim
  concepts, but the browser router does not enforce them.

Required change:

- Replace `resolveTenantSegment(...)` with a helper that returns the full
  verified token in enforce mode.
- For `/s/<id>/*`, require:
  - valid Nimbus JWT
  - `session:attach` scope, unless the token has no `scopes` field
  - matching `sid` when `sid` is present
- For core `/new` in enforce mode, require:
  - valid Nimbus JWT
  - `session:create` scope, unless the token has no `scopes` field
- Keep legacy mode behavior unchanged.

Expected test cases:

- Missing token cannot access `/s/<id>/`.
- Token with `sid=a` cannot access `/s/b/`.
- Token with scopes `['sandbox:use']` cannot access `/s/<id>/`.
- Token with scopes `['session:attach']` can access `/s/<id>/`.
- Legacy mode still allows current anonymous behavior.

### 2. Add A Secure Session Destroy Primitive

Files:

- `packages/worker/src/session/programmatic.ts`
- `packages/worker/src/session/nimbus-session.ts`
- `packages/worker/src/router/remote-api.ts`
- `packages/sdk/src/sandbox.ts`
- `packages/sdk/README.md`
- `docs/sandbox-sdk.md`
- tests under `tests/behavioral/sdk/` and `tests/behavioral/auth/`

Required API:

```ts
await box.destroy({ reason?: string });
```

Remote operation:

```json
{ "op": "destroy", "args": [{ "reason": "demo-idle-ttl" }] }
```

Auth:

- Require `session:destroy` or `session:admin` for remote destroy.
- For colocated `Nimbus.fromEnv(...)`, the caller is trusted by the embedder.

DO implementation:

1. Mark the session as destroying in memory.
2. Stop long-running processes where possible.
3. Unregister preview ports.
4. Close or reject active WebSockets with a clear close reason if any exist.
5. Flush pending VFS/process-log writes best-effort.
6. Call `ctx.storage.deleteAll()`.
7. Return `{ ok: true }`.

Important invariant:

- Destroying the DO storage must not delete shared R2 caches. npm/runtime R2
  caches are platform caches, not session data.

### 3. Fix Or Remove Query-To-Cookie Token Behavior

Files:

- `packages/worker/src/auth/middleware.ts`
- `packages/worker/src/router/index.ts`
- tests under `tests/behavioral/auth/`

Current weakness:

- The middleware documents setting `nimbus_token` from the query parameter,
  but no router code currently does that.

Pilot stance:

- Hosted demo should avoid browser-visible Nimbus JWTs entirely by injecting
  Authorization internally.

Core stance:

- Either implement the documented behavior safely or remove the documentation.
- If implemented, only set the cookie on successful token verification.
- Preserve current defaults for iframe embedders.
- Add options for stricter cookies where applicable:
  - `HttpOnly`
  - `SameSite=Lax`
  - `Path=/s`
  - `Secure`
- Never log token query strings.

### 4. Make Owner AI Fallback Explicitly Disableable

Files:

- `packages/worker/src/session/agent.ts`
- `apps/hosted-demo/wrangler.jsonc`
- tests under `tests/behavioral/agent/`

Current risk:

- The agent can use owner-token credentials when configured. That is useful
  for private deployments, but risky for a public demo because it can spend
  the deployment owner's AI quota.

Required hardening:

- Add an env var such as:

  ```text
  NIMBUS_AGENT_REQUIRE_USER_OAUTH=1
  ```

- When enabled, agent chat must require a connected user OAuth token and must
  not fall back to owner credentials.
- Hosted demo production should enable this flag or simply omit owner token
  secrets.

### 5. Keep Core Auth Defaults Backward Compatible

Core defaults should remain:

- `createNimbusHandler()` in a third-party deployment uses the existing auto
  behavior.
- If `JWT_SECRET` is absent and `NIMBUS_LEGACY_PUBLIC` is not forcing
  enforcement, legacy public mode still works.
- If an embedder opts into `auth: { mode: 'enforce' }`, missing `JWT_SECRET`
  remains a server config error.

The hosted demo can become strict without making everyone else's deployment
strict.

## Cleanup Job

Cron flow:

1. Query D1:

   ```sql
   SELECT session_id, user_id
   FROM demo_sessions
   WHERE status = 'active'
     AND expires_at <= ?
   ORDER BY expires_at ASC
   LIMIT ?
   ```

2. For each row, atomically move to `destroying`.
3. Call:

   ```ts
   const nimbus = Nimbus.fromEnv(env, sandboxConfig);
   await nimbus.sandbox(sessionId, {
     tenant: 'demo',
     subject: userId,
   }).destroy({ reason: 'demo-idle-ttl' });
   ```

4. Mark `destroyed`.
5. On failure, mark `failed` with reason and retry on the next cron pass or
   through a small admin-only repair route.

No cleanup route should accept arbitrary public session ids.

## Security Checklist

Before deploy:

- Cloudflare OAuth redirect URI is exact:
  `https://nimbus-os.dev/api/demo/oauth/callback`.
- Demo OAuth uses PKCE.
- Demo OAuth state includes a nonce and return path.
- Demo auth cookie is sealed, HttpOnly, Secure, SameSite=Lax, Path=/.
- Demo auth cookie secret is separate from agent cookie secret.
- Demo login stores no Cloudflare access tokens.
- Internal demo user id is hashed and does not expose email or raw Cloudflare
  user ids in DO names.
- Hosted demo uses `auth: { mode: 'enforce' }`.
- Hosted demo injects Nimbus JWTs server-side only.
- Nimbus browser router enforces `session:attach` and `sid`.
- Remote SDK router continues enforcing `sandbox:use` and `sid`.
- Destroy requires `session:destroy` or `session:admin` remotely.
- Public SDK smoke routes cannot create anonymous untracked sandboxes.
- Agent owner-token fallback is disabled for hosted demo production.
- Expired sessions return a 410-style expired page and are not recreated.
- Cleanup deletes DO SQLite storage and does not touch shared R2 caches.
- All auth errors use `Cache-Control: no-store`.
- Token-bearing URLs are not generated by the hosted demo.

## Behavioral Verification Plan

Add behavioral probes before production rollout:

| Probe | Expected |
|---|---|
| Anonymous `/new` | redirects to login or returns auth-required |
| Authenticated launch | creates D1 row and redirects to `/s/<id>/` |
| Anonymous `/s/<id>/` | cannot access session |
| Other logged-in user `/s/<id>/` | cannot access session |
| Owner logged-in user `/s/<id>/` | can access shell |
| Session-pinned JWT mismatch | rejected |
| Missing `session:attach` scope | rejected |
| Agent OAuth callback | still reaches correct session |
| Idle touch debounce | updates `last_seen_at` only after debounce window |
| Expired session access | returns expired page and does not forward to DO |
| Cleanup cron | destroys expired session and marks D1 destroyed |
| Destroyed session storage | new DO access does not see old files |
| SDK smoke routes | not anonymous in production |
| Owner AI fallback disabled | agent requires user OAuth |

Also keep existing live probes for:

- session agent panel
- SDK remote smoke
- preview tab auto-focus
- Vite preview
- npm/npx install behavior
- Python/Ruby/Clang runtime install

## Rollout Plan

1. Core auth hardening and tests.
2. Core destroy primitive and SDK method.
3. Hosted demo D1 schema and local auth helpers.
4. Hosted demo request wrapper with server-side Nimbus JWT injection.
5. Hosted demo idle touch and cleanup cron.
6. Protect or disable public SDK smoke routes.
7. Staging deploy using versioned preview URL.
8. Run auth/security behavioral probes.
9. Production deploy.
10. Watch D1 session counts, DO SQLite storage, Worker errors, and cleanup
    failures.

## Open Decisions

Recommended defaults for the pilot:

- Idle TTL: 3 days.
- Demo auth cookie: 30 days.
- Internal Nimbus JWT TTL: 15 minutes.
- Touch debounce: 10 minutes.
- Cleanup cron: hourly.
- Cleanup batch size: 100 expired sessions per pass.

Decision still worth confirming before implementation:

- Whether `/new` should remain a bookmarkable GET that renders a launch page,
  or become POST-only from the landing page. For security, POST-only creation
  is preferred.
