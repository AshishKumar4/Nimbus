/**
 * facets/durable-slots.ts — the durable application's facet-name allocator.
 *
 * A durable application's storage has to answer under ONE facet name for its
 * whole life: abort ends the process, not the store, so relaunch and eviction
 * re-attach the same SQLite — which is only true while the name is stable.
 * The ephemeral slot book in `workerd-facet-host.ts` cannot supply it: it is
 * in-memory, and a fresh incarnation restarts `proc-slot-<n>` numbering from
 * zero, so a durable name needs a store of its own — the DO storage this file
 * keeps it in.
 *
 * The rows:
 *
 *   durable-slot:next    — the lowest never-issued slot number. Minting burns
 *                          one facet ID forever, so a freed name goes to
 *                          `free`, never back to `next`.
 *   durable-slot:free    — slot numbers whose applications were removed.
 *   durable-slot:<owner> — the owner's pinned slot. Written once, ever;
 *                          re-read on every relaunch and re-drive.
 *
 * Names carry the `app-slot-` prefix, disjoint by construction from the
 * ephemeral book's `proc-slot-` — the two namespaces share the facet-ID
 * budget, and a collision would hand one application's retained storage to
 * another process.
 */
/** The facet name a durable slot number names. */
export declare function durableFacetName(slot: number): string;
/**
 * The owner's facet name, minted on first call and pinned for the
 * application's life. The owner key, counter and free list move inside one
 * transaction, so a concurrent spawn cannot split the claim, and a re-read
 * after a reset — or after eviction — answers the same name.
 *
 * A fresh name records the mint against the lifetime facet-ID ledger so the
 * budget a durable spawn consumes is counted the same way an ephemeral one's
 * is.
 */
export declare function acquireDurableFacetSlot(ctx: DurableObjectState, owner: string): Promise<string>;
/**
 * Hand the owner's slot back to the free list and drop its pin — the last
 * step of explicit removal, after the facet's SQLite is already gone. Answers
 * the freed name, or null when the owner held nothing.
 */
export declare function freeDurableFacetSlot(ctx: DurableObjectState, owner: string, beforeFree?: (name: string) => void): Promise<string | null>;
//# sourceMappingURL=durable-slots.d.ts.map