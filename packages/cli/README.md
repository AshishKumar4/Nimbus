# @nimbus-sh/cli

Scaffold a Nimbus Worker, mint and verify tokens, open sessions, and sync the
runtime cache.

## Install

```bash
npx @nimbus-sh/cli --help
npx @nimbus-sh/cli init my-app
npx create-nimbus-app my-app
```

From this repository:

```bash
bun packages/cli/src/bin.ts --help
bun packages/cli/src/bin.ts init my-app
bun packages/cli/src/scaffold-bin.ts my-app
```

## Verbs

### `nimbus init [directory]`

Scaffolds a Nimbus-powered Workers project. `.` uses the current directory.

The generated app embeds the interactive Nimbus UI and enables the
authenticated remote sandbox API. Add your own auth routes in `src/index.ts`
before you mint user tokens from the backend.

The app also carries the session agent UI. To configure Cloudflare OAuth and
Workers AI, add the non-secret `NIMBUS_CF_OAUTH_CLIENT_ID`,
`NIMBUS_CF_OAUTH_SCOPES`, `NIMBUS_AGENT_MODEL`, and
`NIMBUS_AGENT_GATEWAY_ID` vars. Then store `NIMBUS_AGENT_COOKIE_SECRET` with
`wrangler secret put`.

```bash
nimbus init my-nimbus
cd my-nimbus
npm install
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

### `create-nimbus-app <name>`

Scaffolds a new Nimbus-powered Workers project with the same template as
`nimbus init`.

```bash
create-nimbus-app my-nimbus
cd my-nimbus
npm install
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

Flags:

| Flag | Default | What |
|---|---|---|
| `--name <wrangler-name>` | project name | Becomes the deployed Worker name. |
| `--template <name>` | `worker-only` | Only `worker-only` ships in v0.1. |
| `--force` | off | Overwrite existing directory. |

### `nimbus setup cloudflare`

Creates the R2 buckets referenced by the scaffolded `wrangler.jsonc` and
uploads the Python, Ruby, and clang runtime catalog.

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name my-nimbus
```

If Wrangler reports Cloudflare R2 error `10042`, enable R2 in the
Cloudflare Dashboard once for the account, then rerun the setup command.

Flags:

| Flag | Default | What |
|---|---|---|
| `--name <worker-name>` | required | Worker name and default bucket prefix. |
| `--bucket-prefix <prefix>` | `--name` | Prefix for npm cache buckets. |
| `--runtime-bucket <bucket>` | `nimbus-runtime-cache-public` | Runtime catalog/blob bucket. |
| `--skip-runtimes` | off | Create buckets only. |

### `nimbus token mint`

```bash
JWT_SECRET=<hex> nimbus token mint --tenant acme --sub alice [--ttl 3600]
# Prints the JWT to stdout. Pipe with `> /tmp/jwt` or `| pbcopy`.
```

Flags:

| Flag | What |
|---|---|
| `--tenant <id>` (required) | Sets `tn` claim. |
| `--sub <id>` | Sets `sub` claim. |
| `--ttl <sec>` | Token lifetime in seconds. Default 3600 (1h), max 2,592,000 (30d). |
| `--scopes <a,b>` | Comma-separated capability scopes. |
| `--sid <id>` | Pin token to a specific session ID. |

Use `--scopes sandbox:use --sid <sandbox-id>` for remote SDK calls through
`Nimbus.connect(...)`.

### `nimbus token verify <token>`

```bash
JWT_SECRET=<hex> nimbus token verify eyJhbGciOi...
# Prints the verified claims as JSON.
```

Exit codes: 0 success, 65 token-validation failure, 78 env missing.

### `nimbus runtime sync`

Uploads runtime blobs and manifests, then updates the runtime catalog. This
is the user-facing path for the Python, Ruby, and clang runtime caches.

```bash
CLOUDFLARE_ACCOUNT_ID=<id> nimbus runtime sync --bucket nimbus-runtime-cache-public clang
CLOUDFLARE_ACCOUNT_ID=<id> nimbus runtime sync --bucket nimbus-runtime-cache-public python
CLOUDFLARE_ACCOUNT_ID=<id> nimbus runtime sync --bucket nimbus-runtime-cache-public ruby
```

Runtime versions default to the shipped catalog versions
(`clang@binji-2020`, `python@0.29.4`, `ruby@3.3.4`) unless explicitly
overridden as `name@version`.

### `nimbus runtime list`

```bash
nimbus runtime list
# JSON catalog: [{name, version, size_mb, license}, ...]
```

### `nimbus session new`

```bash
NIMBUS_ENDPOINT=https://my-nimbus.workers.dev nimbus session new
# {"sessionId":"pretty-otter-1234","url":"https://.../s/pretty-otter-1234/"}
```

Authenticated deployments can pass a token with `--token` or `NIMBUS_TOKEN`:

```bash
NIMBUS_ENDPOINT=https://my-nimbus.workers.dev \
NIMBUS_TOKEN=<jwt-with-session-create> \
nimbus session new
```

The token is sent only as an `Authorization: Bearer` header. It never
appears in any URL. The printed attach URL is the server's redirect Location
verbatim. On enforced deployments that URL carries a short-lived (90 s),
single-use bootstrap token pinned to the new session. Opening it once sets
the session cookie and redirects to the clean `/s/<id>/` URL. Reusing it
returns 401.

## Programmatic use

Every verb is also exported as a function:

```ts
import { mintToken, syncRuntimes, scaffold } from '@nimbus-sh/cli';
```

`mintToken(argv)` and its siblings return a Promise<number>, the process exit
code. They write to `process.stdout` and `process.stderr` directly.

## Engines

Requires Node >= 20 (for native `fetch`, `crypto.subtle`, etc.).

MIT.
