# Nimbus OS Runtime Compatibility Spec

Last refreshed: 2026-06-06

This document defines the runtime compatibility target for Nimbus as a
Durable Object backed operating environment. It is source-backed by the
current implementation in `packages/worker/src`, `packages/sdk/src`, and the
behavioral probe suite under `tests/behavioral`.

The goal is to make Nimbus feel like a small cloud-native OS: persistent
files, shell commands, language runtimes, package managers, processes, ports,
and agent tooling. Compatibility must be real. Nimbus should provide
Linux-like and POSIX-like behavior through Nimbus-native binaries, libraries,
syscalls, and adapters, but it must not claim to execute arbitrary Linux ELF
binaries or native Linux wheels.

Nimbus was built against a mix of public, experimental, and internal Workers
and Durable Objects capabilities. Public Cloudflare docs are useful for
checking broad platform constraints, but they are not allowed to override
working Nimbus architecture by themselves. If source code relies on an
internal or experimental capability, preserve it unless current runtime
evidence proves it is broken or Cloudflare has removed the behavior.

## Source Of Truth

The current implementation, not older docs, is the source of truth.

Important source areas:

| Area | Current source |
|---|---|
| Durable Object session | `packages/worker/src/session/nimbus-session.ts` |
| Programmatic sandbox RPC | `packages/worker/src/session/programmatic.ts` |
| SDK sandbox handle | `packages/sdk/src/sandbox.ts` |
| SQLite VFS | `packages/worker/src/vfs/sqlite-vfs.ts` |
| VFS event bus and browser file watch | `packages/worker/src/session/fs-watch.ts` |
| Runtime package manager | `packages/worker/src/runtime/package-manager.ts` |
| Runtime OS contracts | `packages/worker/src/runtime/os-contracts.ts` |
| SQLite runtime FS bridge | `packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts` |
| WASI/POSIX shim | `packages/worker/src/runtime/wasi-instance.ts` |
| Node compatibility shims | `packages/worker/src/runtime/node-shims.ts` |
| Python runner | `packages/worker/src/runtime/python-runner.ts` |
| Ruby runner | `packages/worker/src/runtime/ruby-runner.ts` |
| Preview port registry | `packages/worker/src/runtime/port-registry.ts` |

External platform constraints checked for this spec:

- Cloudflare Workers run on V8 and WebAssembly, but block runtime wasm
  compilation from raw buffers unless wasm is supplied through the supported
  module path.
- Durable Objects provide strongly consistent per-object state and SQLite
  storage.
- Workers support WebSockets and Durable Object WebSocket coordination.
- Workers support outbound TCP APIs, but Nimbus still needs to expose those
  through its own WASI and Node compatibility layers.
- Pyodide binary packages use the PyEmscripten ABI, but Workers only allow
  those wasm modules when they are supplied through the startup module path.
- ruby.wasm is a CRuby port for WASI and edge/browser runtimes, not a Linux
  native Ruby.

## Current State

### Implemented And Substantial

Nimbus already has a real base:

- A session-scoped Durable Object with persistent SQLite-backed VFS,
  shell state, process metadata, port routing, hibernation support, and
  dynamic Worker facets.
- A programmatic SDK in `packages/sdk/src/sandbox.ts` with colocated
  `Nimbus.fromEnv(...)`, remote `Nimbus.connect(...)`, and a `NimbusSandbox`
  handle for `ready`, `exec`, `runCode`, files, runtimes, processes, ports,
  capabilities, and agent tools.
- A runtime package manager with catalog install, runtime rehydration,
  command aliases, and install hints for missing commands.
- WASI `snapshot_preview1` coverage for arguments, environment, clocks,
  random, stdio, file descriptors, directory traversal, path operations,
  symlinks, minimal `path_link` coverage, file timestamps, `fd_allocate`,
  `proc_raise`, `poll_oneoff`, and outbound TCP through a synthetic
  `/dev/tcp/host/port` path. Full hard-link inode/mutation semantics are not
  complete.
- Node-like compatibility shims for many common modules: `fs`, `path`, `os`,
  `process`, `Buffer`, `events`, streams, `crypto`, `zlib`, DNS, HTTP,
  HTTPS, `child_process`, `readline`, `tty`, timers, and related utility
  modules. `net` is only partially shaped today: HTTP preview bridging exists,
  but general `net.Socket` connect/listen semantics remain honest unsupported
  or transitional paths.
- Node async filesystem calls (`fs.readFile`, `fs.stat`, `fs.readdir`,
  `fs.access`, `fs.promises.*`, and `FileHandle` reads/stats) can fall back
  to the session supervisor for live SQLite VFS data through the shared
  runtime filesystem bridge, including files created by child processes after
  the dynamic Worker starts.
- Shared runtime contracts exist for filesystem, process, port, package ABI,
  command provider, TTY options, and diagnostics. `SqliteRuntimeFsBridge`
  implements the filesystem contract on top of `SqliteVFS`, revision checks,
  the VFS event bus, and the existing symlink registry. Supervisor file RPCs
  route through this bridge.
- Node sync filesystem calls run from a startup snapshot for speed. The
  snapshot includes the entry dependency graph and a bounded current-working
  tree project snapshot, excluding `node_modules`, `.git`, and `.nimbus`.
- Real Request/Response preview routing through `PortRegistry` without JSON
  serialization. Some current runtime adapters still buffer internally; the
  final socket/preview adapters should stream end to end.
- A VFS event bus with coalesced browser file-watch delivery.
- Behavioral probes for SDK, shell compatibility, runtime package install,
  npm/npx, child process primitives, WASI, clang, Python basics, Ruby basics,
  file watching, and preview ports.

### Implemented But Not Final

These areas exist, but are not yet good enough for Nimbus OS quality:

- Python currently runs through Pyodide and has command execution, script
  execution, stdlib, VFS-backed imports/file IO, command aliases, REPL
  support, `pip`/`pip3`, `python -m pip`, requirements-file installs, local
  pure-wheel installs, constraints, extras, environment markers, PyPI pure
  wheel resolution, persistent `site-packages`, declared Pyodide startup-module
  package artifacts, and deterministic native wheel ABI diagnostics. It does
  not provide build isolation, general compiled extension builds, arbitrary
  Pyodide/Emscripten package catalogs, or a complete upstream `pip` CLI
  contract. Nimbus rejects request-time extension module loading because Workers
  cannot compile arbitrary wasm after startup.
- Ruby currently runs through ruby.wasm and has basic command execution,
  script execution, stdlib, VFS-backed require/file IO, command aliases, and
  REPL support. `gem`, `bundle`, and `bundler` install compatible pure Ruby
  gems from RubyGems.org into persistent `GEM_HOME`, support simple Gemfiles,
  generate a Nimbus lockfile, and reject native-extension gems with a precise
  ABI diagnostic. Full Bundler resolution and native-extension builds are not
  implemented.
- Python and Ruby command runners use bounded VFS snapshots plus diff flushes.
  That is acceptable for short one-shot commands, but it is not the final
  live OS model.
- Python virtual-socket previews are production-probed for Flask,
  `python -m flask run`, and `python -m http.server`. Ruby virtual-socket
  previews are production-probed for WEBrick and Rack. Broader WSGI/ASGI/Rack
  framework coverage still needs ABI-aware package resolution and more probes.
- Node synchronous `fs` calls still operate on the startup snapshot/write cache
  in dynamic Worker contexts. Async reads and common async mutations use the
  live supervisor bridge, but the final contract still needs a revision-aware
  file-handle/page-cache design for high-volume long-lived workloads.
