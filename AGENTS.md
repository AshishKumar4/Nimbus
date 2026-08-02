# AGENTS.md - Nimbus Project Context

Last refreshed: 2026-06-06

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
| `apps/hosted-demo/` | Live demo / canonical embedder. Deployed at `https://nimbus-os.dev`. |
| `packages/worker/` | `@nimbus-sh/worker`: runtime, `NimbusSession` DO, router, VFS, runtimes, facets, static assets. |
| `packages/sdk/` | `@nimbus-sh/sdk`: Worker embedder exports, token/session helpers, and programmatic sandbox SDK. |
| `packages/react/` | `@nimbus-sh/react`: iframe wrapper component and headless hook. |
| `packages/cli/` | `@nimbus-sh/cli`: scaffold/setup/token/session/runtime commands. |
| `packages/create-nimbus-app/` | `npx create-nimbus-app` wrapper. |
| `packages/config/` | `@nimbus-sh/config`: typed Nimbus and Wrangler config helpers. |
| `tests/behavioral/` | Black-box behavioral probes. |

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
- `@nimbus-sh/sdk/flue` for mapping a Nimbus sandbox to Flue's sandbox
  provider contract without making Flue a hard dependency of the core SDK.

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
| `packages/worker/src/session/agent.ts` | Session Agent API, Cloudflare OAuth flow, AI SDK model calls, sandbox tools. |
| `packages/worker/src/runtime/node-shims.ts` | Node-compatible fs/path/process/streams/http/child_process shims. |
| `packages/worker/src/runtime/os-contracts.ts` | Shared Runtime OS contracts for filesystem/process/ports/package ABI/diagnostics. |
| `packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts` | Runtime filesystem bridge over `SqliteVFS`. |
| `packages/worker/src/facets/process.ts` | Supervisor-side `child_process` broker. |
| `packages/worker/src/vfs/sqlite-vfs.ts` | SQLite-backed VFS. |
| `packages/worker/src/npm/installer.ts` | npm install pipeline. |
| `packages/worker/src/runtime/package-manager.ts` | `nimbus install` runtime package manager. |

Constants live in `packages/worker/src/constants.ts`.

Node dynamic Workers keep sync `fs` calls on a startup snapshot and local write
cache for speed. The snapshot includes the entry dependency graph plus a bounded
current-working-tree project snapshot, excluding `node_modules`, `.git`, and
`.nimbus`. Async `fs` calls use the supervisor bridge for live SQLite VFS reads
and common mutations (`writeFile`, `appendFile`, `mkdir`, `unlink`, `rename`,
`rmdir`, `symlink`, `readlink`, `truncate`), while merging live directory
entries so child-process writes are visible inside long-running Node
processes. `fs.promises.open` FileHandles and live appends use the stateless
range RPCs (`fsReadRange`/`fsWriteRange`/`fsTruncate`), which rewrite only the
touched 64 KiB chunks; VFS revisions are per-path subtree watermarks
(`SqliteVFS.revision(path?)`).

The Runtime OS target and honest support matrix are tracked in
`docs/architecture/nimbus-os-runtime-spec.md`. Keep docs and UI claims within
that support matrix unless a behavioral probe proves a larger capability.

## Engineering Bar

Nimbus is intended to push what a Workers + Durable Objects runtime can do. The
shell substrate is imported as Nimbus-owned source under
`packages/worker/src/substrate/lifo`; when it lacks a shell, parser, process,
PTY, filesystem, networking, package, or runtime primitive that Nimbus needs,
implement the missing capability cleanly in that substrate or another proper
Nimbus runtime boundary instead of adding script-specific patches.

For parser and language work, prefer existing libraries and structured
representations:

- Use ASTs, token streams, or upstream parser primitives when they are available.
- Use libraries such as Acorn, Babel tooling, or other maintained parsers for
  JavaScript/TypeScript analysis and rewriting.
- Avoid ad hoc string rewriting, regex-only parsers, duplicated normalizers, or
  broad compatibility fallbacks for language, shell, or module semantics.
- If a dependency cannot expose the needed structure, introduce a typed Nimbus
  substrate at the correct boundary rather than stacking more preprocessors.

