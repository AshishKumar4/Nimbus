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
export declare const OPENTUI_FFI_TYPES: readonly ["void", "bool", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64", "usize", "ptr", "pointer", "cstring"];
export type OpenTUIFfiType = (typeof OPENTUI_FFI_TYPES)[number];
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
export type OpenTUIPointerArg = number | bigint | ArrayBufferView | ArrayBuffer | null | undefined;
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
    createCallback(callback: (...args: unknown[]) => unknown, definition: OpenTUIFfiFunction): OpenTUIFfiCallbackInstance;
    close(): void;
}
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
        preopens: Array<{
            wasiPath: string;
            vfsPath: string;
        }>;
        files: Record<string, string>;
        dirs: string[];
        modes: Record<string, number>;
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
export declare const ARENA_ALIGN = 16;
/**
 * The Nimbus OpenTUI wasm FFI backend. Constructed from a compiled module + the
 * WASI host; instantiates once and exposes the @opentui/core backend surface.
 */
export declare class OpenTUIWasmBackend {
    #private;
    /** `suffix` is exported for API-shape parity; OpenTUI never resolves a path from it. */
    readonly suffix = "wasm";
    private constructor();
    static create(opts: OpenTUIWasmBackendOptions): OpenTUIWasmBackend;
    /** Buffered stdout if no `stdoutWrite` sink was provided. */
    getStdout(): string;
    getStderr(): string;
    /** The live `WebAssembly.Memory` (Stage C/D may need it for diagnostics). */
    get memory(): WebAssembly.Memory;
    ptr(value: ArrayBuffer | ArrayBufferView): OpenTUIPointer;
    toArrayBuffer(pointer: OpenTUIPointer, offset: number | undefined, length: number): ArrayBuffer;
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
    liveView<T extends Uint8Array | Uint16Array | Uint32Array>(ctor: {
        new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
    }, pointer: OpenTUIPointer, length: number): T;
    dlopen(_path: string, symbols: OpenTUIFfiSymbols): OpenTUIFfiLibrary;
}
export declare function toOffset(pointer: OpenTUIPointer): number;
/** Normalize an ArrayBuffer/ArrayBufferView to a byte view + offset + length. */
export declare function viewBytes(value: ArrayBuffer | ArrayBufferView): {
    bytes: Uint8Array;
    byteOffset: number;
    byteLength: number;
};
//# sourceMappingURL=opentui-wasm-backend.d.ts.map