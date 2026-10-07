/**
 * specs.mjs — the napi-rs bindings Nimbus builds for single-threaded
 * wasm32-wasip1, one entry each, all built by build.mjs.
 *
 * Every one of them publishes only platform `.node` shards plus a
 * wasm32-wasip1-threads build (shared memory, wasi thread-spawn), which a
 * Worker isolate cannot run. Each spec pins what its build needs:
 *
 *   source     upstream tag archive, by SHA-256; `dir` is its top directory
 *   toolchain  the rustc upstream's rust-toolchain.toml pins
 *   build      how the cdylib is produced:
 *                workspace  cargo -p <package> inside upstream's own workspace
 *                wrapper    our cdylib in scripts/napi-wasm/<wrapper>/ linking
 *                           upstream's crate (a binding whose async fns need
 *                           an event-loop-driven runtime)
 *              lockfile     'upstream' (the archive's Cargo.lock, --locked) or
 *                           a committed file under scripts/napi-wasm/
 *   rustflags  as upstream builds its wasm target, minus the threads
 *   seams      exact-match edits to upstream files, each with its reason; the
 *              build fails unless each `from` occurs exactly once
 *   output     the cdylib's file name under target/wasm32-wasip1/release/
 *   npm        the package whose JavaScript loads the binding (owner, at the
 *              one version the binding is built from) and the package names
 *              it requires the binding by
 */

export const SPECS = {
  rolldown: {
    name: 'rolldown',
    version: '1.2.11',
    source: {
      url: 'https://github.com/rolldown/rolldown/archive/refs/tags/v1.2.11.tar.gz',
      sha256: 'fb6def184441b75eaf4f5ac24f99d46a29686f61e29af1bc137705f4da018403',
      dir: 'rolldown-1.2.11',
    },
    toolchain: '1.98.1',
    build: { mode: 'wrapper', wrapper: 'rolldown', lockfile: 'rolldown/Cargo.lock', checkAgainstUpstreamLock: true },
    rustflags: [
      // rolldown_plugin_utils enables tokio's `fs` feature, which tokio only
      // compiles for wasm under tokio_unstable; upstream sets the same cfg for
      // its wasm32-wasip1-threads build (.cargo/config.toml).
      '--cfg', 'tokio_unstable',
      '-C', 'target-feature=+simd128',
    ],
    seams: [],
    output: 'nimbus_rolldown_binding.wasm',
    npm: { owner: 'rolldown', requiredAs: ['@rolldown/binding-wasm32-wasi'] },
  },

  // Astro 7's Markdown engine (@astrojs/markdown-satteri). Its binding has
  // no async fns and no tokio: upstream's own crate, workspace and lockfile.
  satteri: {
    name: 'satteri',
    version: '0.10.5',
    source: {
      url: 'https://github.com/bruits/satteri/archive/refs/tags/satteri-v0.10.5.tar.gz',
      sha256: '2193132300046ebacdc791d757986741e86abbb6306068dff39d2e4fada68db3',
      dir: 'satteri-satteri-v0.10.5',
    },
    toolchain: '1.95.0',
    build: { mode: 'workspace', package: 'satteri-napi', lockfile: 'upstream' },
    rustflags: ['-C', 'target-feature=+simd128'],
    seams: [],
    output: 'satteri_napi.wasm',
    npm: { owner: 'satteri', requiredAs: ['@bruits/satteri-wasm32-wasi'] },
  },

  // Astro 7's .astro compiler (@astrojs/compiler-rs -> compiler-binding).
  // napi 3.8.3's tokio_rt builds a runtime at module registration; on wasm
  // without tokio_unstable that is a current-thread runtime, and the binding
  // only uses napi AsyncTask (emnapi's JS async-work plugin), so it builds in
  // upstream's workspace. Upstream commits no Cargo.lock: the committed
  // astro-compiler/Cargo.lock is this build's pin (generated at v0.5.1).
  'astro-compiler': {
    name: 'astro-compiler',
    version: '0.5.1',
    source: {
      url: 'https://github.com/withastro/compiler-rs/archive/refs/tags/v0.5.1.tar.gz',
      sha256: 'c9e546b0fb1bd4e61f4559bbed8f15368e4488fb73c2d828936a1cebf0b20592',
      dir: 'compiler-rs-0.5.1',
    },
    toolchain: '1.96.1',
    build: { mode: 'workspace', package: 'astro_napi', lockfile: 'astro-compiler/Cargo.lock' },
    rustflags: ['-C', 'target-feature=+simd128'],
    seams: [
      {
        file: 'Cargo.toml',
        from: 'napi-build = "=2.3.1"',
        to: 'napi-build = "=2.5.0"',
        reason: 'napi-build 2.3.1 only knows wasm32-wasip1-threads: it links the threaded emnapi archive '
          + '(emnapi-basic-mt, absent for wasm32-wasip1) and exports its thread-pool symbols. 2.5.0 links the '
          + 'non-threaded emnapi-basic-napi-rs for wasm32-wasip1 and is the version the rolldown build uses. '
          + 'napi-build only writes the link line; napi and napi-derive stay at upstream\'s pins.',
      },
    ],
    output: 'astro_napi.wasm',
    npm: { owner: '@astrojs/compiler-binding', requiredAs: ['@astrojs/compiler-binding-wasm32-wasi'] },
  },
};