For noisy exploration, use sub-agents where available to inspect large dependency
trees, transcript history, generated bundles, or broad code-quality scans. Keep
mainline implementation decisions grounded in the resulting source evidence and
behavioral probes.

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
| `python` | `python`, `python3`, `pip`, `pip3` | Pyodide / CPython 3.13. `pip` is alpha but ABI-aware: PyPI pure wheels, requirements, constraints, extras, markers, local pure wheels, curated pure source artifacts, and declared Pyodide startup-module package artifacts are supported. Request-time extension-module loading is blocked by Workers and must not be used. |
| `ruby` | `ruby`, `ruby3`, `gem`, `bundle`, `bundler` | ruby.wasm / Ruby 3.3. Pure Ruby gems, simple Bundler Gemfiles, gem bins, Rack/WEBrick-style preview, and native-gem unsupported diagnostics are implemented; full Bundler parity and native Ruby extensions need a Nimbus ABI path. |
| `clang` | `clang`, `wasm-ld` | LLVM 8 to Nimbus' `wasm32-wasi-nimbus` ABI. |
| `node`, `bun` | `node`, `bun`, `npm`, `npx` | Cloudflare workerd `nodejs_compat` and Nimbus shims, not upstream native binaries. |

## Agentic CLI Compatibility

Nimbus should be able to host agentic tools when the tool can run as JavaScript,
TypeScript, WASM, or through Nimbus-supported process primitives. The relevant
surfaces are:

- shell exec, persistent files, env/home/config directories
- npm/npx package installation, including npm alias dependencies
- `child_process.spawn`, `exec`, `execFile`, streams, stdin/stdout/stderr,
  and long-running process logs
- foreground attached npm-bin process tabs with TTY-shaped stdio, resize,
  input delivery, ANSI output, and clean exit handling
- outbound HTTPS via fetch-compatible APIs
- HTTP-like preview/port routing for local agent servers
- sync Node `fs` reads of ordinary project files from the current working tree

Current proven path: JavaScript npm-bin CLIs can launch as foreground attached
process tabs with TTY-shaped stdio, resize, stdin, signals, and ANSI output.
Pi's official `curl -fsSL https://pi.dev/install.sh | sh` installer works,
the direct npm install path works, `pi --version`/`pi --help` return as short
commands, and bare `pi` starts as a long-running attached process. This is not
yet a full POSIX PTY: attach/detach replay, terminal line discipline,
`stdio: "inherit"` parity, and arbitrary full-screen TUI correctness need
deeper probes. Keep opencode and local Proteus claims gated behind live probes
until they are verified.

Behavioral probes cover these primitives under:

- `tests/behavioral/agentic-cli/`
- `tests/behavioral/runtime-primitives/npm-alias-dependency.mjs`
- `tests/behavioral/runtime-primitives/npx-vite.mjs`

Native platform binaries are not Linux-executable in Nimbus. Packages that ship
only `linux-x64`/`darwin`/`win32` native shards, native Python wheels, or
native Ruby extensions need a Nimbus ABI artifact, WASM build, pure-language
entrypoint, or a precise unsupported-ABI diagnostic.

The canonical unfinished-work plan is
`docs/architecture/nimbus-os-runtime-spec.md`. Keep README and UI claims within
that support matrix unless a live production probe proves a larger capability.

## Session Agent

The browser shell has a single editor workspace wired through
`packages/worker/public/s/index.html`. The center pane switches between the
file editor and the Agent surface; the terminal and preview stay visible.
Session-scoped routes under `/api/agent/*` are handled in
`packages/worker/src/session/agent.ts`.

Agent capabilities:

- Cloudflare OAuth start/callback/logout with stable callback
  `/api/nimbus/oauth/callback`
- account selection from the connected Cloudflare token
- AI SDK tool calling through Cloudflare Workers AI's OpenAI-compatible
  endpoint, with optional AI Gateway routing
- streaming chat responses with thinking state and inline tool-call/result
  indicators in the browser surface
- encrypted `HttpOnly` browser cookies for user OAuth tokens and PKCE state;
  do not persist user OAuth tokens in Durable Object storage
- sandbox tools for exec, files, runtime install, processes, logs, and ports
- tabbed preview pane for Markdown, default app preview, Worker preview, and
  live `/port/<n>/` previews; newly exposed ports auto-focus

Agent configuration:

| Env var | What |
|---|---|
| `NIMBUS_CF_OAUTH_CLIENT_ID` | Cloudflare OAuth client ID. |
| `NIMBUS_CF_OAUTH_SCOPES` | Space-delimited OAuth scope IDs selected from Cloudflare. |
| `NIMBUS_CF_OAUTH_REDIRECT_URI` | Optional override; defaults to `<origin>/api/nimbus/oauth/callback`. |
| `NIMBUS_AGENT_COOKIE_SECRET` | 32+ character secret for encrypting browser-held OAuth cookies; set with `wrangler secret put`. Falls back to `JWT_SECRET`. |
| `NIMBUS_CF_OAUTH_CLIENT_SECRET` | Optional only for confidential OAuth clients; do not set it for the public PKCE flow. |
| `NIMBUS_CLOUDFLARE_ACCOUNT_ID` | Owner-account fallback account ID. |
| `NIMBUS_CLOUDFLARE_API_TOKEN` | Owner-token fallback secret; set with `wrangler secret put`. |
| `NIMBUS_AGENT_MODEL` | Model name, default `@cf/moonshotai/kimi-k2.6`. |
| `NIMBUS_AGENT_GATEWAY_ID` | AI Gateway name, default `default`. |

`@nimbus-sh/config` can generate the non-secret Agent vars. Secrets stay in
Workers secret storage.

OAuth scopes for the public PKCE flow:

- `user-details.read` / `User Details Read` for profile display.
- `account-settings.read` / `Account Settings Read` for account selection.
- `ai.write` / `Workers AI Write` for Workers AI inference.
- `aig.run` / `AI Gateway Run` only when `NIMBUS_AGENT_GATEWAY_ID` is set.

Do not use `Account API Gateway`; it is an API Shield permission, not
Cloudflare AI Gateway.

## Tests

Useful commands:

| Task | Command |
|---|---|
| Typecheck | `bun run typecheck` |
| Build packages | `bun run --cwd packages/worker build` |
| Unit suite | `for f in tests/unit/*.mjs; do bun "$f" || break; done` |
| All live probes | `BASE=<target> bun test:behavioral` |
| One live probe | `BASE=<target> bun tests/behavioral/<path>.mjs` |
| Limit runner scope | `NIMBUS_PROBE_ONLY=<path-fragment> BASE=<target> bun test:behavioral` |

Probes should assert user-visible behavior, not static strings or HTTP 200
alone. Use bounded polling with loud failures; do not add sleep-only or
defensive-catch tests. Live probes that create sessions must delete those
sessions in `finally` via the public cleanup path.

### Probe targets

`BASE` cannot be `https://nimbus-os.dev`. The hosted demo gates `POST /new`
and every `/s/<sid>/*` route on an interactive Cloudflare OAuth cookie and
never reads `Authorization: Bearer`, so a headless run gets
`401 E_DEMO_LOGIN_REQUIRED`. The bearer-token embedder is `apps/probe`,
where the core router's `POST /new` accepts a `session:create` JWT signed
with that deployment's `JWT_SECRET`.

Deploy your own disposable one — no shared secret needed:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>

eval "$(bun tests/behavioral/_throwaway-target.mjs up)"   # exports BASE + NIMBUS_PROBE_TOKEN
bun tests/behavioral/run-all.mjs --no-retry
bun tests/behavioral/_throwaway-target.mjs down           # delete, and confirm it is gone
```

`_throwaway-target.mjs session` prints `{base, sessionId, token}` for driving
one session by hand. Throwaways are named `nimbus-tw-*`, live on
`workers.dev`, and get their own Durable Object namespace. Delete them when
you are done. Never deploy to `nimbus-os.dev`, versioned previews included —
its wildcard route serves live production.

Agent-specific probes:

- `tests/behavioral/agent/new/session-agent-panel.mjs`
- `tests/behavioral/editor/monaco/new/welcome-markdown-preview-default.mjs`
- `tests/behavioral/preview/new/tabbed-preview-auto-focus-port.mjs`
- `tests/behavioral/preview/new/vite-preview-dedupes-port-tab.mjs`
- `tests/behavioral/agentic-cli/new/node-child-process-primitives.mjs`
- `tests/behavioral/agentic-cli/new/node-live-vfs-async-fs.mjs`
- `tests/behavioral/agentic-cli/new/node-live-vfs-symlink.mjs`
- `tests/behavioral/agentic-cli/new/node-sync-cwd-project-snapshot.mjs`

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