- Agentic CLI support has production probes for Node process primitives,
  foreground attached npm-bin TTY tabs, Pi's official installer path, the Pi
  npm CLI path, package-bin exit/shebang behavior, and opencode's installer and
  native npm package reaching explicit unsupported native ABI diagnostics.
  Unmodified opencode and the local Proteus CLI are not
  yet proven as working Nimbus workloads; native-package shards still need
  Nimbus ABI artifacts or precise diagnostics.
- The shell has a structured lexer/parser/interpreter for common POSIX-like
  constructs, including many redirects and subshell/group forms, but it is not
  complete POSIX shell parity. The final OS shell still needs broader structured
  expansion, quoting, heredoc, trap, signal, job-control, and script semantics.

### Not Implemented Yet

Nimbus is not yet a complete OS replacement:

- No Linux ELF loader.
- No Docker, VM images, `apt`, or native Linux package manager.
- No native Linux Python wheels.
- No general Python extension build pipeline inside Nimbus.
- No complete Bundler-compatible resolver.
- No native Ruby extension build pipeline inside Nimbus.
- No general pthread or `wasi-threads` support.
- No raw inbound TCP listener. HTTP preview ports are supported; raw local TCP
  servers need Nimbus virtual sockets or a runtime adapter.

## Known User-Visible Gaps

The following gaps are confirmed by source inspection and user-visible runtime
behavior. They must stay documented until production probes prove otherwise.

| Gap | Current behavior | Required OS behavior |
|---|---|---|
| opencode/Proteus CLIs | Pi's npm CLI path is production-probed. opencode is production-probed only to the installer/native ABI boundary, not as an unmodified working CLI. The local Proteus CLI is not yet proven in live Nimbus. | JavaScript CLIs launched from the terminal should see TTY=true when attached, TTY=false when piped, and should run unmodified unless they require unsupported native shards. |
| Python package breadth | Flask and MarkupSafe pure-source artifact paths are production-probed, and declared Pyodide startup-module package artifacts are supported by the runtime catalog. `pip` is not a complete upstream build system. | Nimbus pip must resolve/install only Nimbus-compatible artifacts, preloaded PyEmscripten modules, pure wheels, or curated pure source artifacts. Unsupported extension artifacts fail before import with an ABI diagnostic. |
| Shell parser debt | The shell has structured parser/interpreter support for common POSIX-like constructs, but final field splitting, alias/quote handling, heredoc behavior, trap/job-control semantics, and script parity still need hardening. | Shell syntax should be represented in an AST and executed through structured semantics, not regex rewrites in the hot path. |
| Native platform packages | Native `linux-x64`, `darwin`, `win32`, manylinux wheels, and native gems cannot execute. | Package managers must select Nimbus ABI artifacts, pure packages, or fail early with exact unsupported ABI reasons. |

## Completion Draft

This is the implementation spec for completing Nimbus OS compatibility. It is
deliberately a consolidation plan: it names existing source modules that must be
hardened into single sources of truth, and it forbids adding parallel systems
that merely restate the same process, file, network, package, or SDK concepts.
The sections after this draft describe the same contracts in more detail; if a
future edit finds drift, merge the duplicate wording instead of adding another
plan section.

Completion means Nimbus behaves like a small POSIX-like cloud OS for supported
ABI surfaces:

- JavaScript and TypeScript npm CLIs run with correct process, TTY,
  stdin/stdout/stderr, signals, resize, child-process, and filesystem behavior
  when they only require Nimbus-supported APIs.
- Node, Python, Ruby, and WASI workloads share coherent VFS state in
  long-running processes.
- Node, Python, Ruby, and WASI web servers share one virtual socket and preview
  substrate.
- Shell scripts and installers run through structured parser/executor semantics,
  not a stack of quote-sensitive rewrites.
- Package managers install by ABI: pure packages, Nimbus-native Wasm,
  Pyodide/PyEmscripten startup modules, ruby.wasm-compatible artifacts, or
  precise unsupported-native diagnostics.
- The hosted demo, programmatic SDK, remote API, React iframe, CLI, and Agent
  use one public product surface with colocated/remote parity.

### Reuse Map

The following modules already exist and should be evolved. New work should route
through these boundaries instead of creating new owners with overlapping state.

| Completion area | Reuse as source of truth | Current role | Completion work |
|---|---|---|---|
| Process and PTY | `ProcessTable`, `ProcessLogStore`, `ProcessInputStore`, `process-logs-api.ts`, `FacetProcessManager`, `node-shims.ts` child process RPC, and `NimbusSession` ownership | Tracks PID lifecycle, logs, input packets, process terminals, child-process broker, attached npm-bin processes | Add a single session process/PTY supervisor facade over these modules, then add process groups, controlling TTY, raw/cooked mode, durable process metadata, and attach/detach replay |
| Filesystem | `SqliteVFS`, `RuntimeFsBridge`, `SqliteRuntimeFsBridge`, VFS events, `fs-watch.ts` | Durable SQLite-backed VFS, runtime bridge, browser file-watch events | Add range/page operations, per-path revisions, hibernation-safe runtime handles, live runtime cache invalidation, and long-running runtime integration |
| Networking and preview | `PortRegistry`, existing `VIRTUAL_SOCKET_KERNEL_SRC`, Python/Ruby socket shims, session `/port` and `/preview` routes | Request/Response preview gateway plus in-facet loopback sockets for Python/Ruby | Harden the existing virtual socket kernel into the shared loopback substrate, move Node and WASI onto it, add streaming/backpressure and hibernation-aware port metadata |
| Shell | Nimbus-owned LIFO parser, lexer, interpreter, expander, `Shell`, shell entrypoints, and Unix command registry | POSIX-like shell substrate with useful parser/interpreter behavior and command shims | Complete structured expansion, redirection, job control, `source`, `set`, `trap`, `wait`, shebang, and process-kernel integration; remove hot-path normalizers when replaced by AST semantics |
| Runtime packages and ABI | `runtime-catalog.ts`, `package-manager.ts`, `os-contracts.ts`, `python-pip.ts`, `ruby-gems.ts`, npm installer/fanout, `wasm-swap-registry.ts` | Runtime install, ABI descriptors, pure package paths, native diagnostics, npm package policy | Move ABI policy to catalog/typed metadata, keep resolver/facet policy generated from one source, classify extracted artifacts, and remove stale hardcoded runtime/bin lists |
| SDK and product | `packages/sdk/src/sandbox.ts`, `router/remote-api.ts`, auth middleware, hosted demo, React package, CLI/config packages, Agent routes | Colocated/remote SDK, Worker embedder, hosted demo, React iframe, CLI, Agent tools | Fix iframe auth/readiness, CLI auth, remote preview auth, schema parity, quota hooks, and one public capability model |

### Process And PTY Completion

Do not add a second process table. The missing abstraction is a facade and
policy layer over the existing process modules.

Required model:

- Process descriptor: `pid`, `pgrp`, command, argv, cwd, runtime kind, owning
  facet, state, exit code/signal, `longRunning`, `attachedTty`, and controlling
  terminal id.
- PTY descriptor: terminal size, raw/cooked mode, echo/signal mode, foreground
  process group, attach state, replay cursor, and bounded screen/log metadata.
- I/O event model: stdin bytes, stdout/stderr bytes, resize, signal, exit,
  attach, detach, and replay.
- Integration points: browser process tabs, SDK process APIs, shell jobs,
  foreground npm-bin CLIs, child-process `stdio: "inherit"`, and Agent tools all
  go through the same supervisor contract.