/** npm tarballs the loader bundles and the build links, by lockfile integrity. */
export const EMNAPI = {
  // Integrity as recorded in rolldown v1.2.11's pnpm-lock.yaml (the rolldown
  // source archive is the record); every binding links this one emnapi.
  lockfileFrom: 'rolldown',
  packages: [
    { name: 'emnapi', version: '2.0.0-alpha.5' },
    { name: '@emnapi/core', version: '2.0.0-alpha.5' },
    { name: '@emnapi/runtime', version: '2.0.0-alpha.5' },
    { name: '@emnapi/wasi-threads', version: '2.1.0' },
  ],
  // emnapi views the binding's heap with subarray at a heap pointer. In a
  // Worker an ArrayBuffer is capped at 128 MiB and only a WebAssembly.Memory
  // grows past it; on one that has, V8's subarray refuses a begin past the
  // cap ("Invalid array buffer length": CalculateByteLength against the
  // embedder's maximum, src/builtins/typed-array-subarray.tq), where the
  // constructor and fill take any offset within the buffer. rolldown
  // pre-bundling React with lucide-react reaches 152 MiB. Each seam is an
  // exact edit, applied only if its text occurs `count` times (default 1).
  seams: [
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'return isShared || isResizable ? heap.slice(start, end) : heap.subarray(start, end);',
      to: 'return isShared || isResizable ? heap.slice(start, end) : new heap.constructor(heap.buffer, heap.byteOffset + start * heap.BYTES_PER_ELEMENT, Math.max(0, end - start));',
      reason: 'strings read from the heap (UTF8ToString, UTF16ToString)',
    },
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'view.set(wasmMemoryU8.subarray(pointer, pointer + len));',
      to: 'view.set(new Uint8Array(wasmMemoryU8.buffer, wasmMemoryU8.byteOffset + pointer, len));',
      count: 2,
      reason: 'syncing a typed array or a DataView from the heap',
    },
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'new Uint8Array(sab).set(emnapiExternalMemory.getHEAPU8().subarray(external_data, external_data + meta.byte_length));',
      to: 'new Uint8Array(sab).set(new Uint8Array(emnapiExternalMemory.getHEAPU8().buffer, emnapiExternalMemory.getHEAPU8().byteOffset + external_data, meta.byte_length));',
      reason: 'an external SharedArrayBuffer copied from the heap',
    },
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'u8arr.set(emnapiExternalMemory.getHEAPU8().subarray(external_data, external_data + byte_length));',
      to: 'u8arr.set(new Uint8Array(emnapiExternalMemory.getHEAPU8().buffer, emnapiExternalMemory.getHEAPU8().byteOffset + external_data, byte_length));',
      count: 2,
      reason: 'an external ArrayBuffer copied from the heap',
    },
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'emnapiExternalMemory.getHEAPU8().subarray(pointer, pointer + size).fill(0);',
      to: 'emnapiExternalMemory.getHEAPU8().fill(0, pointer, pointer + size);',
      reason: 'a zeroed buffer allocated on the heap',
    },
    {
      file: '@emnapi/core/dist/emnapi-core.js',
      from: 'buffer.set(emnapiExternalMemory.getHEAPU8().subarray(data, data + length));',
      to: 'buffer.set(new Uint8Array(emnapiExternalMemory.getHEAPU8().buffer, emnapiExternalMemory.getHEAPU8().byteOffset + data, length));',
      reason: 'a Buffer copied from the heap',
    },
    {
      file: '@emnapi/core/dist/plugins/async-work.js',
      from: 'new Uint8Array(emnapiAWMT.ensureBufferFor(aw + sizeofAW)).subarray(aw, aw + sizeofAW).fill(0);',
      to: 'new Uint8Array(emnapiAWMT.ensureBufferFor(aw + sizeofAW)).fill(0, aw, aw + sizeofAW);',
      reason: 'an async work struct zeroed on the heap',
    },
    {
      file: '@emnapi/core/dist/plugins/threadsafe-function.js',
      from: 'new Uint8Array(emnapiTSFN.ensureBufferFor(tsfn + sizeofTSFN)).subarray(tsfn, tsfn + sizeofTSFN).fill(0);',
      to: 'new Uint8Array(emnapiTSFN.ensureBufferFor(tsfn + sizeofTSFN)).fill(0, tsfn, tsfn + sizeofTSFN);',
      reason: 'a threadsafe function struct zeroed on the heap',
    },
  ],
};
