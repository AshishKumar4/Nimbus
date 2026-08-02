/**
 * wasm-process-image.ts — checkpoint and restore a live wasm process.
 *
 * Why this is possible at all, and where the line is
 * ──────────────────────────────────────────────────
 * Page-level demand paging is not available to us. A compiled wasm load or
 * store is a raw machine access with no host hook, `memory.grow` is an
 * instruction rather than an import, and an out-of-bounds access traps in a
 * way that destroys the stack instead of faulting a page in. do86 gets demand
 * paging only because it is an *emulator*: v86 implements the x86 MMU in
 * software, so its `do_page_walk` can call an imported `swap_page_in` on a
 * miss. Guest memory there is data inside the wasm heap, not the wasm heap
 * itself. Nothing in that design transfers to natively-compiled Ruby or bash.
 *
 * Checkpointing at defined points is a different problem and it IS solvable,
 * because of a property of the toolchain we control:
 *
 *   Asyncify's unwind writes the entire wasm call stack INTO the module's own
 *   linear memory. At a park point the process's execution state is ordinary
 *   bytes at a known address.
 *
 * So for an Asyncify-instrumented module, linear memory plus the exported
 * mutable globals IS the whole process, program counter included, and a
 * restore followed by `asyncify_start_rewind` resumes at the exact
 * instruction. This is not a new trick in Nimbus — bash's `fork` already
 * relies on precisely this, copying memory and globals into a sibling
 * instance and rewinding it. Checkpointing to storage is the same operation
 * with a different destination.
 *
 * JSPI is the opposite case. A JSPI-suspended stack lives in engine-owned
 * memory, not in the module's linear memory, and there is no way to read or
 * reconstruct it. A JSPI process is therefore checkpointable only when no
 * suspension is live — between top-level calls, not mid-await.
 *
 * What a caller must supply and what it cannot get back
 * ────────────────────────────────────────────────────
 * An image covers what lives INSIDE the instance: linear memory and exported
 * mutable globals. Everything a runtime keeps on the JS side about the
 * process — the fd table, WASI preopens, the pipe graph, socket handles, the
 * scheduler's runnable set, Asyncify arena addresses — lives in the runner,
 * not the instance, and this module cannot see it. Callers pass it as
 * `hostState` and get it back verbatim on restore; correctness of that blob
 * is the runner's responsibility, not ours.
 *
 * Three things genuinely cannot be restored, and no caller should be told
 * otherwise:
 *   - a live JSPI suspension (engine-owned stack, unreadable);
 *   - open host resources behind an fd — sockets, in-flight fetches — which
 *     can be re-described but not resumed mid-flight;
 *   - non-exported mutable globals, which the host cannot observe. Modules
 *     whose state depends on them are not checkpointable, and
 *     `captureProcessImage` reports what it found so a caller can check.
 *
 * Storage
 * ───────
 * Images go to `ctx.storage.kv`, not the VFS: they are kernel state and have
 * no business being visible to `ls`. Measured on prod workerd — values up to
 * 2 MiB are accepted and 4 MiB fails with SQLITE_TOOBIG, so images are
 * chunked at 2 MiB. The whole path is synchronous by construction, which is
 * also what makes it atomic: no await means no interleaving, so no torn
 * image. The commit point is a single manifest write that happens last;
 * a failure before it leaves unreferenced chunks, never a half-image.
 */
/** Largest value `ctx.storage.kv` accepts. Measured, not assumed. */
export declare const SWAP_CHUNK_BYTES: number;
/**
 * The synchronous, sqlite-backed key/value surface this module needs.
 * Structural rather than a workerd import so tests can drive it directly.
 */
