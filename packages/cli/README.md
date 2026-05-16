# @nimbus-sh/cli

CLI for Nimbus: scaffolder + `token mint` + `runtime sync`.

## Install

```bash
# One-shot scaffolder (no install needed):
npx @nimbus-sh/cli create-nimbus-app my-app
# Or directly:
npx create-nimbus-app my-app

# For ops use, install globally:
npm i -g @nimbus-sh/cli
```

## Verbs

### `create-nimbus-app <name>`

Scaffolds a new Nimbus-powered Workers project.

```bash
npx create-nimbus-app my-nimbus
cd my-nimbus
bun install
wrangler secret put JWT_SECRET
wrangler deploy
```

Flags:

| Flag | Default | What |
|---|---|---|
| `--name <wrangler-name>` | project name | Becomes the deployed Worker name. |
| `--template <name>` | `worker-only` | Only `worker-only` ships in v0.1. |
| `--force` | off | Overwrite existing directory. |

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

### `nimbus token verify <token>`

```bash
JWT_SECRET=<hex> nimbus token verify eyJhbGciOi...
# Prints the verified claims as JSON.
```

Exit codes: 0 success, 65 token-validation failure, 78 env missing.

### `nimbus runtime sync`

Re-runs the runtime-blob pipeline (clang sysroot + Pyodide + ruby.wasm)
into an R2 bucket. Used by embedders running in BYOA mode.

```bash
CLOUDFLARE_ACCOUNT_ID=<id> nimbus runtime sync [--bucket <name>] [--runtimes clang,python,ruby]
```

Defaults to the shared `nimbus-runtime-cache-public` bucket; pass
`--bucket my-nimbus-runtime` to point at your own.

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

## Programmatic use

Every verb is also exported as a function:

```ts
import { mintToken, syncRuntimes, scaffold } from '@nimbus-sh/cli';
```

`mintToken(argv)` and friends return a Promise<number> (process exit
code). Stdout / stderr write directly via `process.stdout`/`process.stderr`.

## Engines

Requires Node >= 20 (for native `fetch`, `crypto.subtle`, etc.).

MIT.
