// bundle-patches.ts — pure bundle-source transforms for the Nimbus opencode
// build. Side-effect free and dependency free so build-node.ts (running inside
// the opencode clone) and the unit tests can both import them; the only source
// of truth for each fail-loud bundle seam.
//
// Each patch uses `replaceOnce`, which THROWS if its anchor is missing or
// matches more than once, so an upstream change can never silently no-op.

function replaceOnce(src: string, find: string, repl: string, label: string, file: string): string {
  const first = src.indexOf(find)
  if (first < 0 || src.indexOf(find, first + find.length) >= 0) {
    throw new Error(
      `${label}: expected exactly one match for ${JSON.stringify(find.slice(0, 80))}… ` +
        `in ${file} — upstream changed; re-derive the seams`,
    )
  }
  return src.replace(find, repl)
}

// web-tree-sitter loads its core wasm (Emscripten createWasm) and grammar wasm
// (Language.load → loadWebAssemblyModule) by compiling bytes — request-time
// WebAssembly.compile is blocked in workerd facets. Pre-compiled
// WebAssembly.Modules ride in via the Worker Loader module map instead; the
// Nimbus runner parks them on `globalThis.__nimbusTreeSitterModules`
// (Map<wasm basename, WebAssembly.Module>). This transform patches the two
// byte→compile seams to consult that registry, keyed by the basename of the
// requested wasm path, and to FAIL LOUD when the registry is active but the
// requested wasm was not pre-registered. When the registry global is absent
// (a normal Bun run) both seams behave exactly as upstream.
// loadWebAssemblyModule and getDylinkMetadata natively accept a
// WebAssembly.Module (instantiate + customSections — no compile), so the
// grammar seam only swaps the resolved "bytes" for the registered Module.
export function nimbusPatchWebTreeSitter(source: string, file: string): string {
  const label = 'nimbus web-tree-sitter patch'

  // Seam 1 — grammar wasm: Language.load(path) node branch. Resolve the
  // pre-compiled Module from the registry instead of fs-reading bytes.
  source = replaceOnce(
    source,
    `      if (globalThis.process?.versions.node) {
        const fs2 = await import("fs/promises");
        bytes = fs2.readFile(input);
      } else {`,
    `      if (globalThis.__nimbusTreeSitterModules) {
        const __nimbusTsName = String(input).split(/[\\\\/]/).pop();
        const __nimbusTsModule = globalThis.__nimbusTreeSitterModules.get(__nimbusTsName);
        if (!__nimbusTsModule) {
          throw new Error("tree-sitter wasm not pre-registered: " + __nimbusTsName);
        }
        bytes = Promise.resolve(__nimbusTsModule);
      } else if (globalThis.process?.versions.node) {
        const fs2 = await import("fs/promises");
        bytes = fs2.readFile(input);
      } else {`,
    label,
    file,
  )

  // Seam 2 — core wasm: Emscripten createWasm. Instantiate the registered
  // pre-compiled Module (sync Instance of a precompiled Module is allowed in
  // workerd) instead of compiling bytes.
  source = replaceOnce(
    source,
    `      var info2 = getWasmImports();
      if (Module["instantiateWasm"]) {`,
    `      var info2 = getWasmImports();
      if (globalThis.__nimbusTreeSitterModules) {
        try {
          wasmBinaryFile ??= findWasmBinary();
          var __nimbusTsName = String(wasmBinaryFile).split(/[\\\\/]/).pop();
          var __nimbusTsModule = globalThis.__nimbusTreeSitterModules.get(__nimbusTsName);
          if (!__nimbusTsModule) {
            throw new Error("tree-sitter wasm not pre-registered: " + __nimbusTsName);
          }
          return receiveInstance(new WebAssembly.Instance(__nimbusTsModule, info2), __nimbusTsModule);
        } catch (__nimbusTsErr) {
          readyPromiseReject(__nimbusTsErr);
          throw __nimbusTsErr;
        }
      }
      if (Module["instantiateWasm"]) {`,
    label,
    file,
  )

  return source
}

