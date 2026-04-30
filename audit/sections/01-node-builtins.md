# Section 01 — `node:*` Built-ins Matrix

> **Repo HEAD:** `e93b18d`. Probes captured 2026-04-29 against prod
> `https://nimbus.ashishkmr472.workers.dev`.
> **Probe artifacts:** `audit/probes/node-builtins/<name>.out.txt` + `<name>.probe.js`.

## Methodology

Each builtin probed in a fresh prod facet (`POST /new` → WS → `node /tmp/p_*.js`).
Probe wrapped via `nodeEvalBase64` (driver writes JS to a /tmp file then runs
it — avoids both shell quoting and workerd's `disallow_eval_during_request_handler`,
verified at `crypto` probe via prior `eval()`-based attempt).

**Supervisor behaviour** is derived from source citation
(`src/node-shims.ts`, `wrangler.jsonc`, `src/facet-manager.ts`) +
Cloudflare docs cross-reference. Direct probe of supervisor not possible
because user code runs in a facet, not in the `NimbusSession` DO.

## Compat config

| Layer | Compat date | Flags |
|---|---|---|
| Supervisor | `2026-04-01` (`wrangler.jsonc:5`) | `["nodejs_compat","experimental"]` (`wrangler.jsonc:10`) |
| Facet (exec/fork) | `CF_COMPAT_DATE` (`src/constants.ts:35`) | `['nodejs_compat','nodejs_compat_v2']` (`src/facet-manager.ts:705,763`) |
| Facet (long-running) | same | `['nodejs_compat']` (`src/facet-manager.ts:881-882`) |
| Real-vite facet | same | `['nodejs_compat','enable_nodejs_http_modules','enable_nodejs_http_server_modules']` (`src/cirrus-real.ts:85-89`) |

**`compatibility_flags` do NOT inherit through `LOADER`** — each dynamic
worker call passes its own set. The shim layer in `src/node-shims.ts:771`
shadows workerd's real builtins for `require()` calls (only static
`import 'node:fs'` reaches workerd's native; see also `src/cirrus-real.ts:618`
where the real-vite facet does exactly that to escape the shim).

## Matrix — facet behaviour (probe-verified)

Legend: ✅ works as Node would · ⚠️ works partially / behavioural diff · ❌ throws / undefined

