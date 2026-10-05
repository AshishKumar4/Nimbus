/**
 * git/pack/processor.ts — one pass over a pack as its bytes arrive.
 *
 * Each entry, once its zlib stream is whole in the buffer, is inflated
 * (native zlib), its CRC taken, its delta resolved against the base cache,
 * its id hashed, its raw bytes passed on to be stored, and the resolved
 * object handed to the caller (who writes blobs into the worktree). Nothing
 * reads the pack back except a delta whose base has left the cache, and then
 * only that base's chain.
 *
 * Work is counted in units calibrated against the facet's CPU limit (see
 * WORK_UNIT_*). Past the budget the processor stops decoding and only stores
 * and hashes the rest of the stream, which needs no parsing: the trailer is
 * its last 20 bytes. `run` then reports where decoding stopped, and a later
 * invocation continues from the stored pack (`resume`).
 */
import { type GitObjectType } from './format.js';
import { type ResolvedObject } from './reader.js';
/**
 * Work units. One unit is the CPU of SHA-1 over one byte in bulk; each other
 * step is weighed against it.
 *
 * The limit: a Dynamic Worker LOADER.load()ed from the session DO, as this
 * facet is, with no load-level limits, runs ~30 s of CPU per invocation.
 * Measured 2026-10-05 on a throwaway: SHA-1 over 16 MiB units was killed with
 * "Worker exceeded CPU time limit" after 3,338 units, 32.2 s wall, so bulk
 * SHA-1 runs at ~1.8 GB/s there. WORK_BUDGET_UNITS is a third of the limit:
 * 10 s x 1.8e9 units/s = 18e9.
 *
 * The weights: each step timed alone in workerd 1.20260926 over the
 * TypeScript depth-1 pack (65,387 objects, 37 MB), three runs, relative to
 * bulk SHA-1 timed in the same run (0.36-0.45 ns/byte locally):
 *   inflate, per output byte   7.6-11.4  -> 8
 *   object SHA-1, per byte     2.6-4.1   -> 3   (per-call overhead on small objects)
 *   delta apply, per out byte  5.7-9.9   -> 8
 *   per object, the rest       1k-23k    -> 10,000 (~4 us; parse, crc, cache, emit)
 * With these the whole pass came to 3.35e9 units, predicting 1.2-1.5 s; it
 * measured 1.33-1.65 s.
 */
export declare const WORK_UNIT_PACK_HASH_BYTE = 1;
export declare const WORK_UNIT_OBJECT_HASH_BYTE = 3;
export declare const WORK_UNIT_INFLATE_BYTE = 8;
export declare const WORK_UNIT_DELTA_BYTE = 8;
export declare const WORK_UNIT_OBJECT = 10000;
export declare const WORK_BUDGET_UNITS = 18000000000;
export interface ProcessedObject {
    oid: Uint8Array;
    type: GitObjectType;
    data: Uint8Array;
    offset: number;
}
/** Where the pack's bytes go, and how they come back for an evicted base. */
export interface PackStore {
    /** Append the next bytes of the pack; resolves once accepted (backpressure). */
    append(bytes: Uint8Array): Promise<void>;
    /** Overwrite already-appended bytes (a thin pack's object count). */
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
    /** Drop everything from `size` on (a resumed thin pack's old trailer). */
    truncate(size: number): Promise<void>;
    /** Bytes already appended, [offset, offset + length). */
    read(offset: number, length: number): Promise<Uint8Array>;
}
/** Objects outside this pack: a thin pack's ref-delta bases. */
export interface ExternalObjects {
    read(oid: Uint8Array): Promise<ResolvedObject | null>;
}
export interface PackProcessorOptions {
    store: PackStore;
    /** Every resolved object, in pack order; awaited, so it can apply backpressure. */
    onObject?(object: ProcessedObject): Promise<void> | void;
    external?: ExternalObjects;
    /** Delta-base cache budget, bytes. */
    cacheBytes?: number;
    /** Decode no more than this many work units; the rest of the stream is only stored. */
    budgetUnits?: number;
}
/** Decoding stopped before the pack's end; a continuation picks up here. */
export interface PackCheckpoint {
    /** Offset of the first entry not yet decoded. */
    offset: number;
    /** Entries decoded so far. */
    decoded: number;
    /** Their idx records (ENTRY_BYTES each), in pack order. */
    records: Uint8Array;
    /** External (thin-pack) bases used so far, by hex id. */
    externalBases: string[];
}
export interface PackProcessResult {
    /** The pack's id: its trailer, as stored. */
    packSha: Uint8Array;
    objects: number;
    /** Bytes stored, trailer included. */
    packBytes: number;
    /** idx records in idx order; null when decoding stopped early. */
    entries: Uint8Array | null;
    /** Set when the budget ran out before the last entry. */
    checkpoint: PackCheckpoint | null;
    work: WorkTally;
    /** Thin-pack bases appended to complete the pack (index-pack --fix-thin). */
    appendedBases: number;
}
export interface WorkTally {
    units: number;
    inflatedBytes: number;
    hashedBytes: number;
    deltaBytes: number;
    objects: number;
    baseRereads: number;
}
export declare class PackStreamProcessor {
    private readonly options;
    private readonly cache;
    private readonly work;
    private readonly budget;
    private records;
    /** In-pack ids → offsets, built the first time a ref-delta asks. */
    private byOid;
    /** External bases used, by hex id: appended to the pack at its end. */
    private readonly externalBases;
    private output;
    private resolver;
    constructor(options: PackProcessorOptions);
    /** Consume a whole pack stream: decode within budget, store all of it. */
    run(source: AsyncIterable<Uint8Array>): Promise<PackProcessResult>;
    /** Continue decoding a stored pack of `packBytes` bytes from a checkpoint. */
    resume(checkpoint: PackCheckpoint, packBytes: number): Promise<PackProcessResult>;
    private result;
    private makeResolver;
    /** Wait until the next entry's zlib stream is whole in the buffer, and inflate it. */
    private nextEntry;
    private decode;
    private baseAt;
    /** A ref-delta's base: in this pack, or (a thin pack) in the repository. */
    private refBaseObject;
    private refBase;
    /** index-pack --fix-thin: append each external base whole, rewrite the count, re-hash. */
    private completeThin;
}
//# sourceMappingURL=processor.d.ts.map