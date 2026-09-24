# Changelog

An AI assistant maintains this changelog. It is provided as-is.
All notable Nimbus releases are summarized here. Package-level versions are
published independently in the `@nimbus-sh` npm scope.

## 2026-09-23

### esbuild

- `esbuild` in the shell is the real esbuild CLI, 0.24.2's own Go program, run
  in the session's esbuild facet (the one that already ran its transforms) as
  the calling user from the working directory, with its output streamed back
  as it is written. Its flags, defaults and messages are esbuild's: entry points,
  `--outfile`, `--outdir` and `--tsconfig` resolve against the cwd, outputs
  belong to the user, and a build with neither output flag writes to stdout.
  It used to write `/dist/...` as root.
- The build no longer runs in the session's isolate. esbuild-wasm's memory
  (28 MiB at init, 76 MiB after one React bundle, never released) used to stay
  there, and `nimbus install python` after a few bundles reset the session
  with exceededMemory.
- `--watch` and `--serve` are refused, because each invocation is one build.
- `vite build` bundles in that facet too, each build with a fresh esbuild
  that is dropped afterwards. Resolving and loading still read the session's
  files. Three React builds in a row used to take the session isolate to
  150-186 MiB, and on main one run in three reset. Now it peaks at
  101-109 MiB.
- A launch sends its ESM modules to the esbuild facet in 4 MiB slices. A
  slice whose call fails (the facet reset, the connection dropped) is sent
  once more to a fresh facet. If it fails again, only its own modules fail,
  and only for that launch. It used to fail every module of the launch,
  including the ones already transformed.

### Runtimes

- `node main.mts` and `node main.cts` compile their entry as TypeScript, as
  `.ts` and `.tsx` entries already did. A `.cts` entry is CommonJS TypeScript
  even in a `"type": "module"` package. Both used to reach the facet
  uncompiled and fail on their first type annotation or `import`.

## 2026-09-21

core 0.11.0, worker 0.9.0, sdk 0.8.0, fabric 0.7.0, platform 0.5.0,
cli 0.1.11, react 0.1.7, loom 0.1.3.

### One filesystem authority

- Every filesystem call from the shell, Node, Python, Ruby, Clang and Bash
  goes through one credential-bound authority with live descriptors. The
  per-process snapshot and diff transport is gone; a guest reads and writes
  the same inodes the shell does, and permission denials come from the same
  check.
- Read-only opens of regular files are resident descriptors keyed by inode
  and validated by stat revision: one stat per open, one read per revision.
  CPython's `import urllib.request` went from 1,330 supervisor round trips
  to 254.
- Descriptor reads, writes and closes are native supervisor ops; the worker's
  read accounting is a `readLease` hook on the op tools.
- `unlink` on a missing name answers ENOENT again; `rm` and `rm -f` differ.

### Runtimes and catalog

- A runtime rebuilt against a new runner contract publishes under a new
  version whose manifest names a new runner key (`bash-runner@2`,
  `BASH_RUNNER` in `os-contracts`). `RuntimeManager` resolves a bare name to
  the newest catalog version this workspace can bind; an explicit
  `name@version` is refused rather than substituted. `bundle-runtime.mjs`
  gained `--keep-default` and lists versions in publish order.
- bash 5.2.37-2: every WASI and `nimbus_proc` import instrumented for
  Asyncify, cwd capture, real `F_GETFD`.

### Platform fixes measured on workerd

- Durable Objects SQLite binds at most 100 parameters per statement
  (`SQL_MAX_BOUND_PARAMETERS`); every batch and IN-list is sized from it.
  A 12-column inode row had crossed it and broken npm installs of nine or
  more files.
- A facet's fixed-length Response returned as-is across the port hop fails
  "disconnected prematurely" on workerd 1.20260811.1+ and truncates under
  gzip; the hop now relays bodies through an isolate-owned stream.
- workerd's RPC promise is a callable thenable, not a Promise; the
  supervisor adapter detects it by shape and never takes a synchronous view
  from a stub.
