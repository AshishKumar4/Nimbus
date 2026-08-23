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
| `packages/fabric/src/process-fabric.ts` | Resident-process scheduler, boot specs, and `processes(ctx, env).spawn` — the one way a process becomes a running facet. Part of `@nimbus-sh/fabric`, the extracted Cloudflare DO/facet machinery (loader pools, facet host, alarm mux, binding shims). |
| `packages/worker/src/loaders/process-host.ts` | Which actor hosts that facet: the user's own session DO, or a sibling. Two implementations in `@nimbus-sh/fabric/process-host.js`; this selector owns the one deployment-wide choice (`NIMBUS_PROCESS_HOST`). |
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

Every resident process (node servers, python/ruby socket servers, the opencode
TUI and its headless server) is a DO Facet named `proc-<pid>`. **Which actor
hosts that facet is one deployment-wide var, `NIMBUS_PROCESS_HOST`:**

| Value | Where the process runs | Spawn | Memory | CPU |
|---|---|---|---|---|
| `facet` (default) | a child actor of the user's own session DO | ~250 ms p50 | independent | shared with siblings |
| `peer` | a child actor of a sibling session DO | ~1,400 ms p50 | independent | independent |

Both give the process its own SQLite, and both run the same code: a peer opens
it by calling the same `processes(ctx, env).spawn` on its own `ctx`. Peer routing costs
one extra DO hop, measured at +13 ms per request. Nothing per-process chooses:
no spawn site, program name, mode or payload size reaches the selection, and an
unrecognised value is refused rather than defaulted. Flip it on a target with
`bun tests/behavioral/_throwaway-target.mjs up --var NIMBUS_PROCESS_HOST:peer`,
and read back where a process actually landed by also setting
`--var NIMBUS_DEBUG:1` and watching the process log.

The Runtime OS target and honest support matrix are tracked in
`docs/architecture/nimbus-os-runtime-spec.md`. Keep docs and UI claims within
that support matrix unless a behavioral probe proves a larger capability.

## Engineering Bar

Nimbus is intended to push what a Workers + Durable Objects runtime can do. The
shell substrate is imported as Nimbus-owned source under
`packages/worker/src/substrate/lifo`. When it lacks a shell, parser, process,
PTY, filesystem, networking, package, or runtime primitive that Nimbus needs,
implement the missing capability cleanly. Put it in that substrate or another
proper Nimbus runtime boundary, not in a script-specific patch.

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

Embedders off Cloudflare have no R2 binding, so the same runtimes are also
published to npm: `@nimbus-sh/runtime-bash`, `@nimbus-sh/runtime-cpython`,
`@nimbus-sh/runtime-ruby` and `@nimbus-sh/runtime-clang`.
`NimbusWorkspace.create({ runtimes })` installs them into the workspace
filesystem at the path `nimbus install` uses. One script builds them all:
`bundle-runtime.mjs <name> <version> --npm-package <dir>` stages what the R2
path stages, and lays the blobs out under the keys its own manifest names. A runtime joins the npm set by gaining an `npm` entry in its spec.
`node` and `bun` have none, because they are workerd's `nodejs_compat` rather
than an artifact to ship.

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

Two kinds exist, for two different jobs.

**Staging** is the persistent one, and the right answer for "does this change
work". Run `bun run staging:deploy` then `bun run staging:test`. See
§ Staging And Promote.

**A throwaway** is for a one-off question. No shared secret needed, and gone
when you are done:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>