// @opentui/core resolves its FFI render library through bun:ffi or node:ffi at
// module-init and throws "OpenTUI native FFI is not available" in workerd —
// neither exists, and the native .so it would dlopen is not Linux-executable in
// a facet. The Nimbus FFI backend (runtime/opentui-wasm-backend.ts) implements
// the exact { dlopen, ptr, suffix, toArrayBuffer } surface zig.ts drives over a
// WebAssembly.Instance of the staged wasm32-wasi reactor artifact. The facet
// runner constructs it and parks it on `globalThis.__nimbusOpenTUIBackend`
// BEFORE @opentui/core's module init runs; this transform reroutes the four
// init-time seams to that registry. When the global is absent (a normal Bun
// run) every seam behaves exactly as upstream.
//
//   1. loadBackend()  → the sync { dlopen, ptr, suffix, toArrayBuffer } backend.
//   2. loadBackend2() → the async bun-ffi-structs backend ({ ptr, toArrayBuffer }),
//      which otherwise THROWS at module top-level under node.
//   3. resolveNativePackage()/existsSync(targetLibPath) → skipped: there is no
//      native package to import and no .so on disk; the backend is the artifact.
//   4. OptimizedBuffer.ensureRawBufferViews → the four cell-array windows
//      (char/fg/bg/attributes) become live views over linear memory via
//      backend.liveView so they track Zig's writes, instead of detached
//      toArrayBuffer snapshots. The _rawBuffers=null re-fetch on resize keeps
//      them grow-safe (liveView re-derives over the current memory.buffer).
export function nimbusPatchOpenTUI(source: string, file: string): string {
  const label = 'nimbus @opentui/core patch'

  // Seam 1 — the sync FFI backend. Return the registry backend's surface when
  // present; otherwise fall through to upstream's bun:ffi/node:ffi/unsupported.
  source = replaceOnce(
    source,
    `function loadBackend() {
  if (isBun) {
    return createBunBackend(requireModule("bun:ffi"));
  }`,
    `function loadBackend() {
  if (globalThis.__nimbusOpenTUIBackend) {
    const __b = globalThis.__nimbusOpenTUIBackend;
    return {
      dlopen: __b.dlopen.bind(__b),
      ptr: __b.ptr.bind(__b),
      suffix: __b.suffix,
      toArrayBuffer: __b.toArrayBuffer.bind(__b),
    };
  }
  if (isBun) {
    return createBunBackend(requireModule("bun:ffi"));
  }`,
    label,
    file,
  )

  // Seam 2 — the async bun-ffi-structs backend (only ptr + toArrayBuffer).
  // Upstream awaits this at module top-level, so under node it THROWS at init;
  // the registry branch makes it resolve to the same backend's two members.
  source = replaceOnce(
    source,
    `async function loadBackend2() {
  if (typeof process !== "undefined" && "bun" in process.versions) {
    return createBunBackend2(await importModule("bun:ffi"));
  }`,
    `async function loadBackend2() {
  if (globalThis.__nimbusOpenTUIBackend) {
    const __b = globalThis.__nimbusOpenTUIBackend;
    return { ptr: __b.ptr.bind(__b), toArrayBuffer: __b.toArrayBuffer.bind(__b) };
  }
  if (typeof process !== "undefined" && "bun" in process.versions) {
    return createBunBackend2(await importModule("bun:ffi"));
  }`,
    label,
    file,
  )

  // Seam 3 — native-package path resolution. With the registry backend there is
  // no @opentui/core-<platform> package to import and no .so on disk to stat;
  // dlopen(path, …) ignores the path entirely (the artifact IS the library).
  source = replaceOnce(
    source,
    `var nativePackage = await resolveNativePackage();
var targetLibPath = nativePackage.default;
if (isBunfsPath(targetLibPath)) {
  targetLibPath = targetLibPath.replace("../", "");
}
if (!existsSync2(targetLibPath)) {
  throw new Error(\`opentui is not supported on the current platform: \${process.platform}-\${process.arch}\`);
}`,
    `var nativePackage = globalThis.__nimbusOpenTUIBackend ? { default: "opentui.wasm" } : await resolveNativePackage();
var targetLibPath = nativePackage.default;
if (isBunfsPath(targetLibPath)) {
  targetLibPath = targetLibPath.replace("../", "");
}
if (!globalThis.__nimbusOpenTUIBackend && !existsSync2(targetLibPath)) {
  throw new Error(\`opentui is not supported on the current platform: \${process.platform}-\${process.arch}\`);
}`,
    label,
    file,
  )

  // Seam 5 — pointer width for the FFI struct marshaler. @opentui/core derives
  // `pointerSize` from `process.arch` (8 on x64/arm64, 4 elsewhere), which sizes
  // and aligns every `pointer`/`cstring`/`char*` struct field. The Nimbus backend
  // runs the wasm32 reactor, whose pointers are 4 bytes — so a host arch of x64
  // would lay out every OUT-struct with 8-byte pointers and misread the 4-byte
  // structs the Zig core writes (e.g. SpanInfoStruct: chunkPtr/offset/len/index
  // shift by 4 bytes → len reads 0, the span-feed drain emits nothing). Force the
  // wasm32 pointer width whenever the registry backend is active; absent it
  // (a normal Bun run) the upstream arch detection stands.
  source = replaceOnce(
    source,
    `var pointerSize = process.arch === "x64" || process.arch === "arm64" ? 8 : 4;`,
    `var pointerSize = globalThis.__nimbusOpenTUIBackend ? 4 : (process.arch === "x64" || process.arch === "arm64" ? 8 : 4);`,
    label,
    file,
  )

  // Seam 6 — the native span-feed chunk read. NativeSpanFeed caches each chunk
  // ArrayBuffer in `chunkMap` at ChunkAdded time and slices frame spans out of it
  // later at drain time. On native FFI `toArrayBuffer(chunkPtr,…)` is a LIVE
  // window into the chunk's ring-buffer memory, so the cached entry reflects the
  // ANSI bytes the Zig core writes AFTER ChunkAdded. The Nimbus `toArrayBuffer`
  // is a detach-safe SNAPSHOT (correct for every read-then-decode caller), so an
  // early snapshot freezes the chunk as zeros and the drain emits blank frames.
  // When the registry backend is active, build the per-span slice as a LIVE view
  // over linear memory at `chunkPtr + span.offset` (re-derived over the current
  // memory.buffer, grow-safe) so the drain reads the bytes Zig actually wrote.
  // Absent the backend the read stays on upstream's cached toArrayBuffer slice.
  source = replaceOnce(
    source,
    `        if (span.offset + span.len > buffer.byteLength)
          continue;
        const slice = new Uint8Array(buffer, span.offset, span.len);`,
    `        if (!globalThis.__nimbusOpenTUIBackend && span.offset + span.len > buffer.byteLength)
          continue;
        const slice = globalThis.__nimbusOpenTUIBackend
          ? globalThis.__nimbusOpenTUIBackend.liveView(Uint8Array, span.chunkPtr, span.offset + span.len).subarray(span.offset, span.offset + span.len)
          : new Uint8Array(buffer, span.offset, span.len);`,
    label,
    file,
  )

  // Seam 4 — the four cell-array views. liveView returns a typed array backed by
  // the CURRENT memory.buffer (element count, not bytes); char/attributes are
  // u32 (size elements), fg/bg are u16 RGBA quads (size*4 elements).
  source = replaceOnce(
    source,
    `    this._rawBuffers = {
      char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
      fg: new Uint16Array(toArrayBuffer(fgPtr, 0, size * 4 * 2)),
      bg: new Uint16Array(toArrayBuffer(bgPtr, 0, size * 4 * 2)),
      attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4))
    };`,
    `    this._rawBuffers = globalThis.__nimbusOpenTUIBackend ? {
      char: globalThis.__nimbusOpenTUIBackend.liveView(Uint32Array, charPtr, size),
      fg: globalThis.__nimbusOpenTUIBackend.liveView(Uint16Array, fgPtr, size * 4),
      bg: globalThis.__nimbusOpenTUIBackend.liveView(Uint16Array, bgPtr, size * 4),
      attributes: globalThis.__nimbusOpenTUIBackend.liveView(Uint32Array, attributesPtr, size)
    } : {
      char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
      fg: new Uint16Array(toArrayBuffer(fgPtr, 0, size * 4 * 2)),
      bg: new Uint16Array(toArrayBuffer(bgPtr, 0, size * 4 * 2)),
      attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4))
    };`,
    label,
    file,
  )

  // Seam 7 — TUI output target + render clock for the Nimbus facet. The wasm32
  // reactor performs NO terminal syscalls of its own (build-wasm README): ANSI
  // frames surface ONLY through the NativeSpanFeed, and the renderer allocates
  // that feed iff `stdout !== process.stdout` (CliRenderer ctor:
  // `_usesProcessStdout`). opencode launches the TUI WITHOUT a custom stdout, so
  // on the facet it would default to process.stdout, skip the feed, and emit
  // nothing. When the registry backend is active and the caller didn't pass an
  // explicit stdout, default it to the Nimbus facet's TTY stdout
  // (`__nimbusOpenTUITtyStdout` — a distinct stream that forwards writes to the
  // facet's process.stdout RPC), so the renderer takes the span-feed path and
  // its onData streams ANSI to the terminal. Likewise default the render
  // `clock` to the Nimbus clock when supplied: workerd advances timers only
  // across real I/O yields, so the facet drives ticks through the attached-TTY
  // stdin round-trips rather than wall-clock setTimeout. Absent the backend (a
  // normal Bun run) the upstream `config.stdin ?? process.stdin` /
  // `config.stdout ?? process.stdout` defaults stand untouched.
  source = replaceOnce(
    source,
    `  const stdin = config.stdin ?? process.stdin;
  const stdout = config.stdout ?? process.stdout;`,
    `  if (globalThis.__nimbusOpenTUIBackend) {
    if (config.stdout == null && globalThis.__nimbusOpenTUITtyStdout) config.stdout = globalThis.__nimbusOpenTUITtyStdout;
    if (config.clock == null && globalThis.__nimbusOpenTUIClock) config.clock = globalThis.__nimbusOpenTUIClock;
  }
  const stdin = config.stdin ?? process.stdin;
  const stdout = config.stdout ?? process.stdout;`,
    label,
    file,
  )

  // Seam 8 — yoga-layout wasm. OpenTUI lays out every frame with yoga-layout
  // (an Emscripten wasm inlined as a base64 data URI in this chunk). Its loader
  // does request-time WebAssembly.instantiate(bytes), which workerd blocks in a
  // facet ("Wasm code generation disallowed by embedder") — so the TUI aborts
  // before its first frame. The pre-compiled yoga WebAssembly.Module rides in
  // via the Worker Loader module map (the sql.js / tree-sitter / opentui
  // pattern), parked on globalThis.__nimbusYogaModule by the runner; instantiate
  // THAT instead (instantiate-from-Module needs no codegen). Match the
  // {module,instance} shape the success callback reads. Absent the registry (a
  // normal Bun run) the upstream byte-instantiate path stands untouched.
  source = replaceOnce(
    source,
    `        return ya().then(function(f) {
          return WebAssembly.instantiate(f, d);
        }).then(function(f) {`,
    `        if (globalThis.__nimbusYogaModule) {
          return WebAssembly.instantiate(globalThis.__nimbusYogaModule, d).then(function(i) {
            return { instance: i, module: globalThis.__nimbusYogaModule };
          }).then(e, function(f) {
            v("failed to asynchronously prepare wasm: " + f);
            x(f);
          });
        }
        return ya().then(function(f) {
          return WebAssembly.instantiate(f, d);
        }).then(function(f) {`,
    label,
    file,
  )

  // Seam 9 — span-feed consumption acks through LIVE wasm memory. The Zig core
  // (NativeSpanFeed) tracks chunk refcounts in a state_buffer it hands the host
  // by pointer; the ONLY way a chunk is ever freed for reuse is the host writing
  // a decrement directly into that shared memory (there is no markChunkFree FFI
  // export). On native FFI `toArrayBuffer(statePtr,…)` is a LIVE window, so
  // `decrementRefcount` writing into `this.stateBuffer` IS the ack. The Nimbus
  // `toArrayBuffer` is a detach-safe SNAPSHOT (correct for read-then-decode
  // callers), so the upstream event-8 snapshot + write-back would decrement a
  // DEAD copy — Zig's real state_buffer only ever increments, no chunk is ever
  // reused, and `addChunkLocked` mallocs a fresh 64KiB chunk every frame until
  // the isolate OOMs (and `hasPinnedChunks()`/`idle()` wedge on stale counts).
  //
  // When the registry backend is active: event-8 stores {backend,ptr,len} (the
  // backend ref captured so the refcount path never depends on the mutable
  // registry global, which a teardown may clear mid-flight), and
  // `decrementRefcount`/`hasPinnedChunks` re-derive a live view over linear
  // memory PER ACCESS. Per-access re-derivation is mandatory (the codebase's
  // grow-safe discipline): a cached live view silently detaches on `memory.grow`
  // and its writes no-op, reintroducing the leak. Backend-mode is detected by the
  // stored object's own `__nimbusBackend` marker; absent it (a normal Bun run,
  // where stateBuffer is a Uint8Array) every branch behaves exactly as upstream.

  // Seam 9a — event 8 (StateBuffer): store {backend,ptr,len}, don't snapshot.
  source = replaceOnce(
    source,
    `        case 8 /* StateBuffer */: {
          const len = toNumber2(arg1);
          if (len > 0 && arg0) {
            const buffer = toArrayBuffer(arg0, 0, len);
            this.stateBuffer = new Uint8Array(buffer);
          }
          break;
        }`,
    `        case 8 /* StateBuffer */: {
          const len = toNumber2(arg1);
          if (len > 0 && arg0) {
            this.stateBuffer = globalThis.__nimbusOpenTUIBackend
              ? { __nimbusBackend: globalThis.__nimbusOpenTUIBackend, __nimbusStatePtr: arg0, __nimbusStateLen: len }
              : new Uint8Array(toArrayBuffer(arg0, 0, len));
          }
          break;
        }`,
    label,
    file,
  )

  // Seam 9b — hasPinnedChunks: read refcounts through a per-access live view.
  source = replaceOnce(
    source,
    `  hasPinnedChunks() {
    if (!this.stateBuffer)
      return false;
    for (const refcount of this.stateBuffer) {
      if (refcount > 0)
        return true;
    }
    return false;
  }`,
    `  hasPinnedChunks() {
    if (!this.stateBuffer)
      return false;
    const stateView = this.stateBuffer.__nimbusBackend
      ? this.stateBuffer.__nimbusBackend.liveView(Uint8Array, this.stateBuffer.__nimbusStatePtr, this.stateBuffer.__nimbusStateLen)
      : this.stateBuffer;
    for (const refcount of stateView) {
      if (refcount > 0)
        return true;
    }
    return false;
  }`,
    label,
    file,
  )

  // Seam 9c — decrementRefcount: write the ack into a per-access live view so it
  // lands in Zig's real state_buffer (the chunk becomes reusable).
  source = replaceOnce(
    source,
    `  decrementRefcount(chunkIndex) {
    if (this.stateBuffer && chunkIndex < this.stateBuffer.length) {
      const prev = this.stateBuffer[chunkIndex];
      this.stateBuffer[chunkIndex] = prev > 0 ? prev - 1 : 0;
    }
  }`,
    `  decrementRefcount(chunkIndex) {
    if (!this.stateBuffer)
      return;
    const stateView = this.stateBuffer.__nimbusBackend
      ? this.stateBuffer.__nimbusBackend.liveView(Uint8Array, this.stateBuffer.__nimbusStatePtr, this.stateBuffer.__nimbusStateLen)
      : this.stateBuffer;
    if (chunkIndex < stateView.length) {
      const prev = stateView[chunkIndex];
      stateView[chunkIndex] = prev > 0 ? prev - 1 : 0;
    }
  }`,
    label,
    file,
  )

  // Seam 9d — event 2 (ChunkAdded): skip the chunkMap ArrayBuffer snapshot when
  // the backend is active. In facet mode the drain reads chunk bytes live (seam
  // 6), so the snapshot is pure dead weight (a 64KiB copy per chunk). chunkSizes
  // is still recorded for the non-backend fallback shape.
  source = replaceOnce(
    source,
    `        case 2 /* ChunkAdded */: {
          const chunkLen = toNumber2(arg1);
          if (chunkLen > 0 && arg0) {
            if (!this.chunkMap.has(arg0)) {
              const buffer = toArrayBuffer(arg0, 0, chunkLen);
              this.chunkMap.set(arg0, buffer);
            }
            this.chunkSizes.set(arg0, chunkLen);
          }
          break;
        }`,
    `        case 2 /* ChunkAdded */: {
          const chunkLen = toNumber2(arg1);
          if (chunkLen > 0 && arg0) {
            if (!globalThis.__nimbusOpenTUIBackend && !this.chunkMap.has(arg0)) {
              const buffer = toArrayBuffer(arg0, 0, chunkLen);
              this.chunkMap.set(arg0, buffer);
            }
            this.chunkSizes.set(arg0, chunkLen);
          }
          break;
        }`,
    label,
    file,
  )

  // Seam 9e — drainOnce fallback: skip the same chunkMap snapshot at drain time
  // when the backend is active (seam 9d moves the miss here otherwise). The live
  // read (seam 6) needs neither `buffer` nor the byteLength bounds check.
  source = replaceOnce(
    source,
    `        let buffer = this.chunkMap.get(span.chunkPtr);
        if (!buffer) {
          const size = this.chunkSizes.get(span.chunkPtr);
          if (!size)
            continue;
          buffer = toArrayBuffer(span.chunkPtr, 0, size);
          this.chunkMap.set(span.chunkPtr, buffer);
        }`,
    `        let buffer = this.chunkMap.get(span.chunkPtr);
        if (!buffer && !globalThis.__nimbusOpenTUIBackend) {
          const size = this.chunkSizes.get(span.chunkPtr);
          if (!size)
            continue;
          buffer = toArrayBuffer(span.chunkPtr, 0, size);
          this.chunkMap.set(span.chunkPtr, buffer);
        }`,
    label,
    file,
  )

  return source
}