Implementation rules:

- Keep `ProcessTable`, `ProcessLogStore`, and `ProcessInputStore` as the
  storage primitives initially; expose them through one session process
  supervisor facade before adding semantics.
- Convert Ctrl-C/Ctrl-Z to signals only when the controlling PTY is in signal
  mode. Raw-mode processes receive literal bytes.
- `stdio: "inherit"` attaches a child to the parent controlling PTY when one
  exists; it must not silently degrade to detached/null streams.
- Process logs remain durable and bounded; process descriptors and PTY metadata
  also need compact durable rows so hibernation can present honest state.
- If a process/facet cannot be rehydrated after wake, mark it exited/dead with a
  precise reason. Do not leave a routeable-looking zombie process.

Scalability requirements:

- Bound running PIDs, attached TTYs, process-log subscribers, input queue bytes,
  output ring bytes, replay bytes, and child-process output queues.
- Coalesce resize storms to the final dimensions plus one observable resize
  event.
- Persist logs and process metadata in batches; never write SQL per byte or per
  keystroke.
- Keep process terminal WebSockets hibernatable with `ctx.acceptWebSocket`.

### Live VFS Completion

`RuntimeFsBridge` is already the adapter boundary. Completion means revising and
extending it into the live runtime contract for long-running workloads rather
than leaving it as a supervisor convenience plus runtime snapshots.

Required additions:

- Stateless range operations: read range, write range, truncate, metadata patch,
  and batched patch application.
- Per-path or per-inode revisions so runtime caches do not invalidate on every
  unrelated write.
- Runtime-owned FD tables. The Durable Object should receive stateless path or
  inode operations so hibernation does not lose server-side handle ids.
- Shared runtime-side page cache/mirror helper with 64 KiB pages, dirty page
  tracking, revision-aware invalidation, batched flush, and binary-safe transfer.
- Conflict behavior for stale writes. Conflicts must be deterministic and noisy;
  they must not silently overwrite newer supervisor state.

Runtime rules:

- Node async filesystem APIs should be live, including `FileHandle` positional
  reads/writes, truncate, recursive operations, symlink paths, binary files, and
  watch/invalidation paths.
- Node sync filesystem APIs may keep a startup snapshot plus local write cache,
  but that must be documented as a synchronous optimization. The runtime mirror
  should invalidate or refresh at event-loop/request boundaries where possible.
- WASI should use live bridge hostcalls where JSPI or `WebAssembly.Suspending`
  allows async imports.
- Ruby should converge through the live WASI path because ruby.wasm is
  WASI-backed.
- Python/Pyodide should use a live mirror strategy: pull deltas before command
  or request handling, flush dirty changes after command/request handling, and
  debounce flushes for long-running socket processes.

Scalability requirements:

- No whole-tree snapshots for long-running processes.
- No per-byte Durable Object RPC.
- Use 64 KiB page reads/writes unless probes show a better size.
- Stream large writes and batch small writes plus metadata changes.
- Keep dirty caches bounded with high-water flushing.
- Emit diagnostics for cache hits, dirty bytes, flush latency, invalidation lag,
  snapshot bytes, bridge RPC count, and dropped invalidations.

### Virtual Sockets And Preview Completion

`PortRegistry` is the supervisor Request/Response gateway. The existing
`VIRTUAL_SOCKET_KERNEL_SRC` is the in-facet loopback socket service. Completion
means hardening those two layers and moving every runtime adapter onto them.

Required model:

- Supervisor owns public port metadata, PID ownership, duplicate-bind policy,
  port `0` allocation, preview default selection, hibernation metadata, stats,
  and `/port`/`/preview` routing.
- Facet virtual socket kernel owns `listen`, `accept`, loopback `connect`,
  `read`, `write`, `shutdown`, `poll`, and `close`.
- Preview requests should enter the facet as accepted HTTP/1.1 byte streams.
  Runtime response bytes should become streaming Worker `Response` bodies.
- Node `net`/`http`, Python `socket`/`select`/`socketserver`, Ruby
  `TCPServer`/`TCPSocket`/`IO.select`, and WASI Nimbus socket imports bind to
  the same kernel.

Implementation rules:

- Replace full-buffer request/response handling with streaming request bodies
  and streaming responses.
- Enforce listener and connection limits: max ports, backlog, active
  connections, queued bytes, response-header timeout, idle timeout, and request
  body limits.
- Propagate aborts. Client abort, process exit, kill, or port unregister closes
  queued connections and produces clear errors.
- Node's current HTTP bridge is transitional. Final Node `net` and HTTP should
  use the same virtual socket path as Python, Ruby, and WASI.
- Static serving is explicit only. Do not hide static-server substitutions behind
  language server paths.

### Shell Completion

Nimbus already owns the LIFO shell source. Complete that substrate instead of
stacking more command-specific patches.

Required behavior:

- Quote-aware expansion results, not string rebuilding.
- POSIX expansion ordering for parameter expansion, command substitution,
  field splitting, globbing, and quote removal where Nimbus claims support.
- Correct `$@`, `$*`, IFS splitting, `$?`, `$$`, `$0`, positional parameters,
  env assignments, command substitution trimming, and shebang dispatch.
- Redirection opens/truncates once and streams writes to the opened target.
- `source`, `.`, `set`, `trap`, `wait`, `read`, background jobs, and foreground
  process groups reach POSIX-compatible behavior and process-supervisor
  integration instead of relying on registry no-op fallbacks.
- Alias expansion happens before ordinary word expansion and preserves token
  boundaries.

Implementation rules:

- Fix redirection stream semantics first.
- Add field/quote-aware expansion types.
- Replace hot-path line normalizers only after equivalent AST behavior is
  implemented and probed.
- Keep pipeline streaming and cancellation; do not buffer unbounded command
  output.
- Shell job control and process status report through the process supervisor.

### ABI-Aware Package Completion

Package managers must install by ABI rather than hope.

Required artifact classes:

- JavaScript/workerd-compatible package.
- Pure Python wheel.
- Curated pure Python source artifact.
- Pyodide/PyEmscripten startup-loaded package artifact.
- Pure Ruby gem.
- ruby.wasm-compatible artifact.
- `wasm32-wasi-nimbus` binary.
- Unsupported native shard with exact diagnostic.

Implementation rules:

- Keep `wasm-swap-registry.ts` as the supervisor-side policy owner. The loader
  preamble currently needs serialized policy because loader isolates cannot
  import ordinary modules; prevent drift by generating or validating the
  preamble policy from the same typed data.
- Extend npm cache metadata for ABI decisions: optional dependencies, peer
  dependencies, `os`, `cpu`, `libc`, package manager metadata, bin metadata, and
  native shard evidence.
- Classify extracted artifacts by content and shebang, not only extension.
  Detect ELF, Mach-O, PE, `.node`, JS, shell, and Wasm bin targets.
- Preserve optional dependency soft-skip semantics. Required native artifacts
  fail early with exact reasons.
- Runtime manifests should declare ABI descriptors, aliases, commands, package
  managers, startup modules, and package artifact metadata. Hardcoded runtime
  aliases and CLI runtime lists must become catalog-driven or mechanically
  validated against the catalog.
- Session Durable Objects install built Nimbus-compatible artifacts. They do not
  compile large native C/C++ extension projects in constrained session CPU.

Scalability requirements:

- Keep the current fanout resolver and batch install architecture.
- Do not buffer tarballs in the supervisor heap.
- Version cache schemas. Treat stale rows as metadata misses or explicit
  migrations, not broad compatibility fallbacks.