- WASI guests keep POSIX semantics: absolute paths under the cwd preopen,
  directory opens with write rights requested, `fd_allocate`, `path_link`.
- `node:module` answers `enableCompileCache` and `isBuiltin` (pi's CLI
  entry calls the former unconditionally).

### Deploy

- The Worker ships minified with its source map uploaded: 4.12 MB raw,
  1.12 MB gzipped.

## 2026-09-22

For embedders that host Nimbus under their own Durable Object namespace.
Ships in the same versions as the release below (core 0.12.0, worker
0.10.0, platform 0.5.1, fabric 0.7.1), which had not been published yet.

### Fabric

- The route back to the host (namespace binding, dispatch method,
  supervisor entrypoint) is minted into every binding the fabric hands a
  program, in the host's isolate, and the entrypoints that answer those
  bindings (`SupervisorRPC`, `NimbusAssetsRPC`, `NimbusDOStub`,
  `NimbusLoadedEntrypoint`, `CirrusHmrRPC`) read it from their props. A
  facet whose call landed in an isolate with no composition, or another
  host's, was refused with "env.NIMBUS_SESSION is not a Durable Object
  namespace"; it now reaches the host that minted its binding. Fan-out peers
  and peer process hosts mint the coordinator's route, not their own.
- `composeFabric` called again with different values throws, naming both
  compositions. It was first-write-wins and silent, so a Worker that
  imported Nimbus's own entry and composed its own host ran against a host
  it never named.
- The bare workspace's refusal of a host op names the contract: forward
  `supervisorOp` to a hosted runtime on every instance of the namespace,
  the siblings Nimbus opens by name included.

### git

- `git -C <path> …` runs the subcommand from `<path>` (repeatable, each
  relative to the previous). `--no-pager`/`-P` are accepted. Any other
  leading option is refused instead of being run as the subcommand.
- `git branch --show-current` prints the current branch (nothing on a
  detached HEAD). It used to create a branch named `--show-current`; an
  unrecognized option is now refused rather than taken as a branch name.
- `git clone -q`/`--quiet` clones without progress output; `-v`/`--verbose`
  is accepted.

### Signatures

- `HostRoute` and `hostRoute()` are exported from
  `@nimbus-sh/platform/composition.js` (re-exported by the fabric).
- `hostNamespaceBinding(env, usage, route?)` and
  `hostOpDispatch(stub, usage, route?)` take an optional route.
- `supervisorEntrypoint(exports?, name?)` takes the entrypoint name.
- `ResidentSupervisorProps.route: HostRoute` is required;
  `HostProcessOpts.route: HostRoute` is required;
  `IsolatePoolOptions.supervisorRoute?: HostRoute`.
- `SupervisorOpDispatch` names the handler type
  `createSupervisorOpHandler` returns (was `ReturnType<…>` at consumers).
- `parseCloneArgs` returns `quiet: boolean`; `parseGitGlobals(args, cwd)`
  is exported from the worker's git commands.

## 2026-09-21 (third release)

For embedders composing the hosted runtime. Every public signature that
changed is listed under "Signatures". Published as core 0.12.0, worker
0.10.0, platform 0.5.1, fabric 0.7.1, sdk 0.8.1, cli 0.1.12, loom 0.1.4;
the carets are minor-strict, so every range moves.

### npm

- `NPM_REGISTRY` is honoured end to end: the hosted `npm install`, `npm
  install -g`, `npx` and `npm create` paths read packuments from that
  origin; the resolve facet asks the supervisor for that origin; the shared
  R2 packument cache keys per origin, so a mirror never serves, nor fills,
  the npmjs entries. The value is normalized once, where the command reads
  it (blank is unset, a trailing slash is trimmed).

### VFS

- Construction writes nothing to a store that is already current. The
  identity row, the device row, the inode allocator seed, the ino backfill
  and the schema migration marker are each preceded by the read that
  decides them, and every DDL step is `IF NOT EXISTS`. A `SqliteVFS` opens
  over a readonly SQLite handle and reads; a write on it is refused by
  SQLite, not by the open.

