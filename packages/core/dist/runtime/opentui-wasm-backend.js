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
 * `toArrayBuffer` returns a detach-safe SNAPSHOT copy of a linear-memory range
 * (every zig.ts caller reads-then-decodes synchronously). The five live
 * cell-array views that must track Zig's writes use `liveView()` instead, always
 * re-derived from the CURRENT `memory.buffer` so a `memory.grow` (which detaches
 * the old `ArrayBuffer`) can never strand them — mirroring upstream's post-resize
 * re-fetch discipline (buffer.ts `ensureRawBufferViews`).
 *
 * A `ptr(view)` result is transient scratch for the immediately-following symbol
 * call — exactly like a native FFI pointer into JS memory, which is only valid
 * for the duration of the call it is passed to. Each `dlopen`'d symbol call
 * frees the `ptr()` allocations made before it, so a 60fps `rgbaPtr(color)`
 * render loop does not leak linear memory.
 *
 * The opencode facet backend embeds this implementation into the patched
 * @opentui/core bundle.
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
];
const FFI_TYPE_SET = new Set(OPENTUI_FFI_TYPES);
export const ARENA_ALIGN = 16;
/**
 * The Nimbus OpenTUI wasm FFI backend. Constructed from a compiled module + the
 * WASI host; instantiates once and exposes the @opentui/core backend surface.
 */