/**
 * Marker that identifies the single @opentui/core chunk carrying the FFI
 * backend / buffer code. The chunk filename has a version-dependent content
 * hash, so the build's onLoad hook matches by this content marker, not by name.
 */
export const OPENTUI_FFI_CHUNK_MARKER = 'OpenTUI native FFI is not available'

// @opentui/core's parser.worker.js (a Bun-prebuilt `@bun` file) opens with a
// worker-scope prelude `var self = globalThis;` and drives its message channel
// through that local `self` (self.onmessage / self.postMessage). On a real
// platform `self` is the DedicatedWorkerGlobalScope; on Nimbus the worker runs
// in the client's facet isolate, so it must use the per-worker context the
// Worker polyfill claims — NOT the shared globalThis (which would collide with
// the opencode API-server worker). The build-time `define: { self }` can't
// reach this ref because the `var self` local shadows the global identifier, so
// patch the initializer to claim the context when the polyfill is active. Inert
// under a normal Bun run (no __nimbusWorkerClaim → falls back to globalThis).
export function nimbusPatchParserWorker(source: string, file: string): string {
  return replaceOnce(
    source,
    'var self = globalThis;',
    'var self = globalThis.__nimbusWorkerClaim ? globalThis.__nimbusWorkerClaim() : globalThis;',
    'nimbus parser.worker self-scope patch',
    file,
  )
}