### Hosted runtime

- `composeHostedRuntime(...)` returns `facets()`, the composed facet
  manager, beside `files`, `runtimes` and `terminal`.
- `@nimbus-sh/worker/workspace-host` re-exports the
  `LongRunningWorkerSpawnOptions` type with `WorkerRecipe` and
  `ResolvedWorkerLaunch`.
- Five subpaths join the `@nimbus-sh/worker` export map, under the paths an
  embedder was deep-importing: `./session/programmatic`, `./session/rpc`,
  `./session/supervisor-rpc`, `./session/routes` and
  `./runtime/package-manager`.

### Signatures

- `NpmInstallPort.install(spec)`: `spec.registry: string` is required (the
  normalized origin). Core and worker.
- `NpmInstaller.install(cwd, opts)`: `opts.registry?: string`.
- `resolveNpxBinary(installer, vfs, cwd, args, log, pid?, registry?)`: one
  trailing optional parameter.
- `R2CacheClient.getPackument(name, registry?)`,
  `putPackument(name, json, registry?)`,
  `readThroughPackument(name, { retries?, timeoutMs?, registry? })`;
  `packumentUrl`, `packumentKey`, `packumentL2Url` take `registry?` last.
  The default is unchanged.
- `npmRegistryOrigin(configured)` and `NPM_REGISTRY_ORIGIN` are exported from
  `@nimbus-sh/core/substrate/lifo/commands/system/npm.js` and re-exported
  from the worker's `npm/r2-cache.js`.
- `composeHostedRuntime(options)`: `options.resolveWorkerLaunch` is a flat
  option (it moved out of `hooks` in the 0.9.0 line); `facets()` is added to
  the return. `composeFacetManager(deps)` requires `deps.filesystem`
  (unchanged this release, listed because the previous handoff omitted it).

## 2026-09-21 (second release)

### npm: nested placements

- A dependency whose range the root copy does not satisfy is installed
  under its dependent (`<dep>/node_modules/<name>`) instead of being
  hoisted broken; peer dependencies reuse whatever the host's walk finds
  and never nest. The lockfile keys placements by path; a tarball placed
  twice in one batch is fetched once.

### Node facets

- One compile helper for the one-shot and long-running facets: a required
  module that keeps its shebang (pi 0.87.0's `cli-runtime.js`) compiles in
  both.
- A facet's own partial mutation (ranged write, truncate, utimes, chmod,
  chown) holds its resident cell under a lease until the authority's
  receipt settles it; a barrier answered ahead of the write no longer
  evicts the bytes the program just wrote.
- The ESM transform cache is bounded by bytes and reported to the heap
  model; the two retained caches share the room the ceiling leaves. A
  pi-sized tool's second launch no longer resets the session.
- `node -` runs the program on stdin, arguments after `process.argv[1]`.

### Session

- A session with a running resident process holds itself in memory on an
  alarm cycle while a client is present (an attached socket, or a request
  within the last sixty seconds), instead of being evicted after ten idle
  seconds. Past that, it idles out as before and the launch journal
  re-drives the process when the client returns. (Bounded 2026-09-22; the
  first cut held every abandoned dev server forever.)
- `wait $!` answers a successful job's status instead of 127.
- `/api/_diag/memory` reports the prefetch cache's entries, revisions and
  miss profiles.

### Deploy

- The esbuild-wasm JS adapter is a staged asset beside its wasm, digest
  checked; the Worker bundle drops back under the repo's 7.0 MB tripwire.

## 2026-09-19

core 0.10.0, fabric 0.6.0, worker 0.8.0, sdk 0.7.0, loom 0.1.2, cli 0.1.10,
react 0.1.6.

- Add supported runtime composition for application-owned Durable Objects through
  `@nimbus-sh/worker/workspace-host` and `@nimbus-sh/worker/facet-host`.
  Hosts retain ownership of storage, alarms, and lifecycle.