- Use a runtime install completion marker or blob verification so a partially
  written runtime manifest cannot make a corrupt runtime look installed.

### SDK And Product Completion

The SDK exists and should stay the public product surface. Completion means
making the interactive app, hosted demo, remote API, React iframe, CLI, and
Agent converge on that surface.

Required behavior:

- `Nimbus.fromEnv` and `Nimbus.connect` expose equivalent operations where a
  remote deployment has the necessary permissions.
- Remote operation schemas are centralized or mechanically checked so SDK and
  server cannot drift.
- Enforced-auth embeds keep authorization across HTML, WebSocket, and API
  requests through the attach exchange: a `?nimbus_token=` on the session shell
  URL (embedder iframe token or `/new` bootstrap token) is exchanged for a
  freshly minted sid-pinned `session:attach` cookie (`HttpOnly`,
  `SameSite=None`, `Secure` + `Partitioned`) and the browser is redirected to
  the clean `/s/<id>/` URL. `POST /new` with a verified Bearer token redirects
  to an attach URL carrying a short-lived (90 s), single-use,
  `session:bootstrap`-scoped token whose `jti` is consumed set-if-absent in the
  session DO's storage; replays return 401. Long-lived tokens travel only in
  `Authorization` headers, never in URLs. Implemented in
  `packages/worker/src/router/index.ts` and `packages/worker/src/auth/`;
  covered by `tests/behavioral/auth/new/router-session-scope-and-pin.mjs`.
  Known limit: the exchange stores one sid-pinned `nimbus_token` cookie per
  browser partition, so two concurrently embedded sessions on one page evict
  each other's cookie; concurrent multi-session embeds in enforce mode need a
  per-session cookie design (follow-up).
- The public shell emits `nimbus:ready` and `nimbus:error` messages that the
  React package actually receives. The shell emits both, and
  `tests/behavioral/embed/new/react-embed-ready-event.mjs` asserts
  embedder-side reception of `nimbus:ready` in a real browser; it must stay
  green in live runs.
- Browser session-id parsing accepts the same IDs the server accepts.
- CLI session commands support `NIMBUS_TOKEN` and `--token` for enforced
  deployments: the token travels only as `Authorization: Bearer` to
  `POST /new`, and the CLI prints the server-returned bootstrap attach URL
  verbatim. The no-token path is unchanged for unauthenticated/self-host
  deployments.
- `ports.expose()` has an explicit auth model: authenticated URL, signed
  short-lived URL, or SDK fetch helper. The current SDK returns a plain
  `/s/<id>/port/<port>/` path, which is only directly usable when the caller
  already has browser/session auth.
- Hosted-demo internal Nimbus JWTs stay server-side; browser users get demo
  auth cookies and Agent OAuth cookies, not internal sandbox tokens.

Security and scale requirements:

- URL query tokens are stripped after validation and never forwarded to session
  internals or logged in normal paths.
- Cross-origin iframe cookies must have an explicit posture (`SameSite=None`,
  `Secure`, and `Partitioned` where supported) or use an Authorization-bearing
  iframe bootstrap handshake instead of assuming third-party cookies.
- Hosted-demo auth cookies and Agent OAuth cookies remain `HttpOnly`; iframe
  bootstrap/session tokens must not be confused with user OAuth token storage.
- Token scopes, tenant/session pins, destroy permissions, runtime policy, and
  preview access are enforced by server code, not only by SDK client code.
- Public deployments need hooks for tenant/session rate limits, process caps,
  port caps, runtime install quotas, and API request quotas.

### Consolidation And Deletion Plan

These are cleanup targets discovered during source review. They should be
retired only after the replacement path is routed and probed.

| Path or pattern | Why it is stale or parallel | Correct consolidation |
|---|---|---|
| LIFO shell `ProcessRegistry` and legacy `JobTable` as global process truth | They overlap with session `ProcessTable` but lack the browser/SDK/process-log ownership model | Keep shell-local state temporarily, then route global job/process state through the session process supervisor |
| `LONG_RUNNING_CMD_RE` fallback in process logs | `ProcessEntry.longRunning` is the structured source when available | Keep as legacy fallback only until all launch paths set structured process flags |
| Registry-level no-op shell fallbacks for real builtins | Some commands remain as compatibility stubs after real shell builtins exist | Move real behavior into shell builtins/interpreter and keep registry entries only for command discovery when needed |
| `runtime/vfs-snapshot.ts` as long-running runtime IO | Snapshot/diff is bounded and stale for long-running processes | Keep only as short one-shot optimization; route long-running Node/Python/Ruby/WASI through live bridge or live mirrors |
| Node local HTTP `globalThis.__portRegistry` bridge | It is a separate request bridge from Python/Ruby virtual sockets | Move Node `net`/HTTP to the shared virtual socket kernel |
| `substrate/lifo/node-compat/child_process.ts` throwing stubs | It conflicts with the real `node-shims.ts` child-process path if treated as product surface | Keep only if shell-internal and clearly isolated; otherwise remove or redirect to the real broker |
| `substrate/lifo/kernel/network/*` | It is a separate virtual network concept from `PortRegistry` and `VirtualSocketKernel` | Quarantine as internal/experimental or retire after shared virtual socket kernel covers runtime networking |
| `runtime/static-server.ts` | Appears to be an unused legacy helper; hidden static fallbacks would fake language server support if wired later | Delete if unneeded, or keep only for explicit static-serving commands, not as fallback for Flask/Rack/Node/WASI servers |
| Duplicated npm native policy in loader preamble | Loader isolates need serialized policy, and current tests only partially validate parity | Generate or validate full preamble policy from supervisor typed policy |
| Hardcoded runtime aliases/defaults in CLI and package-manager | They can drift from runtime catalog manifests | Move to catalog-provided aliases/commands or add parity checks |
| Stale comments describing real implementations as stubs, old runtime sizes, old WebSocket hibernation posture, or old concurrency | They mislead future implementation and docs | Clean comments when touching affected modules; do not change behavior only for comment cleanup unless in-scope |

### Completion Order

The order matters because each step removes a future source of duplication.

1. Add the session process/PTY supervisor facade over existing process modules.
2. Add live VFS range/revision operations under the existing runtime bridge.
3. Harden the existing virtual socket kernel for streaming and backpressure.
4. Fix SDK/embed auth, shell ready/error events, CLI token support, and preview
   auth because those are product-facing and independent of runtime internals.
5. Move Node async FS and Node HTTP/net onto the shared contracts.
6. Move WASI, Ruby, and Python long-running runtime IO onto live bridge or live
   mirror semantics.
7. Complete shell AST expansion/redirection/job semantics and retire replaced
   normalizers/stubs.
8. Centralize ABI policy and make runtime/package defaults catalog-driven.
9. Add probes for each completed capability and then update README/UI/support
   claims.

## Compatibility Model

Nimbus compatibility should be expressed as ABI surfaces, not as vague
"Linux support".

### Filesystem And Paths

Nimbus should present a stable POSIX-like filesystem:

- `/home/user` as the default home and working tree.
- `/tmp` for temporary files.
- `/bin`, `/usr/bin`, and `/usr/local/bin` as virtual command paths.
- `PATH`, `HOME`, `PWD`, `TMPDIR`, `SHELL`, and language-specific env vars.
- Regular files, directories, symlinks, hard links where supported, stat
  metadata, and coherent file-watch events.

The backing source of truth remains `SqliteVFS`. Runtime caches are allowed
only when they are coherent with VFS revisions and invalidated by VFS events.

