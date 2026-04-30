# Section 07 — Workerd Hard Limits

> Platform constraints that no Nimbus wave can fix. Cite this section
> when refusing user requests for "make it like real Node".

## Verified at HEAD `e93b18d` against prod `c6449d38`

Each limit below has a probe artifact OR a Cloudflare docs URL OR a
direct workerd source link.

## L1 — `child_process.spawn` / `fork` / `execSync` ❌

**Verified probe:** ([child_process.out.txt](../probes/node-builtins/child_process.out.txt))
```
execSync THREW: child_process.execSync: synchronous command execution not available in Nimbus isolate
exec err: child_process.exec: command execution requires supervisor connection
spawn error: child_process.spawn: process spawning requires supervisor connection
```

Workerd has no process model. Any CLI that shells out to git/python/make/cc
cannot work. Mitigation: Nimbus offers in-tree equivalents
(`cf-git` for git, `unix-commands.ts` for shell builtins,
`nimbus npm` for package management).

## L2 — `vm.runInContext` real V8 isolation ❌

**Verified probe:** ([vm.out.txt](../probes/node-builtins/vm.out.txt))
```
vm require failed: Cannot find module 'vm' (from /tmp)
```

Workerd has no `node:vm` module. A `Function`-based polyfill could give us
~80% of `runInNewContext` cases (W2 fix), but real per-call V8 contexts
are impossible from inside a workerd isolate. Spawning a `LOADER.load`
sub-isolate is the closest equivalent — too heavy for typical `vm` usage.

## L3 — `eval()` / `new Function()` at request time ❌

**Verified probe:** ([eval-and-Function.out.txt](../probes/dynamic/eval-and-Function.out.txt))
```
eval fail: Code generation from strings disallowed for this context
new Function fail: Code generation from strings disallowed for this context
```

`disallow_eval_during_request_handler` is workerd's default for compat
date ≥ 2025-06-01. Nimbus is at `2026-04-01`.

**Forces:** the precompile-at-module-eval pattern in
`src/facet-manager.ts:187-191` for every `.js` file in the VFS bundle.
Files written at runtime via `fs.writeFileSync` cannot be `require()`'d
because they hit a request-time `new Function()`.

## L4 — `.node` dlopen ❌

Workerd cannot load native code. Any package shipping a `.node` file
(NAPI, node-gyp output, prebuild-install target) fails.

**Mitigation:** WASM swaps where viable (Section 04). REJECT_INSTALL with
guidance otherwise.

## L5 — `SharedArrayBuffer` + Web Workers ❌

No `Worker` constructor in workerd. Multi-threaded WASM falls back to
single-thread or fails to init.

**Affects:** `sharp-wasm32` (fails on libvips threads init),
`@tailwindcss/oxide-wasm32-wasi` (single-thread fallback in theory but blocked separately by `node:wasi` — see L7).

`SharedArrayBuffer` also requires cross-origin-isolation headers — not
applicable to dynamic-worker isolates.

## L6 — TLS server, raw TCP server ❌

Workerd has TLS *client* (`node:tls.connect` since 2025-04-08) but **no
`net.Server.listen()` on a real port**.

**Verified probe:** ([net.out.txt](../probes/node-builtins/net.out.txt))
```
keys: Socket,Server,createServer,createConnection,connect,isIP,isIPv4,isIPv6
Socket connect emitted   ← shim lies; no real TCP
```

The `net.Socket` shim immediately emits `'connect'` without making any
TCP call. Any user code attempting raw TCP from a facet (database wire
protocols, custom protocols) silently no-ops.

For inbound: Workers Tunnels. For outbound: `cloudflare:sockets`.

## L7 — `node:wasi` is a throwing stub ❌

**Verified probe:** ([tailwindcss-oxide-wasm.out.txt](../probes/wasm/tailwindcss-oxide-wasm.out.txt))
```
LOAD FAIL: Cannot find module 'node:wasi' (from home/user/app/node_modules/@tailwindcss/oxide-wasm32-wasi)
```

(The error here is the runtime resolver's, but the underlying constraint
is workerd's: even if the resolver found `node:wasi`, the WASI
constructor throws `ERR_METHOD_NOT_IMPLEMENTED('WASI')`. Verified at:
https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts)

Userland WASI shims (`@emnapi/wasi-threads`, Emscripten, wasm-bindgen)
survive — they don't import `node:wasi`. Verified working: `bcryptjs`,
`esbuild-wasm`, `@resvg/resvg-wasm`, `hash-wasm`, `wasm-vips` (partial).

## L8 — Synchronous filesystem fd APIs ❌

**Verified probe:** ([fs.out.txt](../probes/node-builtins/fs.out.txt))
```
openSync typeof: undefined
realpathSync typeof: undefined
```

Real `fs.openSync` returning a real kernel fd doesn't exist in the shim.
Real `fs.realpathSync` doesn't exist. Any legacy CLI tool or test
runner that uses fd-loop I/O cannot work — must rewrite to whole-file
APIs (`fs.readFileSync(path)` works).