eval "$(bun tests/behavioral/_throwaway-target.mjs up)"   # exports BASE + NIMBUS_PROBE_TOKEN
bun tests/behavioral/run-all.mjs --no-retry
bun tests/behavioral/_throwaway-target.mjs down           # delete, and confirm it is gone
```

`_throwaway-target.mjs session` prints `{base, sessionId, token}` for driving
one session by hand. Throwaways are named `nimbus-tw-*`, live on
`workers.dev`, and get their own Durable Object namespace. Delete them when
you are done.

`up --var KEY:VALUE` overrides a config var for that deploy, which is how one
build gets stood up twice to compare two settings of it. Redeploying the same
name with a different `--var` keeps the secret, so tokens already minted stay
valid across the flip.

This is also what CI runs: the `behavioral` workflow deploys the commit
under test to its own `nimbus-tw-ci-*` throwaway, grades that, and deletes
it. `nimbus` is production and is never a target here.

**Running alongside other agents.** `run-all.mjs` takes a machine-wide lock
and refuses to start while another suite holds it, naming the holder;
`--allow-concurrent` is the deliberate override. A redeploy of either kind
of target keeps the `JWT_SECRET` already on it. Tokens minted earlier stay
valid, and a target can be redeployed under a suite already running against
it. Replacing that secret takes `--rotate-secrets`, and it 401s
every token in flight. Deploying over a target this checkout holds no secret
for (somebody else's throwaway, or staging after losing
`~/.local/state/nimbus`) stops before the build instead of taking it over.

Agent-specific probes:

- `tests/behavioral/agent/new/session-agent-panel.mjs`
- `tests/behavioral/editor/monaco/new/welcome-markdown-preview-default.mjs`
- `tests/behavioral/preview/new/tabbed-preview-auto-focus-port.mjs`
- `tests/behavioral/preview/new/vite-preview-dedupes-port-tab.mjs`
- `tests/behavioral/preview/new/vite-mount-base-per-door.mjs`
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
| Deploy the dev stack (`nimbus-dev`) | `bun run deploy` |
| Deploy staging (`nimbus-staging` + `nimbus-probe-staging`) | `bun run staging:deploy` |
| Behavioral suite against staging | `bun run staging:test` |
| What staging is serving right now | `bun run staging:status` |
| Deploy production (`nimbus`) | `bun run deploy:production` |
| Dry-run production deploy | `bun run --cwd apps/hosted-demo wrangler deploy -e production --dry-run --outdir /tmp/wrangler-build` |
| Check deploy isolation | `bun scripts/deploy-isolation.mjs` |
| Check dist matches src | `bun scripts/dist-integrity.mjs` |

The root `predev` script regenerates worker bundles.

Every deploy path (`predeploy`, `deploy:production`, the throwaway and
staging targets) runs `scripts/dist-integrity.mjs` instead of a build. It
compiles `src` → `dist`, bundles (which reads `dist`), rebuilds so the
regenerated artifacts reach `dist`, and refuses the deploy if any of that
changed a file. `dist` is tracked and wrangler ships `dist`, so a commit
whose `dist` predates its `src` deploys a Worker missing changes its own
source contains. The gate makes that a refusal rather than a silent no-op
deploy. It adds ~6s. When it refuses, the tree it refused has already been
rebuilt: review the diff, commit it, deploy again.

**Production is `wrangler deploy -e production`, and nothing else.**
`apps/hosted-demo/wrangler.jsonc` has three tiers, each naming its own
database, rate-limit namespace and Worker:

| Tier | Worker | Database | Reached by |
|---|---|---|---|
| top-level (development) | `nimbus-dev` | `nimbus-demo-dev` | `bun run deploy`, and any `--name` override |
| `env.staging` | `nimbus-staging` | `nimbus-demo-staging` | `bun run staging:deploy` |
| `env.production` | `nimbus` | `nimbus-demo` | `bun run deploy:production` |

That split is load-bearing. `wrangler deploy --name foo` overrides ONLY the
name, and every binding still comes from the block being deployed. Two
throwaway probes wrote rows into the live demo D1 that way: one deployed from
`apps/hosted-demo` by hand, one from a copy of the config with `env` stripped
out. Both looked isolated; neither was.

So **verify a deploy's bindings before sending it a request, rather than
trusting the directory it came from.** `bun scripts/deploy-isolation.mjs`
answers it for every target the repo can name: each config's default block
and each non-production env block, enumerated from the files. The staging and
throwaway scripts run the same check before they invoke wrangler, and
`tests/unit/deploy-isolation.mjs` holds the line in CI.

A deploy that dies during **asset upload still creates the script**, so a
failed deploy is not "nothing to clean up". `wrangler deploy` can fail that way and
**still exit 0**, so a green probe run proves nothing about which build it ran
against. Verify by version id, never by exit status. `_deploy-target.mjs`'s
`deployAndVerify` reads the active version back from the API and refuses a
deploy that did not change it. Enumerate scripts with
`GET /accounts/<id>/workers/scripts`. A 404 on the workers.dev hostname does
not mean the script is absent.

## Staging And Promote

Staging is two Workers, deployed from one `dist` by one command, because
production is two surfaces and verifying one does not verify the other:

- **`nimbus-staging`** — `apps/hosted-demo`, `env.staging`. The product
  mirror: same `main`, same `dist/assets` (shell + `/docs`), same inherited
  smart placement, same cleanup cron, its own D1 and rate-limit namespace.
  Its `POST /new` is gated on an interactive Cloudflare cookie exactly as
  production's is, so the demo's own surfaces (login, the anonymous docs
  terminal, session cleanup) are verified here in a browser.
- **`nimbus-probe-staging`** — `apps/probe` under a `--name` override. The
  bearer-token embedder the behavioral suite can drive. It binds no
  account-level state of its own, so a name override is complete isolation
  and the preflight proves it. An env block would only copy an identical
  binding list.

Two known divergences from production, both structural: staging has no zone
route (it answers on `workers.dev`) and therefore no
`NIMBUS_PREVIEW_HOST_SUFFIX`, so **host-based port previews**
(`<port>--<sid>.<suffix>`) are off there. Path-based `/s/<sid>/port/<n>/` is
unaffected. Verify host previews on prod's zone or a throwaway with a zone
route.

### Promote

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>

bun run staging:deploy          # build → deploy both → assert version ids
bun run staging:test --no-retry # the full suite, CI-strict
# browser-check https://nimbus-staging.<subdomain>.workers.dev — login,
# /docs terminal, a session — for anything touching apps/hosted-demo/src

git commit && git push          # dist is tracked; commit what the build changed
bun run deploy:production
bun run --cwd apps/hosted-demo wrangler deployments status --name nimbus
```

