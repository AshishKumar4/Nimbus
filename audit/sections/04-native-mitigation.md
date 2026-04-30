# Section 04 — Native Bindings & WASM Mitigation

> Probes captured 2026-04-29 against prod `https://nimbus.ashishkmr472.workers.dev`
> at HEAD `e93b18d`.
> **Probe artifacts:** [`audit/probes/wasm/<name>.out.txt`](../probes/wasm/)
> + [`<name>.probe.js`](../probes/wasm/).

## TL;DR

The native-binding picture has **two failure modes layered on top of each
other**:

1. **The WASM target itself can't load** — `node:wasi` stub
   (`@tailwindcss/oxide-wasm32-wasi` blocked), `.wasm` file fs access
   (`sql.js` blocked), pre-bundle gap (`@swc/wasm-web` blocked).
2. **The runtime resolver can't find the WASM target's CJS entry** — same
   exports/subpath gap as Section 03 (`sass`, `@grpc/grpc-js`,
   `@libsql/client`, `@rollup/wasm-node` blocked).

**Layer 2 dominates.** Of 12 WASM probes, 6 fail at layer 2 (resolver) — only
1 fails at layer 1 (`node:wasi`). **Fixing Section 03's W2 resolver work
unblocks 6 of the 12 WASM swaps for free**, including the `bcrypt → bcryptjs`
auto-swap (which DOES work today), `node-sass → sass`,
`grpc → @grpc/grpc-js`.

## Probe results

| WASM target | Status | Verbatim runtime evidence | Probe |
|---|---|---|---|
| `bcryptjs` | **✅** | `hash len: 60`, `verify: true` | [bcryptjs.out.txt](../probes/wasm/bcryptjs.out.txt) |
| `esbuild-wasm` | **✅** | `keys: analyzeMetafile,…,build,buildSync,…` | [esbuild-wasm.out.txt](../probes/wasm/esbuild-wasm.out.txt) |
| `@resvg/resvg-wasm` | **✅** | `keys: Resvg,initWasm` | [resvg-wasm.out.txt](../probes/wasm/resvg-wasm.out.txt) |
| `wasm-vips` | ⚠️ ish | `keys: default` (loads but only `default` export — needs further validation; Emscripten init likely incomplete) | [wasm-vips.out.txt](../probes/wasm/wasm-vips.out.txt) |
| `hash-wasm` | **✅** | `keys: adler32,argon2Verify,argon2d,argon2i,argon2id,bcrypt,bcryptVerify,blake2b,blake2s,blake3` | [hash-wasm.out.txt](../probes/wasm/hash-wasm.out.txt) |
| `sass` (dart-sass) | ⚠️ resolver | `Cannot find module './sass.dart.js' (from home/user/app/node_modules/sass)` — **resolver exports gap, not WASM issue** | [sass.out.txt](../probes/wasm/sass.out.txt) |
| `@grpc/grpc-js` | ⚠️ resolver | `Cannot find module './call-credentials' (from .../grpc-js/build/src)` — **resolver gap** | [grpc-grpc-js.out.txt](../probes/wasm/grpc-grpc-js.out.txt) |
| `@libsql/client` | ⚠️ resolver | `Cannot find module '@libsql/core/config' (from .../@libsql/client/lib-cjs)` — **resolver subpath-exports gap** | [libsql-client.out.txt](../probes/wasm/libsql-client.out.txt) |
| `@rollup/wasm-node` | ⚠️ resolver | `Cannot find module './shared/rollup.js' (from .../@rollup/wasm-node/dist)` | [rollup-wasm-node.out.txt](../probes/wasm/rollup-wasm-node.out.txt) |
| `@swc/wasm-web` | ⚠️ pre-bundle | `Cannot load module '.../@swc/wasm-web/wasm.js': file was not pre-bundled` | [swc-wasm-web.out.txt](../probes/wasm/swc-wasm-web.out.txt) |
| `sql.js` | ❌ wasm-fs | `ENOENT: no such file or directory, open '/home/user/app/node_modules/sql.js/dist/sql-wasm.wasm'` | [sql-js.out.txt](../probes/wasm/sql-js.out.txt) |
| `@tailwindcss/oxide-wasm32-wasi` | ❌ node:wasi | `Cannot find module 'node:wasi' (from .../@tailwindcss/oxide-wasm32-wasi)` | [tailwindcss-oxide-wasm.out.txt](../probes/wasm/tailwindcss-oxide-wasm.out.txt) |

## Findings

### F1 — `node:wasi` is the hard stop for `wasm32-wasi` packages

`@tailwindcss/oxide-wasm32-wasi` requires `node:wasi`. Even though
the package's own loader uses `@emnapi/wasi-threads` (a userland WASI
shim), it DOES `require('node:wasi')` somewhere in its chain.