// opencode's TUI API server (src/cli/cmd/tui/worker.ts) drives its message
// channel through the BARE Web-Worker scope refs `onmessage`/`postMessage`
// (src/util/rpc.ts listen/emit — in a real Worker these are the
// DedicatedWorkerGlobalScope's members). On Nimbus the client and both workers
// share one facet isolate, and the split build shares chunks between index.js
// and worker.js — so the pre-split approach (a build-level `define` rebinding
// those identifiers across the whole worker bundle) would clobber the client's
// copy of the shared code. Instead the two seams take an EXPLICIT scope
// parameter: the worker entry claims its per-worker context and threads it
// through (see nimbusPatchTuiWorkerEntry). When no scope is passed — a normal
// Bun run, where the module top-level IS the worker scope — the seams write to
// globalThis, which is exactly what the bare refs resolved to upstream.
export function nimbusPatchRpcWorkerScope(source: string, file: string): string {
  const label = 'nimbus rpc worker-scope patch'
  source = replaceOnce(
    source,
    `export function listen(rpc: Definition) {
  onmessage = async (evt) => {`,
    `export function listen(rpc: Definition, scope?: { onmessage: any; postMessage: (data: string) => void }) {
  const target: any = scope ?? globalThis
  target.onmessage = async (evt: MessageEvent) => {`,
    label,
    file,
  )
  source = replaceOnce(
    source,
    `      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))`,
    `      target.postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))`,
    label,
    file,
  )
  source = replaceOnce(
    source,
    `export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))`,
    `export function emit(event: string, data: unknown, scope?: { postMessage: (data: string) => void }) {
  ;((scope ?? globalThis) as any).postMessage(JSON.stringify({ type: "rpc.event", event, data }))`,
    label,
    file,
  )
  return source
}

// The worker entry claims the per-worker messaging context the in-isolate
// Worker polyfill parks on `globalThis.__nimbusWorkerClaim` during this
// module's import. The claim is read at MODULE-BODY START — before the entry's
// top-level awaits — so a parser worker constructed while those awaits are
// pending cannot overwrite the claim first. Undefined under a normal Bun run
// (real Worker scope), which makes the Rpc seams fall back to globalThis.
export function nimbusPatchTuiWorkerEntry(source: string, file: string): string {
  const label = 'nimbus tui worker-entry scope patch'
  source = replaceOnce(
    source,
    `ensureProcessMetadata("worker")`,
    `ensureProcessMetadata("worker")

const __nimbusWorkerScope = (globalThis as any).__nimbusWorkerClaim
  ? (globalThis as any).__nimbusWorkerClaim()
  : undefined`,
    label,
    file,
  )
  source = replaceOnce(
    source,
    `  Rpc.emit("global.event", event)`,
    `  Rpc.emit("global.event", event, __nimbusWorkerScope)`,
    label,
    file,
  )
  source = replaceOnce(
    source,
    `Rpc.listen(rpc)`,
    `Rpc.listen(rpc, __nimbusWorkerScope)`,
    label,
    file,
  )
  return source
}
