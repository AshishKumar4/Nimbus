# AGENTS.md - Nimbus Project Context

Last refreshed: 2026-06-05

Treat live code as the source of truth. Older notes, historical comments, and
generated artifacts may lag; verify against the actual implementation before
making claims.

## Current Shape

Nimbus is a Cloudflare Workers + Durable Objects development environment.
Each browser session maps to a SQLite-backed Durable Object with persistent VFS,
shell state, process tables, port routing, npm/git/runtime substrates, and
hibernation/rehydration support.

The repo is a Bun workspace monorepo:

| Path | What |
|---|---|
| `apps/hosted-demo/` | Live demo / canonical embedder. Deployed at `https://nimbus.ashishkumarsingh.com`. |
| `packages/worker/` | `@nimbus-sh/worker`: runtime, `NimbusSession` DO, router, VFS, runtimes, facets, static assets. |
| `packages/sdk/` | `@nimbus-sh/sdk`: Worker embedder exports, token/session helpers, and programmatic sandbox SDK. |
| `packages/react/` | `@nimbus-sh/react`: iframe wrapper component and headless hook. |
| `packages/cli/` | `@nimbus-sh/cli`: scaffold/setup/token/session/runtime commands. |
| `packages/create-nimbus-app/` | `npx create-nimbus-app` wrapper. |
| `packages/config/` | `@nimbus-sh/config`: typed Nimbus and Wrangler config helpers. |
| `tests/behavioral/` | Black-box behavioral probes. Current discovery count is 310 probes. |

`apps/hosted-demo/src/index.ts` imports the Worker package through the SDK
entrypoints, exports the required DO/RPC classes, calls `createNimbusHandler`,
and exposes live SDK smoke routes.

## SDK

The programmatic sandbox SDK is implemented in `packages/sdk/src/sandbox.ts`.
It supports:

- `Nimbus.fromEnv(env, config?)` for colocated Workers/DOs with the
  `NIMBUS_SESSION` binding.
- `Nimbus.connect({ endpoint, token, config })` for authenticated remote use.
- `nimbus.sandbox(id, options?)` returning a `NimbusSandbox` with
  `ready`, `exec`, `runCode`, `startProcess`, `files`, `runtimes`,
  `processes`, `ports`, `capabilities`, and `tools()`.

`NimbusSession` exposes the backing RPC methods in
`packages/worker/src/session/nimbus-session.ts`; implementation helpers live in
`packages/worker/src/session/programmatic.ts`.

The SDK is the intended surface for backend sandbox integrations. The hosted
demo also exercises it through `/api/sdk-smoke` and `/api/sdk-remote-smoke`.

## Runtime Internals

Core files:

| File | What |
|---|---|
| `packages/worker/src/session/nimbus-session.ts` | DO class, lifecycle, VFS/facet/process/port ownership, diagnostics, hibernation. |
| `packages/worker/src/session/routes.ts` | DO-internal HTTP/WS routes. |
| `packages/worker/src/session/init.ts` | Session boot, shell commands, npm/git/vite/wrangler/runtime registration. |
| `packages/worker/src/runtime/node-shims.ts` | Node-compatible fs/path/process/streams/http/child_process shims. |
| `packages/worker/src/facets/process.ts` | Supervisor-side `child_process` broker. |
| `packages/worker/src/vfs/sqlite-vfs.ts` | SQLite-backed VFS. |
| `packages/worker/src/npm/installer.ts` | npm install pipeline. |
| `packages/worker/src/runtime/package-manager.ts` | `nimbus install` runtime package manager. |

Constants live in `packages/worker/src/constants.ts`.

## Runtimes

Runtime blobs and manifests are synced through the CLI:

```bash
nimbus runtime sync --bucket nimbus-runtime-cache python clang ruby
```

Do not tell users to run `packages/worker/scripts/bundle-runtime.mjs` unless
they are changing the runtime ingestion pipeline itself.

Current runtime substrate:

| Runtime | Bins | Notes |
|---|---|---|
| `python` | `python`, `python3` | Pyodide / CPython 3.13. |
| `ruby` | `ruby`, `ruby3` | ruby.wasm / Ruby 3.3. |
| `clang` | `clang`, `wasm-ld` | LLVM 8 to wasm32-wasi. |
| `node`, `bun` | `node`, `bun`, `npm`, `npx` | Cloudflare workerd `nodejs_compat` and Nimbus shims, not upstream native binaries. |

## Agentic CLI Compatibility

Nimbus should be able to host agentic tools when the tool can run as JavaScript,
TypeScript, WASM, or through Nimbus-supported process primitives. The relevant
surfaces are:

- shell exec, persistent files, env/home/config directories
- npm/npx package installation, including npm alias dependencies
- `child_process.spawn`, `exec`, `execFile`, streams, and long-running process logs
- outbound HTTPS via fetch-compatible APIs
- HTTP-like preview/port routing for local agent servers

Behavioral probes cover these primitives under:

- `tests/behavioral/agentic-cli/`
- `tests/behavioral/runtime-primitives/npm-alias-dependency.mjs`
- `tests/behavioral/runtime-primitives/npx-vite.mjs`

Native platform binaries are not Linux-executable in Nimbus. Packages that ship
only `linux-x64`/`darwin`/`win32` native shards need a WASM build, a pure-JS
entrypoint, or a Nimbus-specific adapter.

## Tests

Useful commands:

| Task | Command |
|---|---|
| Typecheck | `bun run typecheck` |
| Build packages | `bun run --cwd packages/worker build` |
| All live probes | `BASE=https://nimbus.ashishkumarsingh.com bun test:behavioral` |
| One live probe | `BASE=https://nimbus.ashishkumarsingh.com bun tests/behavioral/<path>.mjs` |
| Limit runner scope | `NIMBUS_PROBE_ONLY=<path-fragment> BASE=... bun test:behavioral` |

Probes should assert user-visible behavior, not static strings or HTTP 200
alone. Use bounded polling with loud failures; do not add sleep-only or
defensive-catch tests.

## Build And Deploy

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Bundle worker assets | `bun run bundle` |
| Dev server | `bun run dev` |
| Deploy default | `bun run deploy` |
| Deploy production | `bun run deploy:production` |
| Dry-run production deploy | `bun run --cwd apps/hosted-demo wrangler deploy -e production --dry-run --outdir /tmp/wrangler-build` |

The root `predev` and `predeploy` scripts regenerate worker bundles.

## Gotchas

- Use Bun for workspace package management.
- Use `apps/hosted-demo` as the canonical embedder.
- Do not add `allow_eval_during_startup`; Wrangler rejects redundant flags for
  the current compat date.
- `@nimbus-sh/sdk/worker` is the public Worker embedder import. `@nimbus-sh/worker`
  carries runtime assets and implementation.
- `R2` runtime catalog state is external. Correct code can still fail runtime
  probes when `catalog/v1.json` points at stale manifests.
- Never edit generated files directly; rerun the package build/bundle scripts.
- Never revert changes you did not make. Check `git status --short` before
  editing and preserve sibling work.
