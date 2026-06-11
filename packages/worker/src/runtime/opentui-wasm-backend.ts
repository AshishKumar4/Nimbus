/**
 * opentui-wasm-backend.ts — the Nimbus WebAssembly FFI backend for @opentui/core.
 *
 * OpenTUI's `platform/ffi.ts` selects an FFI backend exposing exactly five
 * members — `{ dlopen, ptr, suffix, toArrayBuffer }` plus
 * `Library.createCallback` — and `zig.ts` drives the entire 279-symbol render
 * surface through them. This module IS that backend, implemented over a single
 * `WebAssembly.Instance` of the staged wasm32-wasi reactor artifact
 * (`public/_assets/opentui/<version>/opentui.wasm`, Stage A) running under the
 * real Nimbus WASI host (`wasi-instance.ts`).
 *
 * The whole copy-shim surface (~105 symbols: UTF-8 strings, packed structs,
 * RGBA `Uint16Array`s, out-buffers/out-structs) is handled by ONE generic arena
 * protocol, not per-symbol code: a `ptr`-typed argument accepts a numeric
 * offset/handle (passed through), `null` (→ 0), or an `ArrayBufferView`/
 * `ArrayBuffer` (copied into a scratch arena via the module's `nimbus_alloc`,
 * passed as a u32 offset, copied back if the view is writable, then freed).
 *
 * `toArrayBuffer` returns a LIVE window over linear memory, and every accessor
 * re-derives from the CURRENT `memory.buffer` so a `memory.grow` (which detaches
 * the old `ArrayBuffer`) can never strand a cached view — mirroring upstream's
 * post-resize re-fetch discipline (buffer.ts `ensureRawBufferViews`).
 *
 * Stage B: this module is standalone and unwired. Nothing in the running worker
 * imports it; Stage C patches it into the @opentui/core bundle.
 */

// ── FFI type tags (the @opentui/core `FFIType` surface zig.ts emits) ─────────
//
// zig.ts passes `{ args: FFIType[]; returns: FFIType }` per symbol. These are
// the only tags that appear across the 279-symbol table (verified against the
// FFI symbol notes): the marshaling class of each tag is fixed here.
export const OPENTUI_FFI_TYPES = [
  'void',
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'i8',
  'i16',
  'i32',
  'i64',
  'f32',
  'f64',
  'usize',
  'ptr',
  'pointer',
  'cstring',
] as const;

export type OpenTUIFfiType = (typeof OPENTUI_FFI_TYPES)[number];

const FFI_TYPE_SET: ReadonlySet<string> = new Set(OPENTUI_FFI_TYPES);

/** A single symbol's signature, exactly the shape zig.ts builds. */
export interface OpenTUIFfiFunction {
  readonly args?: readonly OpenTUIFfiType[];
  readonly returns?: OpenTUIFfiType;
}

export type OpenTUIFfiSymbols = Readonly<Record<string, OpenTUIFfiFunction>>;

/**
 * A pointer/handle at the FFI boundary. On wasm32 every pointer is a u32 byte
 * offset into linear memory; we keep `bigint` in the union only because a
 * `usize`/`u64` return can surface as BigInt and callers feed such values back
 * as `ptr` args (zig.ts does `typeof x === 'bigint' ? Number(x) : x`).
 */
export type OpenTUIPointer = number | bigint;

/**
 * What a `ptr`-typed argument may be: a numeric offset/handle, a BigInt
 * (64-bit handle), a copy-in/out view, a raw ArrayBuffer, or null.
 */
export type OpenTUIPointerArg =
  | number
  | bigint
  | ArrayBufferView
  | ArrayBuffer
  | null
  | undefined;

/** The callable surface zig.ts invokes as `lib.symbols.<name>(...)`. */
export type OpenTUISymbolFn = (...args: unknown[]) => unknown;

/** Result of `createCallback` — the `.ptr` token is what zig.ts hands to Zig. */
export interface OpenTUIFfiCallbackInstance {
  readonly ptr: OpenTUIPointer | null;
  readonly threadsafe: boolean;
  close(): void;
}

/** The `Library` shape zig.ts spreads and reads `.symbols` / `.createCallback` from. */
export interface OpenTUIFfiLibrary {
  readonly symbols: Record<string, OpenTUISymbolFn>;
  createCallback(
    callback: (...args: unknown[]) => unknown,
    definition: OpenTUIFfiFunction,
  ): OpenTUIFfiCallbackInstance;
  close(): void;
}