| Module | Status | Probe evidence | Shim citation |
|---|---|---|---|
| `fs` | ⚠️ | `keys: readFileSync,writeFileSync,…createReadStream,…watch` — `write+read: hi`. **`openSync typeof: undefined`**, **`realpathSync typeof: undefined`** ([fs.out.txt](../probes/node-builtins/fs.out.txt)) | `src/node-shims.ts:151-431` |
| `fs/promises` | ⚠️ | `keys: readFile,writeFile,stat,…access,promises` (no `cp`/`rm`/`open`). roundtrip: `x`. **`cp typeof: undefined`**, **`rm typeof: undefined`**, **`open typeof: undefined`** ([fs-promises.out.txt](../probes/node-builtins/fs-promises.out.txt)) | `src/node-shims.ts:359-367` |
| **`crypto`** | 🔴 **fake hash** | `sha256(hello): abdd62852c5bd7fc9fa116d64f0254ecabdd62852c5bd7fc9fa116d64f0254ec` (real: `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`). `md5(hello): abdd62852c5bd7fc9fa116d64f0254ec` (real: `5d41402abc4b2a76b9719d911017c592`). **The 32-byte sha256 output is a 16-byte FNV-1a state repeated twice — structurally degenerate.** `pbkdf2: undefined`, `scrypt: undefined`, `createCipheriv: undefined`. ([crypto.out.txt](../probes/node-builtins/crypto.out.txt)) | `src/node-shims.ts:527-563` (FNV-1a comment at `:543`, hash extension at `:554-558`) |
| `util` | ⚠️ | `inspect basic: { ... }` works. **`inspect cyclic: [object Object]`** — silently swallows cycles, doesn't show structure. `parseArgs typeof: undefined`. ([util.out.txt](../probes/node-builtins/util.out.txt)) | `src/node-shims.ts:481-506` |
| `path` | ✅ | `join: /a/c/d.txt`, `resolve: /a/b/c`, `basename: c`. `posix===path: true` (no win32 separation). ([path.out.txt](../probes/node-builtins/path.out.txt)) | `src/node-shims.ts:58-91` |
| `stream` | ⚠️ | `Readable`/`Writable`/`Transform` constructors present. **`promises typeof: undefined`**, **`web typeof: undefined`**. `Readable.from` works (`Readable.from collected: abc`). ([stream.out.txt](../probes/node-builtins/stream.out.txt)) | `src/node-shims.ts:476` (delegates to `streams.ts`) |
| `buffer` | ⚠️ | `Buffer.from`/`alloc`/`concat`/`isBuffer` work. **`Blob: undefined`**, **`File: undefined`**. ([buffer.out.txt](../probes/node-builtins/buffer.out.txt)) | `src/node-shims.ts:96-146` |
| `events` | ⚠️ | `emit/on/once`/`listenerCount` work. **`getEventListeners: undefined`**. ([events.out.txt](../probes/node-builtins/events.out.txt)) | `src/node-shims.ts:450-471` |
| `os` | ⚠️ | `platform: linux`, `arch: x64`, `tmpdir: /tmp`, `homedir: /home/user`, `cpus length: 1`, `totalmem: 134217728` (128 MiB stub). **`availableParallelism typeof: undefined`**. ([os.out.txt](../probes/node-builtins/os.out.txt)) | `src/node-shims.ts:436-445` |
| `url` | ✅ | `URL`/`parse`/`fileURLToPath`/`pathToFileURL` all work. ([url.out.txt](../probes/node-builtins/url.out.txt)) | `src/node-shims.ts:511-518` |
| `querystring` | ⚠️ | Default-sep `parse('a=1&b=2')` works. **Custom-sep `parse('a=1;b=2', ';')` returns `{"a=1;b=2":""}`** — sep arg ignored. ([querystring.out.txt](../probes/node-builtins/querystring.out.txt)) | `src/node-shims.ts:629-634` |
| **`zlib`** | ⚠️ async-only | `keys: gzip,gunzip,deflate,inflate,gzipSync,gunzipSync,…` (sync names PRESENT but throw). **`gzipSync THREW: use async gzip()`**. **`deflateSync THREW: z.deflateSync is not a function`** (note: not even shimmed). `async gzip: ok len=25`. **`brotliCompressSync typeof: undefined`**. ([zlib.out.txt](../probes/node-builtins/zlib.out.txt)) | `src/node-shims.ts:839-843` (sync throw at `:842`) |
| `http` | ⚠️ | `createServer` works (registers in `__portRegistry`). **`request threw: Use fetch()`**, **`get threw: Use fetch()`** — outbound HTTP entirely blocked through this API. ([http.out.txt](../probes/node-builtins/http.out.txt)) | `src/node-shims.ts:787-811` |
| `https` | ⚠️ | `request typeof: function`, `get typeof: function` — but each shells out to `fetch()` (`src/node-shims.ts:816`). No TLS options, no `Agent`. ([https.out.txt](../probes/node-builtins/https.out.txt)) | `src/node-shims.ts:812-819` |
| **`net`** | 🔴 lies | `Socket.connect(443, 'example.com')` immediately emits `'connect'` event but **never actually opens a TCP connection** — `.write()` silently drops bytes. Probe: `Socket connect emitted` despite no real network call. ([net.out.txt](../probes/node-builtins/net.out.txt)) | `src/node-shims.ts:820-831` |
| `tls` | ❌ | **`tls require failed: Cannot find module 'tls' (from /tmp)`** — not in shim's `builtins` table at all. Static `import 'node:tls'` would work (workerd has partial `node:tls` since 2025-04-08). ([tls.out.txt](../probes/node-builtins/tls.out.txt)) | (no shim) |
| **`child_process`** | ❌ | `keys: exec,execSync,spawn,fork,execFile,ChildProcess` — but every API throws. **`execSync THREW: child_process.execSync: synchronous command execution not available in Nimbus isolate`**. **`exec err: child_process.exec: command execution requires supervisor connection`**. **`spawn error: child_process.spawn: process spawning requires supervisor connection`**. ([child_process.out.txt](../probes/node-builtins/child_process.out.txt)) | `src/node-shims.ts:640-721` |
| **`vm`** | ❌ | **`vm require failed: Cannot find module 'vm' (from /tmp)`** — not in shim's `builtins` table. ([vm.out.txt](../probes/node-builtins/vm.out.txt)) | (no shim) |
| `worker_threads` | ⚠️ stub | `keys: isMainThread,parentPort,workerData,threadId,Worker`. `isMainThread: true`. **`Worker ctor ok`** but the worker is a no-op EventEmitter — `postMessage` is a stub, `terminate` resolves 0 immediately. ([worker_threads.out.txt](../probes/node-builtins/worker_threads.out.txt)) | `src/node-shims.ts:849` |
| **`async_hooks`** | ❌ | **`async_hooks fail: Cannot find module 'async_hooks' (from /tmp)`** — not in shim's `builtins`. ([async_hooks.out.txt](../probes/node-builtins/async_hooks.out.txt)) | (no shim — `nodejs_als` exposes `AsyncLocalStorage` only as a static `import 'node:async_hooks'` per CF docs) |
| `timers` | ⚠️ | `setTimeout`/`setImmediate` work. **`promises typeof: undefined`** — no `timers/promises`. ([timers.out.txt](../probes/node-builtins/timers.out.txt)) | `src/node-shims.ts:838` |
| `assert` | ⚠️ | `equal`/`deepEqual` flat + nested work. **`deepEqual cyclic THREW: Converting circular structure to JSON`** — JSON.stringify-based, fails on cycles. **`assert.match typeof: undefined`**, **`assert.rejects typeof: undefined`**. ([assert.out.txt](../probes/node-builtins/assert.out.txt)) | `src/node-shims.ts:609-624` |
| `perf_hooks` | ⚠️ | `performance.now` is a function. **`PerformanceObserver typeof: undefined`**. ([perf_hooks.out.txt](../probes/node-builtins/perf_hooks.out.txt)) | `src/node-shims.ts:848` |
| **`process`** | ⚠️ | `platform: linux`, `arch: x64`, `version: v20.0.0`, `cwd: /home/user`, `env keys count: 16`. **`memoryUsage: {"rss":0,"heapTotal":0,"heapUsed":0,"external":0,"arrayBuffers":0}`** — workerd returns zeros inside DO; shim doesn't override. `hrtime`/`hrtime.bigint` exist. ([process.out.txt](../probes/node-builtins/process.out.txt)) | `src/node-shims.ts:743-766` |