- Share workspace commands, runtimes, processes, terminals, and port routing
  with NimbusSession. No private Session adapter or fake WebSocket boot is required.
- Add instance-scoped runtime provisioning with eager and on-demand installation,
  verified rehydration, and interrupted-install recovery.
- Fix opencode byte output and dynamic-import analysis. Bundled provided packages
  now use the same runtime adapter as ordinary package imports.
- Fixed compiler privilege escalation: `EsbuildService` now accepts a
  `CredentialedVfs` instead of a raw `SqliteVFS`. Embedders compiling authored
  code must pass the author's view (`new EsbuildService(vfs.as(authorCred))`);
  kernel callers explicitly pass `vfs.as(CRED_KERNEL)`. Transform-only use
  still needs no VFS. Absolute and transitive imports cannot read beyond the
  supplied view's authority.
- Fixed failed VFS metadata writes publishing uncommitted times, modes or
  ownership in memory. Added `SqliteVFS.withTransaction(callback)` for embedders
  committing their SQL rows together with filesystem writes: rollback restores
  the inode/content mirror, and revisions/watch events publish only on commit.

## 2026-09-15

worker 0.7.0, sdk 0.6.0, core 0.9.0, fabric 0.5.0, platform 0.4.0,
config 0.2.1.

### @nimbus-sh/core (breaking)