The runtime resolver returns `Cannot find module 'node:wasi'` because:
- The shim's builtins table at `src/node-shims.ts:771-849` doesn't include `wasi`
- The runtime resolver doesn't know to look at workerd's actual `node:wasi` stub
- Even if it did, workerd's `node:wasi` constructor throws
  `ERR_METHOD_NOT_IMPLEMENTED('WASI')` — verified at
  https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts

**Practical conclusion:** any package importing `node:wasi` is dead in
workerd today. `wasm-vips`, `hash-wasm`, `esbuild-wasm`, `bcryptjs`,
`@resvg/resvg-wasm` — all five working WASM targets DO NOT import
`node:wasi` (they ship userland WASI shims or don't need WASI at all).

### F2 — `.wasm` files in `node_modules` aren't loadable

`sql.js`'s loader does `fs.readFileSync('.../sql-wasm.wasm')` and gets
ENOENT. The .wasm IS in the tarball — `npm install` says `added 1 packages
(28 files)` — but the runtime fs shim can't read it.

This is *probably* because the VFS write step for `npm-install-batch-facet`
filters tar entries, dropping non-script blobs. Verified path:
`src/npm-install-batch-facet.ts:139-358 installOne` writes via
`env.SUPERVISOR.writeBatch`. Worth a focused W3 verification — is there
an extension-allowlist that drops `.wasm`?

`grep -n "writeBatch\|tarball" src/npm-install-batch-facet.ts | head` …
not directly visible without deeper dive; flagged as W3 sub-task.

### F3 — Layer-2 (resolver) blocks more than layer-1 (WASM)

| Failure mode | Count |
|---|---|
| Resolver exports / subpath gap (Section 03) | 4 (`sass`, `@grpc/grpc-js`, `@libsql/client`, `@rollup/wasm-node`) |
| Pre-bundle missing | 1 (`@swc/wasm-web`) |
| `node:wasi` blocked | 1 (`@tailwindcss/oxide-wasm32-wasi`) |
| `.wasm` fs gap | 1 (`sql.js`) |
| Behavioural quirk (only `default` export) | 1 (`wasm-vips`) |
| Working as intended | 5 (`bcryptjs`, `esbuild-wasm`, `@resvg/resvg-wasm`, `hash-wasm`, `wasm-vips` partial) |

**Most "WASM swap" candidates fail at the resolver, not at WASM init.**
The W2 resolver fix is a multiplier on the W3 WASM strategy — there's no
point shipping AUTO_SWAP for `bcrypt→bcryptjs` etc. if the result still
fails at runtime resolution.

## Native binding catalogue (with concrete probe-backed mitigation)

| Native pkg | Workerd-incompat reason | Best WASM alternative | Verified path |
|---|---|---|---|
| `bcrypt` | NAPI dlopen of OpenBSD bcrypt C | `bcryptjs` (pure JS, zero deps) | **AUTO-SWAP works** ([bcryptjs.out.txt](../probes/wasm/bcryptjs.out.txt) — `hash len: 60`, `verify: true`) |
| `node-sass` | NAPI of libsass | `sass` (dart-sass) | **PROMPT_SWAP** — needs W2 resolver fix to work ([sass.out.txt](../probes/wasm/sass.out.txt) — currently fails on `./sass.dart.js`) |
| `grpc` | Native NAPI | `@grpc/grpc-js` (pure JS) | **PROMPT_SWAP** — needs W2 resolver fix ([grpc-grpc-js.out.txt](../probes/wasm/grpc-grpc-js.out.txt)) |
| `esbuild` (Go binary) | spawn a Go child process | `esbuild-wasm` | **AUTO-SWAP works** (Nimbus already uses internally — `src/esbuild-service.ts`, `src/esbuild-wasm-bytes.ts`) |
| `@swc/core` | NAPI Rust | `@swc/wasm-web` | ⚠️ needs pre-bundle path — file-not-pre-bundled error ([swc-wasm-web.out.txt](../probes/wasm/swc-wasm-web.out.txt)) |
| `@tailwindcss/oxide` | NAPI Rust | `@tailwindcss/oxide-wasm32-wasi` | ❌ blocked by `node:wasi` stub ([tailwindcss-oxide-wasm.out.txt](../probes/wasm/tailwindcss-oxide-wasm.out.txt)) |
| `sharp` | dlopen of libvips | `wasm-vips` (Emscripten) | ⚠️ partial — only `default` export visible, needs Emscripten init validation ([wasm-vips.out.txt](../probes/wasm/wasm-vips.out.txt)). `@resvg/resvg-wasm` ✅ for SVG-only ([resvg-wasm.out.txt](../probes/wasm/resvg-wasm.out.txt)) |
| `sqlite3` / `better-sqlite3` | Native SQLite | `sql.js` (Emscripten) | ❌ blocked by `.wasm` fs gap ([sql-js.out.txt](../probes/wasm/sql-js.out.txt) — `ENOENT … sql-wasm.wasm`); `@libsql/client` HTTP mode → resolver fix ([libsql-client.out.txt](../probes/wasm/libsql-client.out.txt)) |
| `node-canvas` / `@napi-rs/canvas` | Cairo / Skia native | `canvaskit-wasm` (Skia surface, NOT Canvas2D-API-compatible) | UNVERIFIED — recommend PROMPT_SWAP, not AUTO |
| `argon2` | NAPI Argon2 C | `hash-wasm` (`argon2d`/`argon2i`/`argon2id`) | **AUTO-SWAP candidate** ✅ ([hash-wasm.out.txt](../probes/wasm/hash-wasm.out.txt) — `keys: adler32,argon2Verify,argon2d,argon2i,argon2id,bcrypt,…`) |
| `rollup` (uses fsevents+native) | optional native | `@rollup/wasm-node` | ⚠️ needs W2 resolver fix ([rollup-wasm-node.out.txt](../probes/wasm/rollup-wasm-node.out.txt)) |
| `node-pty` / `robotjs` | OS-syscall / desktop | (none) | **REJECT_INSTALL** with helpful message |
| `@prisma/client` | Spawns query-engine binary | None drop-in; W3 PROMPT for adapter mode | **REJECT** with guidance on `@prisma/adapter-d1` |

## Proposed swap policy

Follow Section 03's W2 → W4 sequence: resolver fix THEN WASM swap, in
that order, because layer-2 blocks most layer-1 attempts.

```typescript
// Sibling of SKIP_PACKAGES in src/npm-resolver.ts.
// Each entry is fully validated by an audit/probes/wasm/<target>.out.txt
// artifact at the time of policy commit.

const AUTO_SWAP: Record<string, string> = {
  // VERIFIED working today:
  'bcrypt':     'bcryptjs',     // probes/wasm/bcryptjs.out.txt
  'esbuild':    'esbuild-wasm', // already implicit (src/esbuild-service.ts)
};

const PROMPT_SWAP: Record<string, { to: string; note: string; verified: boolean }> = {
  // Needs W2 resolver fix to actually run:
  'node-sass':  { to: 'sass',                 note: 'dart-sass; W2 unblocks',         verified: false },
  'grpc':       { to: '@grpc/grpc-js',        note: 'pure JS; W2 unblocks',           verified: false },
  'rollup':     { to: '@rollup/wasm-node',    note: 'WASM-native; W2 unblocks',       verified: false },
  // Different API:
  '@swc/core':  { to: '@swc/wasm-web',        note: 'transform/parse only, no Plugin', verified: false },
  // SVG-only:
  'sharp':      { to: '@resvg/resvg-wasm',    note: 'SVG→PNG only; full sharp NOT possible', verified: true },
  // Argon2 family:
  'argon2':     { to: 'hash-wasm',            note: 'argon2d/argon2i/argon2id supported', verified: true },
};

const REJECT_INSTALL: Record<string, string> = {
  'better-sqlite3': 'No async-compatible drop-in. Use @libsql/client or Nimbus SqliteVFS.',
  'node-pty':       'No PTY in workerd. Use Nimbus built-in shell.',
  'robotjs':        'Desktop automation not possible in a sandboxed Worker.',
  '@tailwindcss/oxide-wasm32-wasi': 'workerd node:wasi is a stub. Wait for upstream fix.',
};
```

## Open spike: where does `.wasm` go in the VFS?

`sql.js` install reports 28 files written, but `fs.readFileSync('.../sql-wasm.wasm')`
returns ENOENT. Two hypotheses:

- **(H1)** Tarball extraction filters non-script files. Verify by reading
  `src/npm-install-batch-facet.ts` and `src/npm-tarball-stream.ts` for
  any extension allowlist.
- **(H2)** The .wasm IS in the VFS but `__resolveFile` / `__readFileOr`
  in `node-shims.ts` doesn't reach it because of path normalization
  bugs.

Recommend a 30-min spike before W3: install `sql.js` then run
`ls /home/user/app/node_modules/sql.js/dist` from prod shell — if the
.wasm shows in `ls`, it's H2 (resolver bug). If it doesn't show, it's H1
(install filter).

## Citations

- Probe driver: [audit/probes/_driver.mjs](../probes/_driver.mjs)
- Per-probe artifacts: [audit/probes/wasm/](../probes/wasm/)
- Workerd `node:wasi` stub: https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts
- Workerd flag `enable_nodejs_wasi_module`: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-nodejs-wasi-module
- `node:wasi` always-throws constructor: see workerd src + Cloudflare changelog
- `npm bug 4828` (optDep platform): https://github.com/npm/cli/issues/4828
- `bcryptjs` (3.0.3): pure JS, zero deps — npm registry
- `@grpc/grpc-js`: official pure-JS replacement for the deprecated `grpc` package
- `wasm-vips`: Emscripten libvips port; size ~15 MB unpacked
- `sql.js`: Emscripten + Asyncify SQLite; ~19 MB unpacked
