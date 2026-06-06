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
  symlinks, hard links, file timestamps, `fd_allocate`, `proc_raise`,
  `poll_oneoff`, and outbound TCP through a synthetic `/dev/tcp/host/port`
  path.
- Node-like compatibility shims for many common modules: `fs`, `path`, `os`,
  `process`, `Buffer`, `events`, streams, `crypto`, `zlib`, DNS, HTTP,
  HTTPS, `net`, `child_process`, `readline`, `tty`, timers, and related
  utility modules.
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
- Real Request/Response preview routing through `PortRegistry`, including
  streaming request and response bodies.
- A VFS event bus with coalesced browser file-watch delivery.
- Behavioral probes for SDK, runtime package install, npm/npx, child process
  primitives, WASI, clang, Python basics, Ruby basics, file watching, and
  preview ports.

### Implemented But Not Final

These areas exist, but are not yet good enough for Nimbus OS quality:

- Python currently runs through Pyodide and has command execution, script
  execution, stdlib, VFS-backed imports/file IO, command aliases, REPL
  support, `pip`/`pip3`, `python -m pip`, requirements-file installs, local
  pure-wheel installs, persistent `site-packages`, and deterministic native
  Linux wheel ABI diagnostics. It does not provide build isolation, general
  compiled extension builds, constraints-file handling, or a complete `pip`
  CLI contract.
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
- Python `http.server` and Ruby `-run -e httpd` are currently intercepted into
  a Nimbus static server. That is useful for demos, but it is not real
  Python or Ruby web-server compatibility.
- Node synchronous `fs` calls still operate on the startup snapshot/write cache
  in dynamic Worker contexts. Async reads and common async mutations use the
  live supervisor bridge, but the final contract still needs a revision-aware
  file-handle/page-cache design for high-volume long-lived workloads.
- Agentic CLI support has probes for important Node process primitives, but
  unmodified agent CLIs still need stronger PTY, stdin, terminal, filesystem,
  and native-package compatibility.

### Not Implemented Yet

Nimbus is not yet a complete OS replacement:

- No Linux ELF loader.
- No Docker, VM images, `apt`, or native Linux package manager.
- No native Linux Python wheels.
- No general Python extension build pipeline inside Nimbus.
- No complete Bundler-compatible resolver.
- No native Ruby extension build pipeline inside Nimbus.
- No general pthread or `wasi-threads` support.
- No raw inbound TCP listener. HTTP preview ports are supported; raw local
  TCP servers need either a runtime adapter or a future socket bridge.

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

The runtime catalog must describe what each package provides:

```json
{
  "name": "python",
  "version": "3.13.2-pyodide-0.29.4",
  "abi": "pyodide_0_29",
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
  stat(path: string): Promise<VfsStat | null>;
  open(path: string, flags: OpenFlags, mode?: number): Promise<FileHandle>;
  read(handle: number, offset: number, length: number): Promise<Uint8Array>;
  write(handle: number, offset: number, bytes: Uint8Array): Promise<number>;
  close(handle: number): Promise<void>;
  readdir(path: string): Promise<VfsDirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  fsync(handle?: number): Promise<void>;
  revision(path?: string): Promise<number>;
}
```

This bridge is the contract. Implementations may optimize with page caches,
batching, or snapshots, but they must preserve coherence. Current production
wiring uses it for supervisor file RPCs and Node async filesystem fallback.
Python, Ruby, and WASI still need direct long-lived bridge integration.

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

## Language Runtime Plan

### Python

Target:

- `python`, `python3`, `pip`, and `pip3` commands.
- Pure Python wheels from PyPI where compatible.
- Packages with pure Python fallbacks, including packages whose optional
  extension artifacts can be disabled after install.
- Binary wasm32/emscripten wheels only when they are shipped as Nimbus
  startup-loaded runtime modules. Request-time dynamic extension loading is
  blocked by the Workers Wasm CSP.
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

1. Replace the provisional `pip` bridge with a package installer layer that
   understands wheel tags, requirements files, dependency metadata, and local
   VFS paths.
2. Cache pure wheels and precompiled Nimbus startup-loadable extension modules
   by ABI in the runtime catalog or R2.
3. Add a builder path outside the Durable Object for packages that need
   Emscripten/Pyodide compilation. The DO should install built artifacts, not
   spend constrained session CPU compiling large C/C++ projects.
4. Add a Python runtime FS bridge instead of relying on per-command snapshots.
5. Implement a Nimbus WSGI/ASGI server adapter. `python -m http.server` can map
   to this adapter, but it must not pretend a static JS server is Python.

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

1. Implement RubyGems metadata fetch, gem download, extraction, activation,
   binstub registration, and lockfile support.
2. Implement Bundler's needed resolver/install contract or invoke a
   ruby.wasm-compatible Bundler path when available.
3. Separate pure Ruby gems from native-extension gems. Unsupported native gems
   must fail with a precise ABI diagnostic.
4. Add a Ruby runtime FS bridge instead of relying on per-command snapshots.
5. Implement Rack-to-`Request`/`Response` preview routing. Ruby `httpd`
   compatibility should use the Ruby/Rack path or be clearly documented as a
   Nimbus static command.

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