// ── WASI host seam (reuse wasi-instance.ts; never fork a second WASI impl) ────
//
// The backend owns wasm instantiation + the import object but does NOT embed a
// WASI implementation. It is handed the two helpers the `wasi-instance.ts`
// preamble exports — `makeImports` (the import table + stdout/stderr/clock/env
// seams) and `initFS` (the in-memory VFS). In the facet (Stage D) these are the
// preamble globals `__wasiMakeImports` / `__wasiInitFS`; in tests they come from
// evaluating `WASI_INSTANCE_PREAMBLE_SRC`. Same source of truth either way.

export interface WasiMakeImportsResult {
  readonly wasiImport: WebAssembly.ModuleImports;
  getStdout(): string;
  getStderr(): string;
}

export interface WasiHost {
  /** `__wasiMakeImports` — builds the `wasi_snapshot_preview1` import table. */
  makeImports(opts: {
    argv?: string[];
    env?: Record<string, string>;
    getMemory: () => WebAssembly.Memory | null;
    stdoutWrite?: (s: string) => void;
    stderrWrite?: (s: string) => void;
  }): WasiMakeImportsResult;
  /** `__wasiInitFS` — installs the per-instance virtual filesystem. */
  initFS(opts: {
    root: string;
    preopens: Array<{ wasiPath: string; vfsPath: string }>;
    files: Record<string, string>;
    dirs: string[];
  }): void;
}

export interface OpenTUIWasmBackendOptions {
  /** The compiled artifact (Stage A: the staged wasm32-wasi reactor). */
  readonly module: WebAssembly.Module;
  /** The Nimbus WASI host helpers (reuse, don't fork). */
  readonly wasi: WasiHost;
  /** argv[0] for the reactor; defaults to `'opentui'`. */
  readonly argv?: string[];
  /** Environment the Zig core reads (e.g. `TERM`, color caps). */
  readonly env?: Record<string, string>;
  /**
   * stdout sink — Stage D points this at the facet's process.stdout. When
   * unset, output is buffered and readable via `getStdout()`.
   */
  readonly stdoutWrite?: (s: string) => void;
  readonly stderrWrite?: (s: string) => void;
}

// ── The wasm exports the backend relies on directly ──────────────────────────
//
// All FFI symbols are reached generically by name; only these few are called by
// the backend machinery itself (instantiation + the arena allocator).
interface OpenTUIWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  _initialize(): void;
  nimbus_alloc(size: number): number;
  nimbus_free(ptr: number, size: number): void;
}

/** A registered callback: the JS fn the imports dispatch to + its handle. */
interface OpenTUICallbackEntry {
  readonly fn: (...args: unknown[]) => unknown;
  readonly instance: OpenTUIFfiCallbackInstance;
}

const ARENA_ALIGN = 16;

/**
 * The Nimbus OpenTUI wasm FFI backend. Constructed from a compiled module + the
 * WASI host; instantiates once and exposes the @opentui/core backend surface.
 */
export class OpenTUIWasmBackend {
  /** `suffix` is exported for API-shape parity; OpenTUI never resolves a path from it. */
  readonly suffix = 'wasm';

  readonly #instance: WebAssembly.Instance;
  readonly #exports: OpenTUIWasmExports;
  readonly #wasiResult: WasiMakeImportsResult;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();

  /** Live callback registry: token → registered instance, dispatched by `opentui` imports. */
  readonly #callbacks = new Map<number, OpenTUICallbackEntry>();
  #nextToken = 1; // tokens must be non-zero (0 === null fn pointer)

  /**
   * Cached `Uint8Array` over `memory.buffer`, invalidated whenever a grow may
   * have detached it. `#u8()` always returns a view backed by the live buffer.
   */
  #cachedU8: Uint8Array | null = null;
  #cachedBuffer: ArrayBuffer | null = null;