## Headline findings (with concrete evidence)

### 1. `crypto.createHash` is a fake — silent correctness bug

> Probe: `sha256(hello): abdd62852c5bd7fc9fa116d64f0254ecabdd62852c5bd7fc9fa116d64f0254ec` ([crypto.out.txt](../probes/node-builtins/crypto.out.txt))

Source: `src/node-shims.ts:543-563`. A 4-state FNV-1a hand-roll. Hash bytes
are produced by `(states[i % 4] >>> ((i >> 2) * 8)) & 0xff` (`:558`); for a
32-byte SHA-256 the same 16-byte FNV state output is repeated twice, hence
the visible `abdd62...` × 2 pattern. **Cryptographic non-starter.** Any user
code computing SHA-256 to verify against an external value silently
produces wrong output. Hmac is `createHash(algo).update(keyStr+chunks)` —
also fake (`src/node-shims.ts:580-590`).

### 2. `vm` and `tls` and `async_hooks` are not in the shim builtins table

`require('vm')` / `require('tls')` / `require('async_hooks')` all throw
`Cannot find module`. Static `import 'node:tls'`/`import 'node:async_hooks'`
would reach workerd's natives (partial since 2025-04-08 / always for
`AsyncLocalStorage`); `node:vm` doesn't exist in workerd at all.

