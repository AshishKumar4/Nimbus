/**
 * N18: the session's storage ledger admits a process store's growth before
 * it happens. The supervisor grants an allowance (the ledger records it under
 * the facet's name); the store never grows its database past the cap, and
 * asks for more, asynchronously, when it would. What does not fit is not
 * held: a fill degrades to reads through the session, and an own write goes
 * to the session only. A null cap: no ledger (no cap).
 *
 * A one-shot's heap (store.bindInMemory) is one fixed budget: its tables, the
 * own writes held beside them, the namespace's overlay and reserve, and what
 * a WASI process pins, all count against the same cap, and there is no one
 * to ask for more.
 */
import type { Coherence } from './coherence.js';
import type { ResidentSupervisor } from './supervisor.js';
export interface Admission {
    /** Whether the store is a one-shot's heap rather than a facet's storage. */
    readonly inHeap: boolean;
    readonly cap: number | null;
    /** Everything the cap counts. */
    dbBytes(): number;
    /** Bound to a one-shot's heap, capped at `budget` and never growing past it. */
    bindHeap(budget: number): void;
    /** What the own writes held in memory take (cells' held cells): counted here, against the one budget. */
    readonly heldBytes: number;
    addHeld(bytes: number): void;
    /**
     * What gives held cells up, least recently read first, until `bytes` of
     * them are gone or none is left (cells): the session holds what they hold,
     * so they make room for bytes the process has yet to send (pin).
     */
    setHeldShedder(shed: (bytes: number) => void): void;
    /** The allowance this launch was admitted for (the fabric's startArgs.storage). */
    setStorage(storage: unknown, supervisor: ResidentSupervisor | null | undefined): void;
    /** The cap this store enforces, for startProcess to report. */
    storageCap(): number | null;
    /** What the session's ledger said a user may still write, at its last answer; null before one. */
    readonly available: number | null;
    /**
     * `bytes` held in the isolate's heap beside the store, whatever backs its
     * tables (a process's decided bytes, a descriptor's pinned content): a
     * one-shot's share the store's one budget; a facet's have their own bound
     * (FACET_OWN_WRITE_MEMORY_BYTES), with the own bytes the cells hold. False
     * where they do not fit.
     */
    pin(bytes: number): boolean;
    unpin(bytes: number): void;
    /** Room a one-shot's held own writes may take beside everything else. */
    heldLimit(maxBytes: number): number;
    /**
     * Why a one-shot's namespace may not grow by `bytes`, or null: the cap is
     * one budget, and a namespace that does not fit cannot be described. Only a
     * one-shot's heap is judged here; a facet's storage is admitted as it grows.
     */
    namespaceRefusal(bytes: number): string | null;
    /** namespaceRefusal of a row put into the heap tables, growing them by `growth` (the overlay and reserve beside them, not pins). */
    rowRefusal(growth: number): string | null;
    /** The namespace overlay's bytes (node-shims' own structural effects), charged to a one-shot's budget. */
    addOverlay(bytes: number): void;
    /** Hold `bytes` of namespace room while a reconcile fetches; give it back with the returned function. */
    reserveNamespace(bytes: number): () => void;
    reserve(path: string, bytes: number): Promise<boolean>;
    release(path: string): void;
    fits(bytes: number, ask?: boolean): boolean;
    ensureRoom(bytes: number): Promise<boolean>;
    roomForPushed(result: unknown): Promise<void>;
    reportSize(): Promise<void>;
}
export declare function createAdmission(coherence: Coherence): Admission;
//# sourceMappingURL=admission.d.ts.map