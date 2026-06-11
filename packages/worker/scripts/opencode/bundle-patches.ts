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

  return source
}

/**
 * Marker that identifies the single @opentui/core chunk carrying the FFI
 * backend / buffer code. The chunk filename has a version-dependent content
 * hash, so the build's onLoad hook matches by this content marker, not by name.
 */
export const OPENTUI_FFI_CHUNK_MARKER = 'OpenTUI native FFI is not available'