### Nimbus-Native Binaries

A Nimbus-native binary is any command that runs inside Nimbus without a Linux
kernel:

- JavaScript or TypeScript command handlers.
- WASI modules compiled for `wasm32-wasi-nimbus`.
- Pyodide/PyEmscripten Python wheels and launchers.
- ruby.wasm/Ruby WASI command launchers.
- Shell command shims that map POSIX-style commands to Nimbus primitives.

Package managers may see Linux-like command paths, platform strings, and
selection metadata where that improves compatibility, but execution must never
depend on pretending arbitrary Linux ELF objects are runnable. If a package
needs compiled code, the artifact must target a Nimbus-supported ABI such as
Pyodide/PyEmscripten startup modules, ruby.wasm/Ruby WASI, or
`wasm32-wasi-nimbus`.

`packages/worker/src/runtime/os-contracts.ts` is the source of truth for the
current Nimbus ABI descriptor. The public target string is
`wasm32-wasi-nimbus`; WASI programs launched by Nimbus receive
`NIMBUS_OS=nimbus`, `NIMBUS_ABI=wasm32-wasi-nimbus`, and
`NIMBUS_ABI_TARGET=wasm32-wasi-nimbus` in their environment. Shell tooling,
SDK runtime summaries, package metadata, and diagnostics should consume that
same descriptor instead of duplicating target literals.

The runtime catalog must describe what each package provides:

```json
{
  "name": "python",
  "version": "3.13.2-pyodide-0.29.4",
  "abi": "pyodide",
  "provides": {
    "commands": ["python", "python3", "pip", "pip3"],
    "libraries": ["python-stdlib"],
    "packageManagers": ["pip"]
  }
}
```

Command aliases should be first-class catalog data. `nimbus install python3`,
`nimbus install pip`, and `nimbus install python` should all resolve to the
same runtime when the catalog says those commands are provided.

### Nimbus Syscalls

The POSIX layer should be implemented as host APIs that each runtime can bind
to:

| API group | Required behavior |
|---|---|
| Files | open, close, read, write, pread, pwrite, seek, tell, sync, truncate |
| Directories | mkdir, rmdir, readdir, rename, unlink |
| Metadata | stat, lstat, chmod-like mode storage, times, access checks |
| Links | symlink, readlink, hardlink where possible |
| Time/random | monotonic clock, realtime clock, random bytes |
| Processes | argv, env, cwd, exit code, signals, process table registration |
| Terminal | PTY mode, raw/cooked input, window resize, ANSI passthrough |
| Polling | file readiness, socket readiness, timers |
| Network | outbound TCP where platform APIs allow it, HTTP preview ports |

The syscall layer should be explicit and shared. Python, Ruby, WASI, Node, and
future languages should not each invent incompatible path, fd, or watch
semantics.

## Live VFS Design

The final OS model should be live, not snapshot-only.

Snapshot/diff is still useful as an optimization for one-shot commands that
touch small working sets. It should not be the only contract for long-running
processes, REPLs, package managers, web servers, or agent CLIs.

### Source Of Truth

`SqliteVFS` remains the owner of durable contents and metadata. It already has:

- resident inode metadata
- chunked file storage
- LRU content cache
- deferred write batching
- forced flush boundaries
- revision tracking
- VFS mutation events

The live bridge should build on those primitives.

### Runtime FS Bridge

The shared runtime bridge is defined in
`packages/worker/src/runtime/os-contracts.ts` and implemented for SQLite VFS
in `packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts`. Its core shape
is:

```ts
interface RuntimeFsBridge {
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeVfsStat | null>;
  readFile(path: string, options?: { followSymlinks?: boolean }): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: string | Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  }): Promise<void>;
  utimes(path: string, atimeMs: number, mtimeMs: number, options?: { followSymlinks?: boolean }): Promise<void>;
  open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
  read(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
  write(handleId: number, offset: number | null, bytes: Uint8Array): Promise<number>;
  close(handleId: number): Promise<void>;
  readdir(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeVfsDirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readlink(path: string): Promise<string | null>;
  symlink(target: string, path: string): Promise<void>;
  fsync(handle?: number): Promise<void>;
  revision(path?: string): Promise<number>;
  subscribe?(path: string, listener: (event: VfsEvent) => void): () => void;
}
```

This bridge is the current adapter boundary. Implementations may optimize with
page caches, batching, or snapshots, but they must preserve coherence. Current
production wiring uses it for supervisor file RPCs and Node async filesystem
fallback. Python, Ruby, and WASI still need direct long-lived bridge
integration, and the bridge should grow stateless range/revision primitives so
runtime-owned FD tables do not depend on Durable Object-side handle ids across
hibernation.

### Coherence Rules

- Every runtime read observes either the latest committed VFS revision or a
  runtime-local write that has not yet been flushed.
- Runtime writes carry a base revision. Conflicting writes must not silently
  overwrite newer supervisor state.
- Long-running processes receive VFS invalidations through the existing event
  bus or a derived per-process channel.
- File-watch events coalesce for UI performance, but runtime invalidation must
  preserve ordering per path.
- `fsync` and process exit are durability boundaries.
- Hibernation may close runtime caches, but it must not lose committed writes.

### Performance Rules

The live bridge must be fast enough for Durable Object constraints:

- Do not perform a Durable Object RPC for every byte.
- Use 64 KiB or larger pages for file reads and writes unless a workload
  demonstrates a better size.
- Cache pages by path, offset, and VFS revision.
- Batch small writes and directory metadata updates.
- Use snapshot/diff only when the command is known to be bounded and short.
- Avoid JSON envelopes for binary data; transfer bytes as `Uint8Array`,
  `ArrayBuffer`, `Request`, `Response`, or streams.
- Keep hot metadata in memory and bounded.
- Emit diagnostics for bridge cache hit rate, dirty bytes, flush latency,
  snapshot bytes, and invalidation lag.

## Nimbus OS Kernel Plan

The missing capabilities should be completed as shared OS services by evolving
the existing Nimbus modules named above. Do not create second process tables,
filesystem bridges, socket routers, package policy registries, or public SDK
surfaces unless the old owner is retired in the same workstream.

### Process And PTY Kernel

Nimbus already has process metadata, input queues, log rings, process-terminal
WebSockets, and a child-process broker. These should be exposed through a
first-class process IO contract:

```ts
interface NimbusProcessIo {
  pid: number;
  kind: 'one-shot' | 'daemon' | 'interactive';
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  resize(cols: number, rows: number): void;
  signal(name: string): void;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
}
```

Rules:

- A package bin launched from the terminal with no pipe should be eligible for
  `interactive` mode.
- An interactive process gets a process tab backed by the PTY, not a log-only
  tab.
- The tab owns stdin, raw/cooked mode, terminal size, ANSI output, Ctrl-C,
  Ctrl-D, attach/detach, and scrollback replay.
- Current hibernation persists process logs and exit records only. Full process
  descriptors and PTY metadata still need compact durable rows before wake can
  present honest process state, including process id, command, terminal size,
  active mode, and replay cursor.
- Process logs are still recorded, but logs are secondary to the live PTY for
  foreground TUIs.
- The SDK must expose this as an explicit terminal/process attachment surface,
  not hide it behind `exec`.
- The current regex fallback for long-running command detection is legacy only.
  Structured process metadata should own process classification once all launch
  paths set it.

### POSIX Shell Contract

Nimbus should provide `/bin/sh`, `sh`, and `bash` as Nimbus-native commands.
`bash` may initially identify as a POSIX-compatible Nimbus shell, but it should
not be a stub.