1. Add a PTY contract: raw mode, terminal dimensions, resize events,
   `stdin.isTTY`, `stdout.isTTY`, ANSI passthrough, and signal delivery.
2. Move dynamic Worker `fs` shims toward the shared live FS bridge.
3. Add real smoke probes for opencode, pi.dev, and local Proteus CLI.
4. Build an adapter/replacement registry for common native packages that have
   usable WASM or pure-JS alternatives.

## Web Server And Preview Plan

The port registry is already the right primitive for HTTP preview:

- A process owns a port.
- `/port/<n>/...` forwards a real `Request`.
- The runtime returns a real `Response`.
- Bodies stream without JSON serialization.

Language web servers should plug into this model:

- Node: `http.createServer().listen(port)` maps directly to the port registry.
- Python: WSGI and ASGI adapters map app calls to `Request`/`Response`.
- Ruby: Rack adapter maps Rack env responses to `Response`.
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
- agentic CLI Node primitives:
  `tests/behavioral/agentic-cli/new/node-child-process-primitives.mjs`,
  `tests/behavioral/agentic-cli/new/node-live-vfs-async-fs.mjs`,
  `tests/behavioral/agentic-cli/new/node-live-vfs-symlink.mjs`, and
  `tests/behavioral/agentic-cli/new/node-sync-cwd-project-snapshot.mjs`
- runtime package manager:
  `tests/behavioral/pkg-manager/*`
- npm/npx primitives:
  `tests/behavioral/runtime-primitives/*` and
  `tests/behavioral/runtime-pkg/*`
- WASI:
  `tests/behavioral/wasi/*`, `tests/behavioral/wasi-files/*`, and
  `tests/behavioral/wasi-paths/*`
- Python basics and provisional pure-package support:
  `tests/behavioral/python/*`
- Ruby basics and provisional pure-gem command support:
  `tests/behavioral/ruby/*`
- preview ports:
  `tests/behavioral/preview/*`
- file-watch behavior:
  `tests/behavioral/file-tree-watch/*`

This document did not rerun the full probe suite. It records source-backed
current state and the test surfaces that should be used to prove future work.

## Required New Probes

Add black-box probes for:

- Live FS coherence:
  - long-running Node process observes editor writes without restart
  - long-running Python process observes file changes without snapshot stale
  - long-running Ruby process observes file changes without snapshot stale
  - conflicting writes produce deterministic conflict behavior
- Python package manager:
  - constraints files and complex resolver behavior
  - unsupported manylinux wheel fails with ABI diagnostic
  - simple WSGI app previews on a port
  - simple ASGI app previews on a port
- Ruby package manager:
  - `gem install rack`
  - unsupported native gem fails with ABI diagnostic
  - Rack app previews on a port
- POSIX/WASI:
  - `fd_sync` and process-exit flush
  - truncate and append behavior
  - symlink metadata behavior
  - large-file paged reads
  - poll mixed file/socket/timer behavior under load
- PTY and agentic CLIs:
  - TTY flags and terminal dimensions
  - raw mode input
  - resize events
  - signal delivery
  - opencode smoke
  - pi.dev smoke
  - Proteus CLI smoke

Probes must assert user-visible behavior, not static strings or HTTP 200 alone.

## Success Criteria

Nimbus OS compatibility is ready to market when these are true:

- Docs and UI never claim Linux-native support that Nimbus does not provide.
- `nimbus install <command>` works for catalog-provided command aliases.
- Missing installable commands print a matching install hint.
- Python can install and import pure wheels and packages with pure fallbacks
  from normal `pip` workflows.
- Python web apps can be previewed through a real WSGI or ASGI adapter.
- Ruby can install and require pure Ruby gems.
- Ruby web apps can be previewed through a real Rack adapter.
- Long-running Node, Python, Ruby, and WASI processes see coherent filesystem
  state through the live bridge.
- Native Linux packages fail early with clear ABI diagnostics.
- Agentic CLIs either run or fail at a specific unsupported ABI/API boundary.
- Warm common commands feel interactive, with runtime warm-up and cache
  diagnostics visible enough to debug regressions.

## Immediate Workstreams

These are the concrete workstreams implied by the source audit.

1. Move more Node dynamic Worker `fs` shims to the live bridge while preserving fast
   bundled reads for known immutable module sources.
2. Move Python and Ruby from snapshot-only command IO to the live bridge.
3. Demote or rename static-server intercepts so user-facing behavior is honest.
4. Replace provisional Python `pip` behavior with an ABI-aware package
   installer and Pyodide wheel cache.
5. Complete Bundler-compatible dependency resolution for pure Ruby gems.
6. Add WSGI/ASGI and Rack adapters for real previewable Python/Ruby apps.
7. Add PTY support for interactive and agentic CLIs.
8. Add actual opencode, pi.dev, and Proteus CLI probes.
9. Update docs and README from the support matrix proven by probes.

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
- Prefer WSGI/ASGI and Rack adapters for web preview before attempting broad
  socket emulation for every language runtime.
- Build compiled package artifacts outside session Durable Objects and install
  the resulting Nimbus-native artifacts into VFS.

The main unresolved product choice is naming: whether the user-facing command
for static file serving should be `nimbus serve`, language-specific aliases,
or both.