Rollback is `wrangler versions deploy --name nimbus <previous-version-id>`;
`wrangler deployments list --name nimbus` has the ids.

**The hazard is the deploy target, never the hostname.** `wrangler versions
upload -e production` and `wrangler deploy -e production` both act on the
Worker named `nimbus`. The first appends to the live script's version list,
and the second shifts its traffic. Neither is a way to "test without touching
prod", and visiting a preview URL afterwards does not make it one.
Isolation is a distinct Worker name: `nimbus-staging`,
`nimbus-probe-staging`, or a `nimbus-tw-*` throwaway.

Versioned preview URLs are not a verification path here, whatever the
`preview_urls` key suggests. Measured 2026-08-05 on `nimbus-staging` with
wrangler 4.98.0: neither `wrangler deploy` nor `wrangler versions upload`
prints one, and `<version-prefix>-<worker>.<subdomain>.workers.dev` 404s for
version ids that exist. A hostname is never the isolation either. Every
subdomain of `nimbus-os.dev` resolves and answers 200, because the zone's
`*` route hands them all to the production Worker (measured 2026-08-04,
`deadbeef.nimbus-os.dev`).

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
- To read a file at another ref, use `git show <ref>:<path>`, or a worktree
  already at that ref. `git checkout <ref> -- <path>` writes the index as well
  as the working tree, so it stages a diff without saying so. It also mixes
  trees: another ref's tests run against this branch's source and fail for
  reasons that are not real.
- `git status --short` prints two columns, staged then unstaged. Read both
  before committing, and confirm with `git show --stat HEAD` that the commit
  carries the files its message claims.