export interface SyncKvStore {
    get(key: string): unknown;
    put(key: string, value: unknown): void;
    delete(key: string): void;
    list?(options?: {
        prefix?: string;
    }): Iterable<[string, unknown]>;
}
/** A captured global, tagged so an i64 survives the round trip. */
export type CapturedGlobal = {
    readonly name: string;
    readonly kind: 'number';
    readonly value: number;
} | {
    readonly name: string;
    readonly kind: 'bigint';
    readonly value: string;
};
/** Everything needed to reconstitute a process, minus the page bytes. */
export interface WasmProcessImage {
    readonly version: number;
    readonly pages: number;
    readonly pageSize: number;
    /** Indices of the pages carried in the body, ascending. */
    readonly residentPages: readonly number[];
    readonly globals: readonly CapturedGlobal[];
    /** Globals seen on the instance that are immutable, hence not restorable. */
    readonly immutableGlobals: readonly string[];
    /** 64-bit integrity digest of the body, as 16 lowercase hex chars. */
    readonly contentId: string;
    readonly capturedAt: number;
    /** Opaque runner-owned state, returned verbatim on restore. */
    readonly hostState: unknown;
}
export declare class WasmImageIntegrityError extends Error {
    readonly key: string;
    readonly expected: string;
    readonly actual: string;
    constructor(key: string, expected: string, actual: string);
}
export declare class WasmImageMissingError extends Error {
    readonly key: string;
    constructor(key: string, detail: string);
}
/** Result of a capture: the header, and the page bytes it describes. */
export interface CapturedProcess {
    readonly image: WasmProcessImage;
    /** Concatenated resident pages, `residentPages.length * pageSize` bytes. */
    readonly body: Uint8Array;
}
/**
 * Snapshot a parked wasm process.
 *
 * All-zero pages are elided: fresh wasm pages are zero-filled by the
 * specification, so a zero page restores identically whether it was written
 * or never touched. For a process like bash — which reserves a ~136 MiB
 * Asyncify arena it mostly never writes — this is the difference between a
 * 136 MiB image and a few MiB one.
 *
 * The caller is responsible for only calling this at a park point. This
 * module cannot verify that: `asyncify_get_state` reports whether an unwind
 * is in progress, but a module not built with Asyncify exports nothing to
 * check, and there is no honest way to detect a live JSPI suspension.
 */
export declare function captureProcessImage(instance: WebAssembly.Instance, hostState?: unknown): CapturedProcess;
/**
 * Write a captured image back into a fresh instance of the same module.
 *
 * The instance must be freshly created — restore writes the resident pages
 * but does NOT zero the rest, because a fresh wasm memory is already zero and
 * re-zeroing a 200 MiB address space costs more than the whole checkpoint.
 * Reusing a dirty instance would therefore leave its old bytes showing
 * through the elided pages, so that is rejected rather than silently allowed:
 * a restore target must be at or below the image's page count.
 */
export declare function restoreProcessImage(instance: WebAssembly.Instance, image: WasmProcessImage, body: Uint8Array): unknown;
interface StoredManifest {
    readonly image: WasmProcessImage;
    readonly chunks: number;
    readonly bodyBytes: number;
}
/**
 * Durable swap space for parked wasm processes, over a DO's synchronous
 * sqlite key/value store.
 *
 * Images are content-addressed, so two processes checkpointed from the same
 * state share one copy of the bytes, and a re-checkpoint that changed nothing
 * writes nothing. The manifest write is the commit point and happens last: a
 * crash mid-write leaves chunks that no manifest references, which `sweep`
 * reclaims, rather than a manifest pointing at a partial image.
 */
export declare class WasmSwapStore {
    private readonly kv;
    private readonly chunkBytes;
    constructor(kv: SyncKvStore, chunkBytes?: number);
    /** Checkpoint a parked process. Returns what it cost and what it elided. */
    swapOut(key: string, instance: WebAssembly.Instance, hostState?: unknown): {
        contentId: string;
        imageBytes: number;
        liveBytes: number;
        elidedBytes: number;
    };
    /**
     * Restore a checkpointed process into a fresh instance, returning the
     * `hostState` the runner handed to `swapOut`.
     */
    swapIn(key: string, instance: WebAssembly.Instance): unknown;
    /** Read an image without a restore target — for diagnostics and migration. */
    read(key: string): {
        manifest: StoredManifest;
        body: Uint8Array;
    };
    has(key: string): boolean;
    /** Drop a process's checkpoint. Shared chunks survive until `sweep`. */
    forget(key: string): void;
    /**
     * Delete chunks no manifest references. Requires a `list`-capable store;
     * without one there is no way to enumerate orphans, and this reports so
     * rather than pretending it collected anything.
     */
    sweep(): {
        reclaimedChunks: number;
    };
    private chunkKey;
}
export {};
//# sourceMappingURL=wasm-process-image.d.ts.map