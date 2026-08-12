/**
 * wasm-memory.ts — declared allocation limits for wasm processes.
 *
 * What the host can and cannot control
 * ────────────────────────────────────
 * `malloc` is dlmalloc compiled into the guest's own linear memory, and
 * `memory.grow` is a wasm *instruction* (opcode 0x40), not an import. There is
 * therefore no host hook on a guest allocation: the guest asks the engine for
 * pages directly and the host is never consulted.
 *
 * The one lever the host does hold is the memory's DECLARED MAXIMUM. Every
 * wasm binary Nimbus runs (bash, busybox, opentui, …) defines its own memory
 * with limits flags `0x00` — a minimum and NO maximum — so `memory.grow`
 * succeeds until the isolate itself dies. That is the silent-isolate-kill
 * failure mode: the guest never learns it ran out of memory, because from its
 * point of view every grow succeeded right up until the process vanished.
 *
 * `withMemoryLimit` rewrites the memory section's limits to carry an explicit
 * maximum. Past that maximum `memory.grow` returns -1, dlmalloc's `sbrk`
 * fails, `malloc` returns NULL, and the program reports an honest allocation
 * failure through its own error path. The isolate survives; the guest reports
 * ENOMEM. Nothing else about the module changes.
 *
 * Scope, stated honestly: this governs the ceiling, not the allocation rate.
 * A guest that stays under the cap is unobserved, and there is no way to
 * observe it — a compiled wasm load or store is a raw machine access with no
 * host hook, so page-level accounting is unreachable for a natively-compiled
 * module.
 */
/** wasm page size. Fixed by the specification. */
export declare const WASM_PAGE_BYTES = 65536;
/** wasm32 address-space ceiling: 65536 pages of 64 KiB = 4 GiB. */
export declare const WASM32_MAX_PAGES = 65536;
/**
 * Default ceiling for one wasm process's linear memory.
 *
 * Measured on prod workerd (throwaway account-pinned DO, 2026-08-02): a
 * Durable Object sustains ~200 MiB of live wasm linear memory and is then
 * killed, and it makes no difference whether those pages were written to or
 * merely reserved — the untouched and fully-filled arms died at exactly the
 * same 200 MiB. Reserving address space is billed at full price, so there is
 * no headroom to be had by growing lazily.
 *
 * 128 MiB leaves ~70 MiB of that measured ceiling for the facet's own JS
 * heap, the module text, and the runner's buffers. It is a budget rather than
 * a measurement of any particular workload's need, and unlike the supervisor
 * heap budget this one IS enforced — `withMemoryLimit` puts it where a guest
 * `memory.grow` can see it.
 */
export declare const DEFAULT_WASM_PROCESS_LIMIT_BYTES: number;
/** Limits declared by a wasm memory, in pages. */
export interface WasmMemoryLimits {
    readonly minPages: number;
    /** `null` when the binary declares no maximum — growth is unbounded. */
    readonly maxPages: number | null;
    /** Raw limits flags. Bit 0 = has-maximum, bit 1 = shared, bit 2 = memory64. */
    readonly flags: number;
}
/**
 * Read the module's linear-memory declaration.
 *
 * Returns `null` for a module that neither defines nor imports a memory.
 * `imported` distinguishes the two cases that matter: an imported memory is
 * created by the host, so its limits are ours to choose at instantiation and
 * no binary rewrite is needed.
 */
export declare function readMemoryLimits(bytes: Uint8Array): (WasmMemoryLimits & {
    imported: boolean;
}) | null;
/**
 * Return a copy of `bytes` whose defined memory carries an explicit maximum of
 * at most `limitBytes`.
 *
 * The cap is only ever lowered: a module that already declares a tighter
 * maximum keeps it. Returns the input unchanged when the module imports its
 * memory (the host picks the limits at instantiation instead) or declares no
 * memory at all.
 *
 * Throws when `limitBytes` is below the module's declared minimum — capping
 * there would produce a module that cannot instantiate, which is a worse
 * failure than the one we are preventing.
 */
export declare function withMemoryLimit(bytes: Uint8Array, limitBytes: number): Uint8Array;
//# sourceMappingURL=wasm-memory.d.ts.map