The user-visible impact: **`jsdom` cannot load** because it requires `vm`
(see `audit/probes/packages/jsdom.out.txt:` `Cannot find module 'vm' (from
home/user/app/node_modules/jsdom/lib)`). Also blocks ts-node / jiti /
mock-require / source-map-support patterns that need a sandboxed eval.

### 3. `net.Socket` connect is a lie

`new net.Socket().connect(443, 'example.com')` immediately fires the
`'connect'` event but never makes a real TCP call (`src/node-shims.ts:823`).
`.write()` silently drops bytes. Anything attempting raw TCP from a facet
(database drivers like `pg`, `mysql2` over wire protocol, custom protocols)
will think it succeeded but produce no I/O.

### 4. `zlib.gzipSync` throws on purpose, `deflateSync` is missing entirely

`gzipSync` and `gunzipSync` are present in keys list but throw `use async
gzip()` (`src/node-shims.ts:842`). `deflateSync` isn't even shimmed — keys
list shows it but it's `not a function`. Real-vite reaches workerd's native
`node:zlib` via static import (`src/cirrus-real.ts:618` re-export pattern).

### 5. `process.memoryUsage()` returns all zeros

workerd's `process.memoryUsage()` returns `{rss:0, heapTotal:0, ...}` inside
a DO context. The shim doesn't override. Application-level allocation
counters live in `src/diag-counters.ts` for a reason.

### 6. `child_process` shim explicitly fails-loud — by design

Every API throws with a specific Nimbus message: `child_process.execSync:
synchronous command execution not available in Nimbus isolate`. The
architectural intent is supervisor-spawns-new-facet via
`FacetManager.exec()`, not in-facet child processes.

### 7. The shim lacks named-import-only escape hatch

Even though the facet has `nodejs_compat` + `nodejs_compat_v2`, user
`require('crypto')` gets the FNV-1a fake instead of workerd's real
`node:crypto`. Real workerd builtins are reachable only via static
`import 'node:crypto'` in pre-bundled code (see `src/cirrus-real.ts:618`,
`src/real-vite-fs-shim.ts:1005-1062`). User shell `node -e` gets the shim.
**This is the root of headline finding #1** and is a good candidate for a
W2 architectural fix (see Section 06 / W2 wave proposal).

## Builtins NOT covered by probes but worth noting

- `dns` — present in shim (`src/node-shims.ts:832-835`), uses Cloudflare DoH (`https://cloudflare-dns.com/dns-query`).
- `tty` — `isatty: () => false` stub (`src/node-shims.ts:836`).
- `module` — `createRequire()` returns Nimbus's `__require` regardless of arg (`src/node-shims.ts:837`).
- `string_decoder` — wraps `TextDecoder` (`src/node-shims.ts:636-638`).
- `console` — overridden to stream via Supervisor RPC (`src/facet-manager.ts:233-234`).
- `readline` — stub Interface that `question` resolves with `''` (`src/node-shims.ts:844-846`).
- `http2` — not in `builtins`, no shim (workerd: stub since 2025-09-01).
- `v8` — not in `builtins`, no shim (workerd: stub since 2026-03-17).
- `repl` — not in `builtins`, no shim.
- `wasi` — workerd ships a stub that throws `ERR_METHOD_NOT_IMPLEMENTED` from constructor (verified at `https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts`). Userland WASI shims (`@emnapi/wasi-threads`, Emscripten, wasm-bindgen) survive because they don't import `node:wasi`.

## Citations

- workerd source: https://github.com/cloudflare/workerd
- `node:crypto` (since 2025-04-08): https://developers.cloudflare.com/changelog/post/2025-04-08-nodejs-crypto-and-tls/
- `node:fs` (since 2025-09-01): https://developers.cloudflare.com/changelog/post/2025-08-15-nodejs-fs/
- `node:net`/`node:dns`/`node:timers` (since 2025-01-28): https://developers.cloudflare.com/changelog/post/2025-01-28-nodejs-compat-improvements/
- `nodejs_compat` overview: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Compatibility flags: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- `process` v2: https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/