- **Bytes, not text, on process output hooks.** `onStdout`/`onStderr` on
  lifo `Sandbox`'s `CommandOptions`, the shell's `ExecuteOptions`, and the
  shell-entrypoint/programmatic surfaces now receive `Uint8Array`, not
  `string`. Migrate with `new TextDecoder().decode(data)` or the exported
  `textSink` from `@nimbus-sh/core/_shared/bytes.js`. This fixes binary
  protocols (esbuild's service packets, image/archive pipes) mangling to
  U+FFFD through the parent→child stdin and child→parent stdout relays.
- `NpmInstallPort` shape change: `install` takes a spec
  (`{ projectDir, packages, global, globalBinDir, production, npmLog,
  onProgress }`) — the arg parsing, prefix derivation, and end-of-install
  summary moved into the core command; the port owns only the installer
  and bin materialisation. `registerLocalBins` is gone from the port path.
- `npm install` parity: policy refusals become advisories, platform gates
  stay refusals — a package the runtime cannot run is refused with its
  reason instead of silently skipped; transitive 'warn' rejects retired;
  toolchain installs like plain JS; devDependencies are required roots;
  unsupported native packages are skipped without aborting the install.
- `exec` lifetime: a user-invoked program has no wall-clock lifetime —
  the 30s internal cap and its deadline machinery are removed; Ctrl-C now
  wires to the run's abort signal so a kill ends the run as a signal, not
  a crash.

### @nimbus-sh/worker

- Child stdout/stdin carry `Uint8Array` end to end (see core breaking note):
  process output hooks, the durability stub, and the terminal/log-ring
  decoders all consume bytes, decoding at the edge per stream.
- Cell `import()` resolves through the cell's own require — fixes Vite's
  dynamic `import("node:http")` returning a server that bound no port.
- Every wasm image in a program's closure is a module-map entry by digest,
  and a `WebAssembly.Module`/`compile`/`instantiate` seam answers
  registered bytes (tagged by path or by content) — so a package's own
  synchronous wasm compile works instead of being refused at request time.
- `box.files.as(cred)` — a credential-bound view of the session file plane
  for embedders.
- `composeFacetManager` — one facet-manager composition shared by the
  session and embedders; worker launches carry text modules and a main
  module and return their facet.
- Public URL per process: `nimbus expose <port> --public` serves with the
  capability alone (no Authorization); removal releases it.
- The durability stub decodes the byte relay before inspecting it; a kill
  reports exit as a signal; a hibernated object's shell rebuilds on the
  waking socket; exec bundle builds page across DO turns so `node -e` in
  a 752-package tree starts without a bundle deadline.

### @nimbus-sh/sdk

- `exec`/`startProcess` resolve a relative `cwd` against the sandbox root
  before the RPC leaves the client; the session rejects a non-absolute cwd
  with a field-named error.
- Command output hooks consume `Uint8Array` (see core breaking note).

### @nimbus-sh/fabric

- `materialize` takes images one at a time (async iterable) instead of all
  at once — a resident launch no longer holds the whole image set.
- Loader cache key carries the baked supervisor identity; IsolatePool
  dispatches serialize per slot.

### @nimbus-sh/platform

- A credit claim that can never be granted is refused, not parked — the
  FIFO no longer stalls the whole isolate behind one oversized request.

### @nimbus-sh/config

- Patch bump; no user-visible change.

## 2026-08-11

The first publish since 2026-06-06. Everything on npm until now was built from
that day's tree, so the jump is large — this entry covers only what changes for
someone consuming the packages, not the several hundred commits behind it.

### Background Processes (breaking)

- `startProcess` now returns as soon as the command has a pid, instead of
  waiting for it to finish. Until now it awaited the command to completion and
  then guessed which pid it had started by diffing the process table, so
  `sleep 5` took five seconds and dev servers, watchers, and anything else
  long-running were impossible.
- `NimbusStartResult` changed shape to match: it is now
  `{ command, pid, process, ports, startedAt }`. The exec fields it used to
  carry — `exitCode`, `stdout`, `stderr`, `success`, `duration`, `timestamp` —
  are gone, because they described a finished command and cannot describe one
  that has just started. `pid` and `process` are no longer nullable.
- Read the output and the exit through `processes.logs(pid)`, which returns a
  cursor, the chunks since that cursor, and the exit record once it lands. Or
  use `processes.attach(pid)`, which is async-iterable and can also write to
  stdin, resize, signal, and kill.
- **If you read `exitCode` or `stdout` off a `startProcess` result, that code
  needs updating.** This is the reason both packages move to `0.2.0` rather
  than a patch: a `^0.1.x` range will not pick the new versions up, which is
  deliberate.

### Files

- Added `files.lstat`, `files.rename`, `files.chmod`, and `files.readRange`.
  `readRange` reads a window of a file without materializing the whole thing.
- `processes.logs` is now typed as `NimbusProcessLogsResult` instead of
  `unknown`.

### Port Previews

- Added preview host URLs — `<port>--<session>.<suffix>` — alongside the
  existing path-style previews. Set `NIMBUS_PREVIEW_HOST_SUFFIX` on the
  deployment; `Nimbus.fromEnv` reads it off the bindings, and remote clients
  pass `previewHostSuffix` in config. A preview host reaches the port forward
  and nothing else.
- Added `isPreviewHostRequest` and the `@nimbus-sh/worker/preview-host`
  subpath.

### Session Agent

- Added the session agent and its Cloudflare OAuth surface, with the
  credentials held in encrypted cookies. `@nimbus-sh/config` takes an optional
  `agent` block; the secrets stay out of it and belong in
  `wrangler secret put`.

### Fixes

- Fixed remote `files.write` throwing after the write had already landed. The
  client validated the result against `z.undefined()` while the Durable Object
  answers with the byte count it wrote. This one never reached npm — it was
  introduced and fixed between releases — but it is here because anyone
  tracking `main` in that window hit it.
- `nimbus session new` authenticates with a bearer token.

### Packages

- Published:
  - `@nimbus-sh/worker@0.2.0`
  - `@nimbus-sh/sdk@0.2.0`
  - `@nimbus-sh/cli@0.1.8`
  - `@nimbus-sh/react@0.1.4`
  - `@nimbus-sh/config@0.1.4`
- Unchanged, not republished: `create-nimbus-app@0.1.6`.
- `@nimbus-sh/react@0.1.4` is a range fix and nothing else — every shipped
  file is byte-identical to `0.1.3`. Its peer on the SDK was `^0.1.4`, which
  npm cannot satisfy with `0.2.0`, so installing the new SDK beside the React
  component failed to resolve. It now accepts `^0.1.4 || ^0.2.0`. The
  component imports nothing from the SDK — it is an iframe wrapper — so the
  breaking type change does not reach it.
- `@nimbus-sh/sdk` needs `@nimbus-sh/worker` at the matching major-equivalent
  range: it imports `@nimbus-sh/worker/preview-host` at runtime, and that
  subpath does not exist before `0.2.0`.

## 2026-06-05

### Open-source Alpha

- Added root and package-level MIT license files.
- Added third-party notices for runtime and package dependencies.
- Added contribution, security, code-of-conduct, issue-template, and
  pull-request-template docs.
- Updated public README positioning for the free self-hostable alpha and the
  hosted demo limits.
- Switched the public workspace lockfile to `bun.lock` and removed the old
  npm lockfile.
- Removed wall-clock timestamps from generated worker bundles.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.3`
  - `@nimbus-sh/config@0.1.2`
  - `@nimbus-sh/sdk@0.1.3`
  - `@nimbus-sh/react@0.1.2`
  - `@nimbus-sh/cli@0.1.6`
  - `create-nimbus-app@0.1.5`

## 2026-06-04

### Sandbox SDK

- Added the programmatic sandbox SDK in `@nimbus-sh/sdk/sandbox`.
- Added direct Worker/Durable Object binding support with `Nimbus.fromEnv(...)`.
- Added authenticated remote sandbox access with `Nimbus.connect(...)`.
- Added sandbox lifecycle, command execution, code execution, files, runtimes,
  processes, preview ports, capability reporting, and tool-provider helpers.
- Added runtime policy enforcement for allowed, preinstalled, and on-demand
  runtimes.

### Worker Embedder

- Added the public remote SDK API route under `/api/nimbus/v1`.
- Added tenant-scoped session IDs and SDK-safe sandbox IDs.
- Updated the hosted-demo app to use the same SDK-facing Worker entrypoint that
  generated apps use.
- Added live SDK smoke routes for direct-binding and remote-client paths.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.2`
  - `@nimbus-sh/config@0.1.1`
  - `@nimbus-sh/sdk@0.1.2`
  - `@nimbus-sh/react@0.1.1`
  - `@nimbus-sh/cli@0.1.5`
  - `create-nimbus-app@0.1.4`

## 2026-05-16

### Workspace And Auth

- Restructured Nimbus as a Bun workspace with packages for the Worker runtime,
  SDK, React bindings, CLI, config helper, and hosted-demo app.
- Added HS256 JWT session tokens with tenant and subject isolation.
- Added authenticated and legacy-public Worker handler modes.

### Worker Assets

- Moved large runtime assets out of the Worker bundle and into the Workers
  Assets binding.
- Added asset loading helpers with isolate-local caching and concurrent request
  deduplication.

## 2026-05-11

### Runtime Surface

- Added Python and Ruby runtime support.
- Added Node and Bun REPL surfaces appropriate for the Workers runtime.
- Expanded WASI preview1 support, including file metadata, symlinks, outbound
  TCP, socket shutdown, and polling.
- Added clang support for WASI programs, multi-file compilation, user headers,
  and WASI execution.

### Shell And Compatibility

- Expanded shell behavior across redirects, pipelines, command substitution,
  heredocs, symlinks, process variables, and common Unix utilities.
- Improved package resolution for `package.json` `main`, `exports`, and
  `imports` fields.
- Added behavioral probes for runtimes, package installation, shell behavior,
  WASI, framework execution, and preview routing.

## Earlier

- Established the Durable Object session model.
- Added the SQLite-backed virtual filesystem.
- Added npm install support with R2-backed package caching.
- Added Worker Loader based execution facets.
- Added process logs, preview routing, Vite integration, and session recovery.
