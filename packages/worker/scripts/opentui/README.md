<!--
This document is edited and maintained by Claude and is presented as-is.
-->

# OpenTUI wasm32-wasi build recipe

opencode's TUI links `@opentui/core`, whose render core is a Zig dynamic
library loaded over Bun FFI — a native shard Nimbus cannot execute. Upstream
OpenTUI ships no wasm build, so Nimbus builds one: a **wasm32-wasi REACTOR**
(entry disabled, `_initialize`, `rdynamic` FFI exports, resident after init —
the same lifecycle the dylib has under Bun FFI). The Zig core performs no
terminal syscalls of its own; all rendered bytes surface through the memory
backend or the native span feed, so the 16 WASI imports it needs are already
implemented by `src/runtime/wasi-instance.ts`.

Built from the upstream OpenTUI checkout at **v0.3.2** (commit
`0d449d4c170a703197f0321f48c7e3bd38dcbd31` — the version opencode 1.16.2
pins) with **Zig 0.15.2** (the exact version `build.zig` enforces).

## Files

- `build-wasm.mjs` — the reproducible build: verifies the source and
  toolchain pins, copies the Zig tree to a temp dir, applies the patches
  below (fail-loud on drift), runs
  `zig build -Dtarget=wasm32-wasi -Doptimize=ReleaseSmall`, size-optimizes
  with `wasm-opt -Oz` when binaryen is on PATH, validates the module shape,
  and stages `public/_assets/opentui/<version>/{opentui.wasm,manifest.json}`
  plus `src/opentui-wasm-artifact.generated.ts`. Inputs:
  `NIMBUS_OPENTUI_SRC` (default `/tmp/opentui-research/opentui`) and
  `NIMBUS_ZIG` (default `/tmp/opentui-research/zig-toolchain`). The build is
  byte-reproducible given the same pins (verified by rebuilding from
  different temp paths); the manifest records every sha needed to prove it.

- `nimbus-wasm-reactor-target.patch` — makes the stock Zig core compile for
  wasm32-wasi. Apply first. Upstream-PR-shaped ("add a wasm32-wasi reactor
  target"); every hunk is target-gated so native builds are unchanged:

  | File | Change |
  |---|---|
  | `build.zig` | wasm targets build as a reactor executable (`entry = .disabled`, `rdynamic`, `wasi_exec_model = .reactor`) instead of a dynamic library (wasm cannot be one); skip miniaudio/system-audio linking, keeping wasi-libc. |
  | `audio_stub.zig` (new) | mirrors `audio.zig`'s public surface with every operation reporting failure (-1 / empty / null engine) — wasm has no system audio device. Keeps the 22 `audio*` FFI exports without compiling miniaudio (which needs pthreads and wasi-libc lacks them). |
  | `lib.zig` | imports `audio_stub.zig` instead of `audio.zig` on wasm. |
  | `renderer-output.zig` | comptime-fences the (default-off) stdout-flush render-thread paths behind `!builtin.single_threaded`: `std.Thread.spawn`/`join` are compile errors on single-threaded targets. The thread never runs on wasm. |
  | `text-buffer.zig` | `file.getEndPos()` is `u64`; allocating needs a checked `u64 → usize` bound on 32-bit targets (folds away where `usize` is 64-bit). |

  Native parity is proven, not assumed: with BOTH patches applied, the
  x86_64-linux `zig build -Doptimize=ReleaseSmall` dylib is byte-identical
  to the pristine v0.3.2 build (sha256
  `d2f8965d2b41c60e20b416f55474e7e839862191bc690fad6f850c16af119e73` with
  Zig 0.15.2).

- `nimbus-wasm-ffi-abi.patch` — the host-callback and arena ABI. Apply
  second. The Zig core stores three nullable C fn pointers registered from
  the host (`setLogCallback`, `createEventSink`, `streamSetCallback`). A
  wasm host cannot place its functions in the module's indirect function
  table, so on wasm the registered "pointer" is an **opaque non-null token**
  minted by the host, and each invocation site routes through an extern
  import that hands the token back (native builds keep calling the fn
  pointer directly; the externs are never referenced, so the dylib is
  unchanged). Also adds wasm-only `nimbus_alloc`/`nimbus_free` exports for
  the copy-in/copy-back arena protocol — the host has no FFI views into
  linear memory, so it allocates scratch through these, writes arguments in,
  calls the FFI, reads results back, and frees.

  Two further wasm-gated changes, both root-caused live on the attach-TUI
  OOM (2026-07-23; see scratchpad/opencode-tui-leak.md):

  - **Global allocator = `std.heap.wasm_allocator` on wasm.** Upstream's
    GPA is backed by the page allocator, which on wasm can never unmap:
    every freed large allocation and emptied bucket page is linear memory
    lost forever, so alloc/free churn grows the module monotonically until
    the host's memory cap. `wasm_allocator`'s size-class freelists reuse
    freed memory. Native keeps the GPA (and its stats exports) unchanged.
  - **FFI-boundary `usize` fields are `u64` on wasm.** @opentui/core's JS
    struct packer sizes `usize`-shaped length fields as `u64` (every
    Bun-native target is 64-bit). On wasm32 `usize` is 4 bytes, so every
    field after the first length was read shifted — `StyledChunk.link_len`
    landed on the packed link *pointer* value, and each styled-text set
    copied an ~18 MB garbage "URL" into the link pool (~50 MB of permanent
    growth per home-screen text node; the isolate died mid-mount).
    `StyledChunk.text_len`/`link_len` and
    `ExternalCapabilities.term_name_len`/`term_version_len` are the four
    such fields across the packed-struct surface (all others are explicit
    u32/u64 or pointer-typed, which the packer already sizes per target).

## FFI ABI (what the host wires up)

Imports the host must provide (module `"opentui"`); `token` is the value the
host registered, `usize` is `u32` on wasm32, `u64` arrives as BigInt in JS:

| Import | Signature | Fired by |
|---|---|---|
| `logCallback` | `(token, level: u8, msgPtr, msgLen)` | `setLogCallback(token)` → any `logger.*` line |
| `eventSinkCallback` | `(token, namePtr, nameLen, dataPtr, dataLen)` | `createEventSink(token)` → `event_bus.emit` (EditBuffer events) |
| `streamCallback` | `(token, streamPtr, eventId: u32, arg0, arg1: u64)` | `streamSetCallback(stream, token)` → span-feed StateBuffer/ChunkAdded/DataAvailable/Closed |

Tokens must be non-zero (`0` is the null fn pointer — "no callback").

Exports added for the arena protocol:

| Export | Signature | Notes |
|---|---|---|
| `nimbus_alloc` | `(size: usize) -> ptr` | 16-byte aligned; `0` on OOM |
| `nimbus_free` | `(ptr, size: usize)` | size must match the alloc |

## Rebuild

```
node packages/worker/scripts/opentui/build-wasm.mjs
bun tests/unit/opentui-wasm-smoke.mjs
```

The smoke test instantiates the staged artifact under the real
`wasi-instance.ts` preamble host, drives a frame through the memory and
span-feed backends, and exercises all three callback imports and the arena
exports.

## Upstream PR notes

`nimbus-wasm-reactor-target.patch` is submittable as-is. For
`nimbus-wasm-ffi-abi.patch`, an upstream PR would likely bikeshed the import
module name and rename `nimbus_alloc`/`nimbus_free` (e.g. `opentuiAlloc`);
the mechanics — host tokens for the three callback registries, an exported
arena allocator — are target-gated and inert for native embedders either
way. Keep the names in sync with the Nimbus host glue if they change.