## L9 — `http2` client streaming bidi ❌

Workerd's `node:http2` is a stub (auto-on at 2025-09-01 but non-functional).
**Affects:** `@grpc/grpc-js` bidi streaming. Unary + server-streaming via
fetch shim works.

## L10 — `fs.watch` real inotify ❌

The shim's `fs.watch` (visible in keys list at probe
[fs.out.txt](../probes/node-builtins/fs.out.txt)) polls — events lag.

**Affects:** Vite HMR perceived latency, file-watch-driven test runners.

## L11 — `import.meta.url` for user `node` scripts ❌

**Verified probe:** ([import-meta.out.txt](../probes/dynamic/import-meta.out.txt))
```
[process killed: facet error: Cannot use 'import.meta' outside a module]
```

User code runs inside `new Function()` (not an ESM module). Any modern
ESM-only CLI script using `import.meta` SyntaxErrors before its first
statement.

**Workaround:** Nimbus's `node` runner refuses ESM-only scripts; user
must write CJS or use `(async () => {...})()` wrapping.

## L12 — Top-level await in user `node` scripts ❌

**Verified probe:** ([top-level-await.out.txt](../probes/dynamic/top-level-await.out.txt))
```
[process killed: facet error: await is only valid in async functions and the top level bodies of modules]
```

Same root cause as L11.

## L13 — Real `process.memoryUsage()` inside the DO ❌ (zeros)

**Verified probe:** ([process.out.txt](../probes/node-builtins/process.out.txt))
```
memoryUsage: {"rss":0,"heapTotal":0,"heapUsed":0,"external":0,"arrayBuffers":0}
```

Workerd returns zeros for `process.memoryUsage()` inside a Durable
Object class context. (Dynamic-worker isolates DO get real numbers
under `nodejs_compat`, but the shim's `__processMod.memoryUsage`
overrides with zeros.)

Nimbus copes via `src/diag-counters.ts` — application-level allocation
counters that work in the DO.

## L14 — `Atomics.wait` / `Atomics.notify` ❌

Require `SharedArrayBuffer` (see L5). **Affects:** lock-based concurrency
primitives in user code or in WASM modules.

## L15 — Per-isolate memory > 128 MiB ⚠️

Workerd default cap. **Affects:** large WASM modules, image processing of
large images, big `npm install` working sets. **Workaround:** stream /
chunk; `NimbusFacetPool` already plans around this.

## L16 — CPU time per request ⚠️

Workerd request budget: 30s on free, 5min on paid. **Affects:** long-
running `npm install`, large WASM compilations. Nimbus chunks installs
across multiple facet calls.

## L17 — `crypto.createHash` sync — workerd has it but shim shadows ⚠️

This is *not* a workerd limit — workerd has full `node:crypto` since
2025-04-08. The limit is **architectural**: the shim's `__require`
intercepts `require('crypto')` and returns the FNV-1a fake.

**Verified probe:** ([crypto.out.txt](../probes/node-builtins/crypto.out.txt))
```
sha256(hello): abdd62852c5bd7fc9fa116d64f0254ecabdd62852c5bd7fc9fa116d64f0254ec
expected real:    2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

The escape hatch — `crypto.subtle` global — DOES work
([globals.out.txt](../probes/dynamic/globals.out.txt) shows
`crypto.subtle typeof: object`). User code that uses Web Crypto directly
gets real output.

The `node:crypto` API needs a shim fix (W2): route `createHash` through
either workerd's static `import 'node:crypto'` OR through `crypto.subtle`
(the latter is async-only — would break sync-`digest()` APIs anyway).

## Fundamental package non-starters (REJECT_INSTALL list)

| Package | Reason |
|---|---|
| `node-pty` | `fork()` + `openpty()` — no process model, no PTY device |
| `robotjs` | X11/Win32/Quartz — needs interactive desktop session |
| `better-sqlite3` | Synchronous SQLite over native bindings; no WASM equivalent has both sync + persistent storage |
| `usb`, `serialport`, `bluetooth-hci-socket` | Hardware access |
| `electron`, `nw.js` | Embedded Chromium runtime |
| Native-only Prisma without driver adapter | Spawned query-engine binary impossible |
| `canvas` (node-canvas) for HTMLCanvas2D parity | No WASM HTMLCanvas2D-API-compatible package exists |
| `iohook`, `node-hid`, `node-record-lpcm16` | Device input |

## Citations

- Compat flags reference: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Compat dates reference: https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- Workerd source: https://github.com/cloudflare/workerd
- `node:wasi` stub: https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts
- `node:crypto`/`node:tls` (since 2025-04-08): https://developers.cloudflare.com/changelog/post/2025-04-08-nodejs-crypto-and-tls/
- `node:fs` (since 2025-09-01): https://developers.cloudflare.com/changelog/post/2025-08-15-nodejs-fs/
- `nodejs_compat` overview: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