Required behavior:

- `sh -c <line>`
- `sh <script>` and scripts from stdin
- pipes, fd redirects, heredocs, grouping, command substitution, env
  assignments, `$?`, `$$`, `$0`, positional parameters, `set -e`, `set -u`,
  `trap`, `wait`, and background jobs
- `command -v`, `which`, `/usr/bin/env`, and shebang dispatch
- consistent stdout/stderr routing to pipes, files, terminal, and PTY tabs

Implementation rule: shell syntax should be parsed into an AST and executed by
shared command/process primitives. Do not add more quote-sensitive regex
normalizers for ordinary shell grammar.

### Virtual Socket Kernel

Nimbus virtual sockets should be completed by hardening the existing
`VIRTUAL_SOCKET_KERNEL_SRC` and `PortRegistry` pair into a shared kernel
service:

```ts
interface NimbusSocketKernel {
  socket(domain: 'inet' | 'unix', type: 'stream' | 'datagram'): SocketFd;
  bind(fd: SocketFd, address: SocketAddress): void;
  listen(fd: SocketFd, backlog: number): void;
  accept(fd: SocketFd): Promise<SocketFd>;
  connect(fd: SocketFd, address: SocketAddress): Promise<void>;
  read(fd: SocketFd, maxBytes: number): Promise<Uint8Array>;
  write(fd: SocketFd, bytes: Uint8Array): Promise<number>;
  close(fd: SocketFd): void;
  poll(fds: PollInterest[], timeoutMs: number): Promise<PollReady[]>;
}
```

Loopback `127.0.0.1:<port>` and `localhost:<port>` are Nimbus-internal
endpoints. Preview requests enter the kernel as accepted HTTP/1.1 byte streams
and the response bytes become the Worker `Response`. This is how Flask, Rack,
WEBrick, and C/WASI servers can feel like normal local web servers without
requiring Cloudflare inbound TCP sockets.

Runtime adapters should bind to the same kernel:

- Node `net.Server`, `net.Socket`, and HTTP should use the virtual socket
  kernel for loopback and preview routing.
- Python `socket`, `select`, `selectors`, `socketserver`, WSGI, and ASGI
  should use the same kernel.
- Ruby `socket.rb`, Rack, WEBrick, and compatible pure Ruby servers should use
  the same kernel.
- WASI/Nimbus native binaries should get socket hostcalls through
  `wasm32-wasi-nimbus`.

### Package ABI Registry

Package managers must install by ABI, not by hope.

Required registry dimensions:

- runtime name and version
- ABI name, such as `javascript`, `wasm32-wasi-nimbus`,
  `pyodide-emscripten-2025_0-wasm32`, `py3-none-any`,
  `python-source-pure`, `pyodide`, `ruby-wasm`, or `native-unsupported`
- provided commands
- pure package compatibility
- precompiled startup-loaded wasm modules
- native shards and explicit unsupported targets
- install diagnostics and replacement hints

No install path should silently delete or ignore native artifacts in the hot
path. If an artifact is optional and has a curated pure source artifact, the
installer should know that from package metadata or an ABI policy entry and
install it cleanly. If an extension module is supported, it must be prebuilt
and loaded through the Workers-supported startup module path.

## Language Runtime Plan

### Python

Target:

- `python`, `python3`, `pip`, and `pip3` commands.
- Pure Python wheels from PyPI where compatible.
- Packages with curated pure source artifacts, including packages whose
  optional extension artifacts can be avoided by installer policy.
- Binary wasm32/emscripten wheels only when they are shipped as Nimbus
  startup-loaded runtime modules declared by the installed runtime manifest.
  Request-time dynamic extension loading is blocked by the Workers Wasm CSP.
- `python -m pip install ...`, `pip install -r requirements.txt`, local wheel
  installs, constraints, extras, markers, and deterministic errors for
  unsupported packages.
- Persistent `site-packages` in VFS.
- Live file IO for scripts, imports, package installs, and long-running apps.
- WSGI/ASGI adapters for web apps, connected to the Nimbus port registry.

Non-goal:

- Installing manylinux, musllinux, macOS, or Windows wheels as-is.
- Running arbitrary Linux-native extension modules.

Correct engineering path:

1. Keep hardening the ABI-aware `pip` installer for wheel tags, requirements,
   constraints, dependency metadata, extras, markers, and local VFS paths.
2. Expand the runtime catalog's startup-loadable Pyodide package artifact list
   by ABI and package demand.
3. Add a builder path outside the Durable Object for packages that need
   Emscripten/Pyodide compilation. The DO installs built artifacts; it does not
   spend constrained session CPU compiling large C/C++ projects.
4. Add a Python runtime FS bridge instead of relying on per-command snapshots.
5. Bind Python `socket`, `select`, `selectors`, `socketserver`, WSGI, and ASGI
   to the shared virtual socket kernel.
6. Keep the existing Flask and `http.server` production probes green, and add
   ASGI plus broader WSGI/framework probes as runtime socket support expands.

### Ruby

Target:

- `ruby`, `ruby3`, `gem`, `bundle`, and `bundler` commands.
- ruby.wasm/Ruby WASI runtime.
- Pure Ruby gem installs.
- Bundler resolution for compatible gems.
- Persistent `GEM_HOME` and `GEM_PATH` in VFS.
- Live file IO for scripts, `require`, gems, and long-running apps.
- Rack adapter for previewable Ruby web apps.

Non-goal:

- Installing Linux-native Ruby gems as-is.
- Compiling arbitrary native Ruby extensions inside the session DO.

Correct engineering path:

1. Keep hardening RubyGems metadata fetch, gem download, extraction, activation,
   binstub registration, and lockfile support for pure Ruby gems.
2. Expand Bundler compatibility beyond simple compatible Gemfiles.
3. Keep pure Ruby gems separate from native-extension gems. Unsupported native
   gems must fail with a precise ABI diagnostic.
4. Add a Ruby runtime FS bridge instead of relying on per-command snapshots.
5. Bind Ruby `socket.rb`, Rack, WEBrick-compatible flows, and pure Ruby web
   servers to the shared virtual socket kernel.
6. Keep the existing `gem install rack`, Rack, WEBrick, and `ruby -run -e httpd`
   production probes green, and add broader pure-Ruby framework probes as socket
   support expands.

### C, C++, And WASI

Target:

- `clang` and `wasm-ld` compile to `wasm32-wasi-nimbus`.
- A Nimbus sysroot containing WASI libc and Nimbus-supported libraries.
- Executables run through the shared WASI shim.
- POSIX-ish filesystem and polling semantics.
- Outbound TCP through explicit supported APIs.

Non-goal:

- Linux process model, fork, ptrace, arbitrary device IO, or pthreads unless
  the platform exposes correct shared-memory support.

Correct engineering path:

1. Keep expanding WASI hostcalls by behavior, not by name count.
2. Move WASI file operations from snapshot-only to the live FS bridge where
   JSPI/Suspending and host constraints allow it.
3. Keep `wasi-threads` unsupported until shared linear memory across required
   runtime boundaries is actually available.
4. Publish a `wasm32-wasi-nimbus` ABI label for packages and compiled tools.

### Node And Agentic CLIs

Target:

- JavaScript and TypeScript CLIs run through Nimbus Node compatibility.
- `npm`, `npx`, package aliases, package bins, and common dev servers work.
- `child_process.spawn`, `exec`, `execFile`, process logs, stdin/stdout/stderr,
  and long-running process supervision work.