  private constructor(opts: OpenTUIWasmBackendOptions) {
    opts.wasi.initFS({
      root: 'opentui-wasi-root',
      preopens: [{ wasiPath: '/', vfsPath: 'opentui-wasi-root' }],
      files: {},
      dirs: [],
    });

    // getMemory is late-bound: the WASI host re-reads `.buffer` on every call,
    // so a grow is transparent to it. We resolve the export after instantiation.
    let memory: WebAssembly.Memory | null = null;
    this.#wasiResult = opts.wasi.makeImports({
      argv: opts.argv ?? ['opentui'],
      env: opts.env ?? {},
      getMemory: () => memory,
      stdoutWrite: opts.stdoutWrite,
      stderrWrite: opts.stderrWrite,
    });

    this.#instance = new WebAssembly.Instance(opts.module, {
      wasi_snapshot_preview1: this.#wasiResult.wasiImport,
      opentui: this.#opentuiImports(),
    });
    this.#exports = this.#instance.exports as OpenTUIWasmExports;
    memory = this.#exports.memory;
    this.#exports._initialize();
  }

  static create(opts: OpenTUIWasmBackendOptions): OpenTUIWasmBackend {
    return new OpenTUIWasmBackend(opts);
  }

  /** Buffered stdout if no `stdoutWrite` sink was provided. */
  getStdout(): string {
    return this.#wasiResult.getStdout();
  }
  getStderr(): string {
    return this.#wasiResult.getStderr();
  }

  /** The live `WebAssembly.Memory` (Stage C/D may need it for diagnostics). */
  get memory(): WebAssembly.Memory {
    return this.#exports.memory;
  }

  // ── memory-grow-safe linear-memory access ──────────────────────────────────
  // Every view is re-derived from the CURRENT `memory.buffer`. `memory.grow`
  // allocates a fresh backing ArrayBuffer and detaches the old one, so a cached
  // view would throw on use; we compare buffer identity and rebuild on change.
  #u8(): Uint8Array {
    const buffer = this.#exports.memory.buffer;
    if (this.#cachedBuffer !== buffer || this.#cachedU8 === null) {
      this.#cachedU8 = new Uint8Array(buffer);
      this.#cachedBuffer = buffer;
    }
    return this.#cachedU8;
  }

  // ── The `opentui` import module: token → fn dispatch ────────────────────────
  //
  // Zig stores the host-minted token as an opaque "fn pointer" and calls back
  // through these three externs with `(token, ...)`. We look the token up and
  // invoke the registered JS callback, decoding pointer/length pairs against
  // live memory. Each decode happens after Zig has written, so it reads the
  // current buffer (grow-safe by construction).
  #opentuiImports(): WebAssembly.ModuleImports {
    const dispatch = (token: number): ((...a: unknown[]) => unknown) | undefined =>
      this.#callbacks.get(token >>> 0)?.fn;
    return {
      logCallback: (token: number, level: number, msgPtr: number, msgLen: number): void => {
        dispatch(token)?.(level, msgPtr >>> 0, msgLen >>> 0);
      },
      eventSinkCallback: (
        token: number,
        namePtr: number,
        nameLen: number,
        dataPtr: number,
        dataLen: number,
      ): void => {
        dispatch(token)?.(namePtr >>> 0, nameLen >>> 0, dataPtr >>> 0, dataLen >>> 0);
      },
      streamCallback: (
        token: number,
        streamPtr: number,
        eventId: number,
        arg0: number,
        arg1: bigint,
      ): void => {
        dispatch(token)?.(streamPtr >>> 0, eventId >>> 0, arg0 >>> 0, arg1);
      },
    };
  }

  // ── ptr(view): copy a view/buffer into the arena, return its u32 offset ─────
  //
  // The persistent-pointer path used when zig.ts pre-materializes an address
  // (rgbaPtr → ptr(rgba.buffer), ptr(outCountBuf), ptr(reserveBuffer), …). The
  // caller owns the lifetime; we expose `free` so Stage C can release it, but
  // OpenTUI's call sites create these per-call and let them be reclaimed when
  // the renderer/buffer is torn down, matching native FFI lifetime.
  ptr(value: ArrayBuffer | ArrayBufferView): OpenTUIPointer {
    const { bytes, byteOffset, byteLength } = viewBytes(value);
    const offset = this.#alloc(byteLength);
    this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
    return offset;
  }

  /** Release a pointer obtained from `ptr()` (size must match the original view). */
  free(pointer: OpenTUIPointer, byteLength: number): void {
    this.#exports.nimbus_free(toOffset(pointer), byteLength);
  }

  // ── toArrayBuffer(ptr, offset, length): a snapshot copy of linear memory ────
  //
  // Returns a fresh ArrayBuffer holding `[ptr+offset, +length)`. Every zig.ts
  // caller reads-then-decodes synchronously (log/event-name/-data, highlight and
  // encoded-char unpacks, span-feed chunks) — a copy is the correct, detach-safe
  // result there; one site even adds its own `.slice(0)` to retain past scope.
  //
  // A stock JS ArrayBuffer cannot be a live sub-window of `memory.buffer`, so the
  // five LIVE cell-array views (`bufferGet{Char,Fg,Bg,Attributes}Ptr`,
  // `textBufferGetLineHighlightsPtr`) use `liveView()` instead — the one place
  // that genuinely needs a window that tracks Zig's writes.
  toArrayBuffer(
    pointer: OpenTUIPointer,
    offset: number | undefined,
    length: number,
  ): ArrayBuffer {
    const base = toOffset(pointer) + (offset ?? 0);
    return this.#exports.memory.buffer.slice(base, base + length);
  }

  /**
   * A LIVE typed-array window over linear memory at `pointer`, tracking Zig's
   * writes — the path the five cell-array symbols need. Always constructed over
   * the CURRENT `memory.buffer`, so a `memory.grow` (which detaches the prior
   * buffer) can never strand it: callers re-call `liveView` after any operation
   * that may grow memory, exactly as buffer.ts re-fetches after `bufferResize`.
   *
   * @param ctor   the element view (Uint32Array for char/attributes, Uint16Array
   *               for fg/bg RGBA quads).
   * @param length element count (NOT bytes).
   */
  liveView<T extends Uint8Array | Uint16Array | Uint32Array>(
    ctor: { new (buffer: ArrayBufferLike, byteOffset: number, length: number): T },
    pointer: OpenTUIPointer,
    length: number,
  ): T {
    return new ctor(this.#exports.memory.buffer, toOffset(pointer), length);
  }

  // ── dlopen(path, symbols): wire every requested symbol to its export ────────
  dlopen(_path: string, symbols: OpenTUIFfiSymbols): OpenTUIFfiLibrary {
    const exports = this.#instance.exports as Record<string, unknown>;
    const bound: Record<string, OpenTUISymbolFn> = Object.create(null);

    for (const name of Object.keys(symbols)) {
      const sig = symbols[name];
      const raw = exports[name];
      if (typeof raw !== 'function') {
        throw new Error(`opentui-wasm-backend: export '${name}' is missing or not callable`);
      }
      bound[name] = this.#bindSymbol(name, raw as (...a: unknown[]) => unknown, sig);
    }

    return {
      symbols: bound,
      createCallback: (callback, definition) => this.#createCallback(callback, definition),
      close: () => this.#closeAllCallbacks(),
    };
  }

  /**
   * Wrap one export with arg/return marshaling derived from its signature.
   * Per-arg rule (the single generic arena protocol):
   *   - `ptr`/`pointer`/`cstring`: number/bigint → passed through (offset/handle);
   *     null/undefined → 0; ArrayBufferView/ArrayBuffer → copied into a scratch
   *     arena, passed as a u32 offset, copied back into the source view if it is
   *     writable (out-params), then freed after the call.
   *   - `u64`/`i64`/`usize` (when 64-bit on the wasm boundary is BigInt): a
   *     numeric arg is widened to BigInt so V8 routes it to an i64 param.
   *   - everything else: numeric, passed as-is.
   * Return rule: `bool` → boolean is left numeric (callers compare truthiness);
   * `ptr`/`usize`/`u64` returns are surfaced numerically (offset/handle), which
   * is exactly what zig.ts feeds back as the next call's `ptr` arg.
   */
  #bindSymbol(
    name: string,
    fn: (...a: unknown[]) => unknown,
    sig: OpenTUIFfiFunction,
  ): OpenTUISymbolFn {
    const argTypes = sig.args ?? [];
    for (const t of argTypes) {
      if (!FFI_TYPE_SET.has(t)) {
        throw new Error(`opentui-wasm-backend: symbol '${name}' has unknown arg type '${t}'`);
      }
    }
    const returns = sig.returns ?? 'void';
    if (!FFI_TYPE_SET.has(returns)) {
      throw new Error(`opentui-wasm-backend: symbol '${name}' has unknown return type '${returns}'`);
    }

    return (...args: unknown[]): unknown => {
      const scratch: Array<{ offset: number; size: number; view: ArrayBufferView | null }> = [];
      const marshaled: unknown[] = new Array(argTypes.length);

      for (let i = 0; i < argTypes.length; i++) {
        const t = argTypes[i];
        const a = args[i];
        if (t === 'ptr' || t === 'pointer' || t === 'cstring') {
          marshaled[i] = this.#marshalPtrArg(a as OpenTUIPointerArg, scratch);
        } else if (t === 'u64' || t === 'i64') {
          marshaled[i] = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
        } else if (t === 'usize') {
          // usize is u32 on wasm32: a plain number; tolerate BigInt handles.
          marshaled[i] = typeof a === 'bigint' ? Number(a) : a;
        } else if (t === 'bool') {
          marshaled[i] = a ? 1 : 0;
        } else {
          marshaled[i] = typeof a === 'bigint' ? Number(a) : a;
        }
      }

      let result: unknown;
      try {
        result = fn(...marshaled);
      } finally {
        // Copy-back out-params, then free, in reverse alloc order. The copy-back
        // spans the view's own byteLength (which may be < the padded alloc size).
        for (let i = scratch.length - 1; i >= 0; i--) {
          const s = scratch[i];
          if (s.view && s.view.byteLength > 0) {
            const dst = new Uint8Array(s.view.buffer, s.view.byteOffset, s.view.byteLength);
            dst.set(this.#u8().subarray(s.offset, s.offset + s.view.byteLength));
          }
          this.#exports.nimbus_free(s.offset, s.size);
        }
      }

      if (returns === 'u64' || returns === 'i64') {
        return typeof result === 'bigint' ? result : BigInt(result as number);
      }
      return result;
    };
  }

  /**
   * Marshal one `ptr`-typed argument into a u32 offset, queueing arena scratch
   * for copy-back + free. A view that is writable is treated as a potential
   * out-param (copied back after the call); read-only buffers are copy-in only.
   */
  #marshalPtrArg(
    a: OpenTUIPointerArg,
    scratch: Array<{ offset: number; size: number; view: ArrayBufferView | null }>,
  ): number {
    if (a === null || a === undefined) return 0;
    if (typeof a === 'number') return a >>> 0;
    if (typeof a === 'bigint') return Number(a) >>> 0;

    const { bytes, byteOffset, byteLength } = viewBytes(a);
    const offset = this.#alloc(byteLength === 0 ? ARENA_ALIGN : byteLength);
    if (byteLength > 0) {
      this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
    }
    // A typed-array/ArrayBuffer view is copied back so out-buffer/out-struct
    // params (statsBuffer, outCountBuf, reserveBuffer, bufferGetId, …) work
    // through the same path. ArrayBuffers are wrapped in a Uint8Array so the
    // copy-back targets the same storage.
    const writableView: ArrayBufferView =
      ArrayBuffer.isView(a) ? a : new Uint8Array(a as ArrayBuffer);
    scratch.push({ offset, size: byteLength === 0 ? ARENA_ALIGN : byteLength, view: writableView });
    return offset;
  }

  // ── createCallback(fn, signature): mint a non-zero token, decode on dispatch ─
  //
  // A wasm host cannot install JS functions in the module's indirect table, so
  // the "fn pointer" Zig stores is an opaque non-zero u32 token we mint. The
  // three `opentui` imports (#opentuiImports) receive `(token, ...rawArgs)`,
  // decode the raw (ptr,len) pairs into the FFI-typed positional shape zig.ts's
  // callbacks consume (a `ptr` arg → numeric offset read via toArrayBuffer, a
  // `usize` → numeric, a `u64` → BigInt), and forward to the registered fn.
  // `definition` is unused: the import shims already deliver the decoded shape.
  #createCallback(
    callback: (...args: unknown[]) => unknown,
    _definition: OpenTUIFfiFunction,
  ): OpenTUIFfiCallbackInstance {
    const token = this.#nextToken++;
    const instance: OpenTUIFfiCallbackInstance = {
      ptr: token,
      threadsafe: false,
      close: () => {
        this.#callbacks.delete(token);
      },
    };
    this.#callbacks.set(token, { fn: callback, instance });
    return instance;
  }

  #closeAllCallbacks(): void {
    for (const entry of [...this.#callbacks.values()]) entry.instance.close();
  }

  #alloc(byteLength: number): number {
    const size = byteLength === 0 ? ARENA_ALIGN : byteLength;
    const offset = this.#exports.nimbus_alloc(size);
    if (offset === 0) {
      throw new Error(`opentui-wasm-backend: nimbus_alloc(${size}) returned null (OOM)`);
    }
    return offset;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toOffset(pointer: OpenTUIPointer): number {
  return (typeof pointer === 'bigint' ? Number(pointer) : pointer) >>> 0;
}

/** Normalize an ArrayBuffer/ArrayBufferView to a byte view + offset + length. */
function viewBytes(value: ArrayBuffer | ArrayBufferView): {
  bytes: Uint8Array;
  byteOffset: number;
  byteLength: number;
} {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, 0, value.buffer.byteLength);
    return { bytes, byteOffset: value.byteOffset, byteLength: value.byteLength };
  }
  const bytes = new Uint8Array(value);
  return { bytes, byteOffset: 0, byteLength: value.byteLength };
}