export class OpenTUIWasmBackend {
    /** `suffix` is exported for API-shape parity; OpenTUI never resolves a path from it. */
    suffix = 'wasm';
    #instance;
    #exports;
    #wasiResult;
    #encoder = new TextEncoder();
    #decoder = new TextDecoder();
    /** Live callback registry: token → registered instance, dispatched by `opentui` imports. */
    #callbacks = new Map();
    #nextToken = 1; // tokens must be non-zero (0 === null fn pointer)
    /**
     * Transient `ptr()` allocations awaiting release by the next symbol call.
     * A `ptr(view)` pointer is only valid for the call it is passed to (native FFI
     * semantics), so each `dlopen`'d symbol call frees what was allocated before
     * it. Without this a per-frame `rgbaPtr(color)` would leak linear memory.
     *
     * `view` is the source ArrayBufferView when the caller passed a writable one:
     * native FFI `ptr(view)` yields a live pointer into the view's storage, so
     * after the symbol call the view must reflect anything Zig wrote into it. Many
     * FFIRenderLib wrappers materialize OUT-buffers this way — `getCursorState`,
     * `getTerminalCapabilities`, `getRenderStats`, the span-feed's
     * `streamDrainSpans(ptr(outBuffer))`, every `editBufferGet*`/`editorViewGet*` —
     * so the claimed-scratch release copies these back before freeing.
     */
    #pendingPtrScratch = [];
    /**
     * Cached `Uint8Array` over `memory.buffer`, invalidated whenever a grow may
     * have detached it. `#u8()` always returns a view backed by the live buffer.
     */
    #cachedU8 = null;
    #cachedBuffer = null;
    constructor(opts) {
        opts.wasi.initFS({
            root: 'opentui-wasi-root',
            preopens: [{ wasiPath: '/', vfsPath: 'opentui-wasi-root' }],
            files: {},
            dirs: [],
            modes: { 'opentui-wasi-root': 0o7 },
        });
        // getMemory is late-bound: the WASI host re-reads `.buffer` on every call,
        // so a grow is transparent to it. We resolve the export after instantiation.
        let memory = null;
        this.#wasiResult = opts.wasi.makeImports({
            argv: opts.argv ?? ['opentui'],
            env: opts.env ?? {},
            getMemory: () => memory,
            parking: 'none',
            stdoutWrite: opts.stdoutWrite,
            stderrWrite: opts.stderrWrite,
        });
        this.#instance = new WebAssembly.Instance(opts.module, {
            wasi_snapshot_preview1: this.#wasiResult.wasiImport,
            opentui: this.#opentuiImports(),
        });
        this.#exports = this.#instance.exports;
        memory = this.#exports.memory;
        this.#exports._initialize();
    }
    static create(opts) {
        return new OpenTUIWasmBackend(opts);
    }
    /** Buffered stdout if no `stdoutWrite` sink was provided. */
    getStdout() {
        return this.#wasiResult.getStdout();
    }
    getStderr() {
        return this.#wasiResult.getStderr();
    }
    /** The live `WebAssembly.Memory` (Stage C/D may need it for diagnostics). */
    get memory() {
        return this.#exports.memory;
    }
    // ── memory-grow-safe linear-memory access ──────────────────────────────────
    // Every view is re-derived from the CURRENT `memory.buffer`. `memory.grow`
    // allocates a fresh backing ArrayBuffer and detaches the old one, so a cached
    // view would throw on use; we compare buffer identity and rebuild on change.
    #u8() {
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
    #opentuiImports() {
        const dispatch = (token) => this.#callbacks.get(token >>> 0)?.fn;
        return {
            logCallback: (token, level, msgPtr, msgLen) => {
                dispatch(token)?.(level, msgPtr >>> 0, msgLen >>> 0);
            },
            eventSinkCallback: (token, namePtr, nameLen, dataPtr, dataLen) => {
                dispatch(token)?.(namePtr >>> 0, nameLen >>> 0, dataPtr >>> 0, dataLen >>> 0);
            },
            streamCallback: (token, streamPtr, eventId, arg0, arg1) => {
                dispatch(token)?.(streamPtr >>> 0, eventId >>> 0, arg0 >>> 0, arg1);
            },
        };
    }
    // ── ptr(view): copy a view/buffer into the arena, return its u32 offset ─────
    //
    // Used when zig.ts pre-materializes an address (rgbaPtr → ptr(rgba.buffer),
    // ptr(outCountBuf), ptr(reserveBuffer), …) and passes the numeric offset into
    // the very next symbol call. Native FFI hands the callee a raw pointer into JS
    // memory valid only for that call; we mirror that lifetime by queuing the
    // allocation as transient scratch that the next symbol call frees (see
    // `#bindSymbol`). This keeps a per-frame `rgbaPtr(color)` loop leak-free.
    //
    // A writable ArrayBufferView is also an OUT-buffer here: native `ptr(view)` is
    // a live pointer into the view's storage, so after the call the view must
    // reflect Zig's writes. We record the source view so the claimed-scratch
    // release copies it back (the span-feed `streamDrainSpans(ptr(drainBuffer))`
    // and every FFIRenderLib `ptr(outBuffer)`/`ptr(cursorBuffer)`/`ptr(statsBuffer)`
    // getter depend on this). Read-only ArrayBuffers carry a null view (copy-in only).
    ptr(value) {
        const { bytes, byteOffset, byteLength } = viewBytes(value);
        const size = byteLength === 0 ? ARENA_ALIGN : byteLength;
        const offset = this.#alloc(size);
        if (byteLength > 0) {
            this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
        }
        this.#pendingPtrScratch.push({
            offset,
            size,
            view: ArrayBuffer.isView(value) ? value : null,
        });
        return offset;
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
    toArrayBuffer(pointer, offset, length) {
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
    liveView(ctor, pointer, length) {
        return new ctor(this.#exports.memory.buffer, toOffset(pointer), length);
    }
    // ── dlopen(path, symbols): wire every requested symbol to its export ────────
    dlopen(_path, symbols) {
        const exports = this.#instance.exports;
        const bound = Object.create(null);
        for (const name of Object.keys(symbols)) {
            const sig = symbols[name];
            const raw = exports[name];
            if (typeof raw !== 'function') {
                throw new Error(`opentui-wasm-backend: export '${name}' is missing or not callable`);
            }
            bound[name] = this.#bindSymbol(name, raw, sig);
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
    #bindSymbol(name, fn, sig) {
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
        return (...args) => {
            // Optional per-symbol FFI diagnostic (call counts + linear-memory growth
            // attribution). Installed by the opencode runner only when NIMBUS_DIAG_EXEC
            // is set; a single global read on the hot path otherwise.
            const diag = globalThis.__nimbusOtuiFfiDiag;
            const memBefore = diag ? this.#exports.memory.buffer.byteLength : 0;
            // Claim the transient ptr() scratch allocated while zig.ts evaluated this
            // call's args. Claiming (vs. draining the shared list) scopes the frees to
            // this call, so a callback that re-enters another symbol mid-execution
            // cannot free a pointer this call is still reading.
            const claimedPtr = this.#pendingPtrScratch.splice(0);
            const scratch = [];
            const marshaled = new Array(argTypes.length);
            for (let i = 0; i < argTypes.length; i++) {
                const t = argTypes[i];
                const a = args[i];
                if (t === 'ptr' || t === 'pointer' || t === 'cstring') {
                    marshaled[i] = this.#marshalPtrArg(a, scratch);
                }
                else if (t === 'u64' || t === 'i64') {
                    marshaled[i] = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
                }
                else if (t === 'usize') {
                    // usize is u32 on wasm32: a plain number; tolerate BigInt handles.
                    marshaled[i] = typeof a === 'bigint' ? Number(a) : a;
                }
                else if (t === 'bool') {
                    marshaled[i] = a ? 1 : 0;
                }
                else {
                    marshaled[i] = typeof a === 'bigint' ? Number(a) : a;
                }
            }
            let result;
            try {
                result = fn(...marshaled);
            }
            finally {
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
                // Release this call's transient ptr() scratch (reverse alloc order),
                // copying writable views back first so `ptr(outBuffer)` OUT-params (the
                // span-feed drain, FFIRenderLib getters) reflect Zig's writes.
                for (let i = claimedPtr.length - 1; i >= 0; i--) {
                    const s = claimedPtr[i];
                    if (s.view && s.view.byteLength > 0) {
                        const dst = new Uint8Array(s.view.buffer, s.view.byteOffset, s.view.byteLength);
                        dst.set(this.#u8().subarray(s.offset, s.offset + s.view.byteLength));
                    }
                    this.#exports.nimbus_free(s.offset, s.size);
                }
            }
            if (diag) {
                let scratchBytes = 0;
                for (const s of claimedPtr)
                    scratchBytes += s.size;
                for (const s of scratch)
                    scratchBytes += s.size;
                diag.rec(name, this.#exports.memory.buffer.byteLength - memBefore, marshaled, scratchBytes);
            }
            if (returns === 'u64' || returns === 'i64') {
                return typeof result === 'bigint' ? result : BigInt(result);
            }
            return result;
        };
    }
    /**
     * Marshal one `ptr`-typed argument into a u32 offset, queueing arena scratch
     * for copy-back + free. A view that is writable is treated as a potential
     * out-param (copied back after the call); read-only buffers are copy-in only.
     */
    #marshalPtrArg(a, scratch) {
        if (a === null || a === undefined)
            return 0;
        if (typeof a === 'number')
            return a >>> 0;
        if (typeof a === 'bigint')
            return Number(a) >>> 0;
        const { bytes, byteOffset, byteLength } = viewBytes(a);
        const offset = this.#alloc(byteLength === 0 ? ARENA_ALIGN : byteLength);
        if (byteLength > 0) {
            this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
        }
        // A typed-array/ArrayBuffer view is copied back so out-buffer/out-struct
        // params (statsBuffer, outCountBuf, reserveBuffer, bufferGetId, …) work
        // through the same path. ArrayBuffers are wrapped in a Uint8Array so the
        // copy-back targets the same storage.
        const writableView = ArrayBuffer.isView(a) ? a : new Uint8Array(a);
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
    #createCallback(callback, _definition) {
        const token = this.#nextToken++;
        const instance = {
            ptr: token,
            threadsafe: false,
            close: () => {
                this.#callbacks.delete(token);
            },
        };
        this.#callbacks.set(token, { fn: callback, instance });
        return instance;
    }
    #closeAllCallbacks() {
        for (const entry of [...this.#callbacks.values()])
            entry.instance.close();
    }
    #alloc(byteLength) {
        const size = byteLength === 0 ? ARENA_ALIGN : byteLength;
        const offset = this.#exports.nimbus_alloc(size);
        if (offset === 0) {
            throw new Error(`opentui-wasm-backend: nimbus_alloc(${size}) returned null (OOM)`);
        }
        return offset;
    }
}
// ── helpers ───────────────────────────────────────────────────────────────────
export function toOffset(pointer) {
    return (typeof pointer === 'bigint' ? Number(pointer) : pointer) >>> 0;
}
/** Normalize an ArrayBuffer/ArrayBufferView to a byte view + offset + length. */
export function viewBytes(value) {
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, 0, value.buffer.byteLength);
        return { bytes, byteOffset: value.byteOffset, byteLength: value.byteLength };
    }
    const bytes = new Uint8Array(value);
    return { bytes, byteOffset: 0, byteLength: value.byteLength };
}