- PTY-backed terminal behavior for interactive CLIs.
- Agent CLIs such as opencode, pi.dev, and Proteus should either run
  unmodified or fail with a precise unsupported ABI/package diagnostic.

Non-goal:

- Loading `linux-x64`, `darwin`, or `win32` native package shards without a
  Nimbus-native replacement.

Correct engineering path:

1. Harden the attached npm-bin PTY contract: raw mode, terminal dimensions,
   resize events, `stdin.isTTY`, `stdout.isTTY`, ANSI passthrough, signal
   delivery, replay, and hibernation.
2. Move dynamic Worker `fs` shims toward the shared live FS bridge.
3. Keep the Pi npm probe green and add real smoke probes for opencode and the
   local Proteus CLI.
4. Build an adapter/replacement registry for common native packages that have
   usable WASM or pure-JS alternatives.
5. Keep package-bin launch terminal-context aware: foreground terminal
   commands attach to the PTY process tab, while piped/background commands
   remain non-TTY.
6. Make `process.stdout.write` and `stderr.write` obey Node callback and
   backpressure expectations closely enough for CLI render loops.

## Web Server And Preview Plan

The port registry is already the right primitive for HTTP preview:

- A process owns a port.
- `/port/<n>/...` forwards a real `Request`.
- The runtime returns a real `Response`.
- PortRegistry avoids JSON body serialization. Current Node and virtual-socket
  adapters still buffer internally in places; completion means streaming through
  the adapter layer too.

Language web servers should plug into this model:

- Node: `http.createServer().listen(port)` currently maps to the port registry
  through a Node-specific bridge; final Node `net` and HTTP should use the
  shared virtual socket kernel for loopback and preview routing.
- Python: `socketserver`, WSGI, and ASGI bind loopback virtual sockets and map
  app calls to `Request`/`Response`.
- Ruby: `socket.rb`, Rack, and WEBrick-compatible flows bind loopback virtual
  sockets and map Rack responses to `Response`.
- WASI/Nimbus-native binaries: socket hostcalls bind loopback virtual sockets.
- Static serving: provide an explicit `nimbus serve` or language-specific
  adapter command, not a hidden fake server path.

When a new port appears, the browser preview pane should create or focus the
corresponding tab. The tab model should de-dupe by kind and port.

## Runtime Catalog Plan

The catalog should become the package manager's source of truth:

```ts
interface RuntimeCatalogEntry {
  name: string;
  version: string;
  abi: string;
  aliases?: string[];
  provides: {
    commands: string[];
    libraries?: string[];
    packageManagers?: string[];
    sysroot?: string;
  };
  files: RuntimeFile[];
  diagnostics?: {
    unsupportedNativeAbi?: string;
    installHint?: string;
  };
}
```

The package manager should support:

- install by runtime name
- install by command name
- aliases such as `python3`, `pip`, `ruby3`, `gem`, and `wasm-ld`
- command-not-found hints
- preinstall policies from the SDK config
- on-demand install policies from the SDK config
- runtime warm-up hooks for expensive runtimes
- ABI-aware package caches

## Tests And Evidence

Existing probes cover:

- SDK and remote SDK routing:
  `tests/behavioral/sdk/new/*`
- shell compatibility and installer primitives:
  `tests/behavioral/shell/*`, `tests/behavioral/shell/compat/**/*`, and
  `tests/behavioral/shell-polish/**/*`
- Agent panel and OAuth cookie handling:
  `tests/behavioral/agent/new/session-agent-panel.mjs` and
  `tests/behavioral/agent/new/session-agent-cookie-oauth.mjs`
- agentic CLI Node primitives:
  `tests/behavioral/agentic-cli/new/node-child-process-primitives.mjs`,
  `tests/behavioral/agentic-cli/new/node-live-vfs-async-fs.mjs`,
  `tests/behavioral/agentic-cli/new/node-live-vfs-symlink.mjs`,
  `tests/behavioral/agentic-cli/new/node-sync-cwd-project-snapshot.mjs`, and
  `tests/behavioral/agentic-cli/new/node-fs-utimes.mjs`
- attached npm-bin process terminals, Pi's npm path, and opencode's current
  unsupported native boundary:
  `tests/behavioral/agentic-cli/new/attached-npm-bin-tty.mjs`,
  `tests/behavioral/agentic-cli/new/attached-process-tab-browser.mjs`,
  `tests/behavioral/agentic-cli/new/npm-bin-explicit-process-exit.mjs`,
  `tests/behavioral/agentic-cli/new/bun-shebang-npm-bin.mjs`,
  `tests/behavioral/agentic-cli/new/pi-official-installer.mjs`,
  `tests/behavioral/agentic-cli/new/pi-coding-agent-npm-bin.mjs`,
  `tests/behavioral/agentic-cli/new/opencode-installer-native-boundary.mjs`,
  and `tests/behavioral/agentic-cli/new/opencode-native-bin-diagnostic.mjs`
- runtime package manager:
  `tests/behavioral/pkg-manager/*`
- npm/npx primitives:
  `tests/behavioral/runtime-primitives/*` and
  `tests/behavioral/runtime-pkg/*`
- WASI:
  `tests/behavioral/wasi/*`, `tests/behavioral/wasi-files/*`, and
  `tests/behavioral/wasi-paths/*`
- Python basics, pure-package support, requirements/local-wheel installs,
  PyPI resolver/constraint coverage, MarkupSafe pure-source fallback,
  startup-module package artifacts, Flask and `http.server` previews, and
  unsupported native diagnostics:
  `tests/behavioral/python/*`
- Ruby basics, pure-gem command support, Bundler pure-Gemfile support,
  Rack/WEBrick/httpd previews, and unsupported native gem diagnostics:
  `tests/behavioral/ruby/*`
- Python and Ruby REPLs:
  `tests/behavioral/repl/python-hello-repl.mjs` and
  `tests/behavioral/repl/ruby-hello-repl.mjs`
- preview ports:
  `tests/behavioral/preview/*`
- file-watch behavior:
  `tests/behavioral/file-tree-watch/*`
- static parity checks for native executable loader policy:
  `tests/behavioral/static-checks/native-executable-preamble-parity.mjs`

This document did not rerun the full probe suite. It records source-backed
current state and the test surfaces that should be used to prove future work.

## Required New Probes

Add black-box probes for:

- POSIX shell:
  - remaining shell grammar not covered by current `sh`/`bash` probes:
    IFS field splitting, `$*`, alias quoting, redirection multi-write
    semantics, shell-script shebang dispatch, and edge cases beyond the covered
    grouping, command-substitution, `set -e`, `trap`, `source`, `wait`, `$@`,
    and heredoc probes
- Live FS coherence:
  - long-running Node process observes editor writes without restart
  - long-running Python process observes file changes without snapshot stale
  - long-running Ruby process observes file changes without snapshot stale
  - long-running WASI process observes file changes without snapshot stale
  - cross-runtime writes and reads are visible without process restart
  - conflicting writes produce deterministic conflict behavior
- Python package manager:
  - resolver cases not covered by the current pure-wheel, requirements,
    constraints, local-wheel, transitive dependency, and MarkupSafe fallback
    probes, especially broader extras and marker combinations
  - each newly declared Pyodide startup-module package imports without
    request-time Wasm instantiation failures
  - simple ASGI app previews on a port
- Ruby package manager:
  - Bundler lockfile, group, source, and platform behavior beyond the current
    pure-Gemfile coverage
  - broader pure-Ruby framework previews as support is added beyond the current
    Rack/WEBrick/httpd probes
  - each newly supported unsupported-native-gem class fails with an exact ABI
    diagnostic
