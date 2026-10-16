import { type ResizableCreditLease } from '@nimbus-sh/platform/weighted-credit-pool.js';
import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
import { type LoaderStoreRef, type StoredKind, type StoredModule } from './loader-store-client.js';
/** A load or get the shim refuses: its message names the limit and the value. */
export declare class LoaderRefusal extends Error {
    readonly name = "LoaderRefusal";
}
/** A walk's identity set, shared across the walks of one admission so a shared object is charged once. */
export type ChargeSeen = Set<object>;
/**
 * Everything `root` holds live, charged once per object (`seen` shared
 * across calls), or Infinity once the charge passes `limit` (the walk stops
 * there). Every own property of every object is walked, a built-in's too
 * (its intrinsic storage charged by its kind); a function (an RPC stub, a
 * service binding) is a capability, charged as one and not walked. Throws
 * LoaderRefusal, `at` naming where, for a compiled WebAssembly.Module, a
 * symbol, or an accessor, whose value the shim cannot account for without
 * running it.
 */
export declare function liveCharge(root: unknown, limit: number, at: string, seen?: ChargeSeen): number;
/**
 * At most how long `JSON.stringify(value)` is, in UTF-16 units, bounded
 * before it is built: every string at its worst escaping (6 per unit, and its
 * quotes), 25 per number, 5 per literal, and 2 per container plus 1 per
 * separator; Infinity past `limit`.
 */
export declare function jsonTextBound(value: unknown, limit: number): number;
/**
 * The length of `text` as JSON.stringify writes it, quotes included, counted
 * without building it: a control character or lone surrogate as six (`\u00XX`),
 * `"` and `\` as two. Stops counting past `limit`.
 */
export declare function jsonStringLength(text: string, limit: number): number;
/** A loaded Worker, but for its modules: what a native miss re-creates it from. */
interface LoaderEntry {
    /** Its charge, without ByteLru's own per-entry overhead (which ByteLru adds). */
    readonly byteLength: number;
    /** Its modules' name in the module cache: short, whatever its key's length. */
    readonly id: number;
    readonly code: Omit<WorkerCode, 'modules'>;
    readonly modules: readonly string[];
    /** What a native miss holds of it at its peak: its modules' working prices, the entry's own charge and a read frame. */
    readonly missPeak: number;
    /** Where its modules are durable, when its binding has a store: a module the cache let go is read back from there. */
    readonly store?: {
        readonly ref: LoaderStoreRef;
        readonly modules: ReadonlyMap<string, {
            readonly kind: StoredKind;
            readonly size: number;
            readonly digest: string;
        }>;
    };
}
/** The shim's counters: each bucket on its own, and their sum as a stated upper bound (borrowed buffers counted twice). */
export declare function loaderHeapStats(): {
    entries: number;
    entryCacheMaxBytes: number;
    moduleCacheMaxBytes: number;
    codeCreditBytes: number;
    keyAllowanceBytes: number;
    entryCacheBytes: number;
    moduleCacheBytes: number;
    codeReserved: number;
    codeWaiting: number;
    keyReserved: number;
    keyRefused: number;
    retainedUpperBound: number;
    refusals: number;
    nativeMisses: number;
    evictedMisses: number;
};
/** What an admission holds, priced before it holds credit for it. */
export interface PricedCode {
    readonly code: WorkerCode;
    /** Its whole live input, shared objects charged once. */
    readonly charge: number;
    /** At most what its `{json}` modules' texts hold while it keeps them (twice their bounded length). */
    readonly jsonText: number;
    readonly entry: Omit<LoaderEntry, 'id'>;
    /** Each module's charge on its own, as the module cache would hold it. */
    readonly moduleCharges: ReadonlyMap<string, number>;
}
/** Price `code`, admitted under `key` (whose own charge the caller holds): refused by name over any bound. */
export declare function priceCode(code: WorkerCode, key: string): PricedCode;
/** `credit`, refused by name when the whole pool could never grant it. */
export declare function withinCredit(credit: number): number;
/** Code credit for an argument that has already arrived: granted now, or the call is refused. */
export declare function admitNow(charge: number): ResizableCreditLease;
/** Code credit, waited for in turn (holding nothing it charges), or refused after CREDIT_WAIT_MS. */
export declare function admitInTurn(charge: number, what: string): Promise<ResizableCreditLease>;
/**
 * A `get`'s key, bounded before it is built: each of its parts a string (the
 * network id may be null) of at most LOADER_GET_ID_MAX_CHARS units, its JSON
 * length counted first. Its `charge` is the key's and the raw parts' own,
 * which a miss holds under the key allowance (holdGetKey); a hit holds none.
 */
export declare function getKey(namespace: unknown, networkId: unknown, id: unknown): {
    key: string;
    charge: number;
};
/** A missed `get`'s key and arguments, held under the key allowance: granted now, or the call is refused. */
export declare function holdGetKey(charge: number): ResizableCreditLease;
/**
 * Keep an admitted Worker: its entry, and each module the module cache can
 * hold (one larger than it is not offered, so it never flushes the rest).
 * One whose modules are durable (`stored`, in `ref`'s store) is re-created
 * from there once the cache lets them go, so its miss peak is priced from
 * their working prices, and refused over the per-Worker bound before its
 * handle is returned.
 */
export declare function keep(key: string, priced: PricedCode, durable?: {
    readonly ref: LoaderStoreRef;
    readonly modules: ReadonlyMap<string, StoredModule>;
}): void;
/** The code `key` was admitted with but its modules (its policy's source), or undefined once evicted. */
export declare function loadedCode(key: string): Omit<WorkerCode, 'modules'> | undefined;
/**
 * A native miss's code for `key`: credit for its miss peak taken first,
 * holding nothing but the key while it waits; the entry looked up again once
 * it is granted (one replaced meanwhile by a larger one is refused, as its
 * lease does not cover it), its owner asked whether it is alive (a retired
 * build's Worker is never re-created), and every module from the cache or,
 * the cache having let it go, from its store (through `env`'s host
 * namespace). A Worker the shim no longer holds fails by name. The lease is
 * held until `use` returns.
 */
export declare function withMissCode<T>(key: string, env: object, use: (code: WorkerCode) => T | Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=loader-heap.d.ts.map