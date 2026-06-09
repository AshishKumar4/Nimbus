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
  foreground attached npm-bin TTY tabs, Pi's official installer path, and the
  Pi npm CLI path. Unverified agent CLIs such as opencode and local Proteus
  still need live probes, and native-package shards still need Nimbus ABI
  artifacts or precise diagnostics.
- The shell has useful POSIX-like behavior, but several compatibility repairs
  still live as line normalizers around the current parser. That is acceptable
  as alpha debt, but the final OS shell needs a real parser/executor contract
  for fd redirects, grouping, quoting, heredocs, traps, signals, and scripts.

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
| opencode/Proteus CLIs | Pi's npm CLI path is production-probed, but opencode and the local Proteus CLI are not yet proven in live Nimbus. | JavaScript CLIs launched from the terminal should see TTY=true when attached, TTY=false when piped, and should run unmodified unless they require unsupported native shards. |
| Python package breadth | Flask and MarkupSafe pure-source artifact paths are production-probed, and declared Pyodide startup-module package artifacts are supported by the runtime catalog. `pip` is not a complete upstream build system. | Nimbus pip must resolve/install only Nimbus-compatible artifacts, preloaded PyEmscripten modules, pure wheels, or curated pure source artifacts. Unsupported extension artifacts fail before import with an ABI diagnostic. |
| Shell parser debt | Some unsupported shell syntax is normalized before the parser, including fd-to-fd redirects and limited subshell shapes. | Shell syntax should be represented in an AST and executed through structured semantics, not regex rewrites in the hot path. |
| Native platform packages | Native `linux-x64`, `darwin`, `win32`, manylinux wheels, and native gems cannot execute. | Package managers must select Nimbus ABI artifacts, pure packages, or fail early with exact unsupported ABI reasons. |

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

## Nimbus OS Kernel Plan

The missing capabilities should be built as shared OS services, not as
per-runtime patches.

### Process And PTY Kernel

Nimbus needs a first-class process IO contract:

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
- Hibernation metadata stores the process id, command, terminal size, active
  mode, and replay cursor. Durable process state remains in SQLite-backed
  process/log tables.
- Process logs are still recorded, but logs are secondary to the live PTY for
  foreground TUIs.
- The SDK must expose this as an explicit terminal/process attachment surface,
  not hide it behind `exec`.

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

Nimbus virtual sockets should be a shared kernel service:

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
- ABI name, such as `pyodide_0_29`, `ruby_wasm`, `wasm32-wasi-nimbus`, or
  `node_workerd_nimbus`
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
6. Prove `pip install flask`, `python -m flask run`, direct `app.run(...)`,
   and `python -m http.server` through production probes.

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
6. Prove `gem install rack`, a Rack app, and a WEBrick-style hello-world app
   through production probes.

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
- Bodies stream without JSON serialization.

Language web servers should plug into this model:

- Node: `http.createServer().listen(port)` maps directly to the port registry.
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

- POSIX shell:
  - remaining shell grammar not covered by current `sh`/`bash` probes:
    grouping, command substitution, `set -e`, `trap`, and shebang dispatch
- Live FS coherence:
  - long-running Node process observes editor writes without restart
  - long-running Python process observes file changes without snapshot stale
  - long-running Ruby process observes file changes without snapshot stale
  - conflicting writes produce deterministic conflict behavior
- Python package manager:
  - complex resolver behavior and transitive pure-wheel installs
  - unsupported manylinux wheel fails with ABI diagnostic
  - declared Pyodide startup-module packages import without request-time wasm
    instantiation failures
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
  - raw mode input
  - signal delivery
  - log-only tabs still work for daemon processes
  - opencode smoke
  - Proteus CLI smoke

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

These are the concrete workstreams implied by the source audit.

1. Harden the PTY process kernel and browser process-tab attachment contract.
   Foreground TUIs are interactive terminal tabs; daemon processes remain
   log-readable tabs.
2. Keep package-bin launch based on structured shebang/bin metadata handling and
   terminal-context-aware TTY selection. Avoid regex parsing when package
   metadata or a JavaScript parser can identify the entrypoint.
3. Continue replacing remaining shell parser debt with structured POSIX shell
   AST execution in the Nimbus-owned shell substrate.
4. Move Node dynamic Worker `fs` shims to the live bridge while preserving fast
   bundled reads for known immutable module sources.
5. Move Python and Ruby from snapshot-only command IO to the live bridge.
6. Expand the Python `pip` ABI planner and runtime catalog with more declared
   Pyodide wheel/cache/module artifacts as demand and size budgets justify.
7. Complete Bundler-compatible dependency resolution for pure Ruby gems.
8. Promote the virtual socket kernel to the shared OS network service and bind
   Node, Python, Ruby, and WASI adapters to it.
9. Remove hidden static-server substitutions from user-facing language server
   paths once the virtual socket path covers them.
10. Add production probes for unsupported native Python wheels, opencode,
    local Proteus CLI, and deeper shell grammar.
11. Update README, SDK docs, and AGENTS from the support matrix proven by those
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