- POSIX/WASI:
  - `fd_sync` and process-exit flush
  - truncate and append behavior
  - symlink metadata behavior
  - large-file paged reads
  - mixed file/socket/timer polling under production load beyond the existing
    single-session mixed-poll probe
  - full hard-link inode, metadata, and mutation semantics if Nimbus chooses to
    support more than minimal `path_link`
  - inbound virtual socket bind/listen/accept through `wasm32-wasi-nimbus`
- PTY and agentic CLIs:
  - Ctrl-C raw/cooked behavior
  - signal delivery
  - resize coalescing under rapid resize streams
  - `stdio: "inherit"`
  - attach/detach replay
  - hibernation wake with durable process metadata
  - log-only tabs still work for daemon processes
  - unmodified opencode smoke beyond the current native-boundary probes
  - Proteus CLI smoke or exact unsupported boundary
- SDK and product:
  - enforced-auth attach exchange against a live enforced deployment: the
    bootstrap attach URL sets the session cookie, replays return 401, and
    HTML, WebSocket, and API requests stay authorized via the cookie alone
    (in-process router coverage exists in
    `tests/behavioral/auth/new/router-session-scope-and-pin.mjs`; the hosted
    demo fronts sessions with its own login policy, so the live probe targets
    the enforced probe deployment in `apps/probe`)
  - React `onReady` fires from real shell events: covered by
    `tests/behavioral/embed/new/react-embed-ready-event.mjs`; a live
    `onError` reception probe is still required
  - CLI `nimbus session new` with `NIMBUS_TOKEN`/`--token` against a live
    enforced deployment (the header/URL contract is covered in
    `tests/unit/cli-session-new.mjs`)
  - remote preview URLs have documented authenticated or signed access behavior
- Package/runtime integrity:
  - partial runtime install with `manifest.json` but missing blobs is repaired
    or fails loudly
  - npm native policy parity is fully generated or validated between supervisor
    registry and loader preamble; current parity coverage only checks the native
    executable reject subset
  - CLI runtime lists match the runtime catalog instead of stale constants

Probes must assert user-visible behavior, not static strings or HTTP 200 alone.

## Success Criteria

Nimbus OS compatibility is ready to market when these are true:

- Docs and UI never claim Linux-native support that Nimbus does not provide.
- `nimbus install <command>` works for catalog-provided command aliases.
- Missing installable commands print a matching install hint.
- Python can install and import pure wheels and curated pure source artifacts
  from normal `pip` workflows.
- Python can install and import runtime-catalog-declared Pyodide startup-module
  packages without request-time wasm instantiation.
- `pip install flask` and Flask import/run paths work without dynamic wasm
  extension failures.
- Python web apps can be previewed through real virtual sockets and WSGI/ASGI
  adapters.
- Ruby can install and require pure Ruby gems.
- Ruby web apps can be previewed through real virtual sockets and Rack/WEBrick
  compatible adapters.
- `curl ... | sh` installers work when the script stays inside Nimbus-supported
  POSIX behavior.
- Foreground JavaScript npm-bin apps open an interactive process tab with
  stdin, raw mode state, resize, ANSI rendering, and Ctrl-C. Full POSIX PTY
  attach/detach replay and arbitrary full-screen TUI parity remain success
  criteria, not current claims.
- pi.dev, opencode, and the local Proteus CLI either run unmodified or fail at
  a specific unsupported native ABI/API boundary with a precise diagnostic.
- Long-running Node, Python, Ruby, and WASI processes see coherent filesystem
  state through the live bridge.
- Native Linux packages fail early with clear ABI diagnostics.
- Agentic CLIs either run or fail at a specific unsupported ABI/API boundary.
- Warm common commands feel interactive, with runtime warm-up and cache
  diagnostics visible enough to debug regressions.

## Immediate Workstreams

These are the concrete workstreams implied by the source audit. Treat this as
the canonical execution list; earlier ordered lists summarize the same sequence
at a higher level.

1. Add a session process/PTY supervisor facade over the existing process table,
   input store, log store, process-terminal WebSocket, and child-process broker.
   Foreground TUIs are interactive terminal tabs; daemon processes remain
   log-readable tabs.
2. Add live VFS range/revision operations under the existing runtime bridge and
   keep snapshots only as bounded one-shot optimizations.
3. Harden the existing virtual socket kernel and port registry with streaming,
   backpressure, abort handling, limits, and hibernation-aware metadata.
4. Fix SDK/embed auth, real shell `nimbus:ready`/`nimbus:error` events, CLI token
   support, and remote preview auth.
5. Keep package-bin launch based on structured shebang/bin metadata handling and
   terminal-context-aware TTY selection. Avoid regex parsing when package
   metadata or a JavaScript parser can identify the entrypoint.
6. Continue replacing remaining shell parser debt with structured POSIX shell
   AST execution in the Nimbus-owned shell substrate.
7. Move Node dynamic Worker `fs` shims to the live bridge while preserving fast
   bundled reads for known immutable module sources.
8. Move WASI, Ruby, and Python long-running runtime IO to live bridge or live
   mirror semantics.
9. Expand the Python `pip` ABI planner and runtime catalog with more declared
   Pyodide wheel/cache/module artifacts as demand and size budgets justify.
10. Complete Bundler-compatible dependency resolution for pure Ruby gems.
11. Promote the virtual socket kernel to the shared OS network service and bind
    Node, Python, Ruby, and WASI adapters to it.
12. Centralize ABI policy, validate loader-preamble parity, and make runtime
    aliases/defaults catalog-driven.
13. Verify and remove the apparently unused static-server helper, or keep it
    only for explicit static-serving commands once the virtual socket path
    covers language server previews.
14. Add production probes for unmodified opencode/local Proteus behavior or
    exact unsupported boundaries, live runtime VFS, deeper shell grammar, and
    SDK/embed auth.
15. Update README, SDK docs, and AGENTS from the support matrix proven by those
    probes.

## Design Guardrails

- No fake support. Compatibility shims must be labeled as shims.
- Do not remove or simplify internal/experimental Workers or Durable Objects
  architecture only because public documentation does not describe it.
- Treat live Nimbus code, deployed behavior, and existing probes as stronger
  evidence than public docs for Nimbus-specific internals.
- No regex-based parsing where a structured parser or package metadata format
  is available.
- No per-byte RPC loops.
- No unbounded VFS snapshots.
- No stale snapshot semantics for long-running processes.
- No server-side persistence of user OAuth secrets.
- No native package claims without an ABI-backed package path.
- No hidden runtime-specific filesystem semantics. Shared contracts first.

## Open Decisions

Recommended decisions:

- Keep snapshots only as a short-command optimization. The OS contract should
  be live VFS.
- Treat Python package compatibility as pure-wheel support plus explicit
  Nimbus startup-loaded Pyodide/PyEmscripten module support, not Linux pip
  support.
- Treat Ruby package compatibility as ruby.wasm/Ruby WASI support, not Linux
  Ruby support.
- Build virtual sockets as the primary OS networking substrate. WSGI/ASGI and
  Rack adapters may still exist as optimized framework bridges, but they should
  sit on the same routing contract instead of replacing sockets.
- Build compiled package artifacts outside session Durable Objects and install
  the resulting Nimbus-native artifacts into VFS.

The main unresolved product choice is naming: whether the user-facing command
for static file serving should be `nimbus serve`, language-specific aliases,
or both.
