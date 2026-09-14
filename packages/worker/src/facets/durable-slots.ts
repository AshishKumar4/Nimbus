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

import { DURABLE_SLOT_KEY_PREFIX } from '../session/keys.js';
import { DURABLE_FACET_NAME_PREFIX } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { facetNameCountDurable, recordFacetNameMinted } from '@nimbus-sh/fabric/budgets.js';

const NEXT_KEY = `${DURABLE_SLOT_KEY_PREFIX}next`;
const FREE_KEY = `${DURABLE_SLOT_KEY_PREFIX}free`;
const ownerKey = (owner: string) => `${DURABLE_SLOT_KEY_PREFIX}${owner}`;

/** The facet name a durable slot number names. */
export function durableFacetName(slot: number): string {
  return `${DURABLE_FACET_NAME_PREFIX}${slot}`;
}

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
export async function acquireDurableFacetSlot(
  ctx: DurableObjectState,
  owner: string,
): Promise<string> {
  let minted = false;
  const slot = await ctx.storage.transaction(async (txn) => {
    const held = await txn.get(ownerKey(owner));
    if (typeof held === 'number') return held;
    const free = await txn.get(FREE_KEY);
    const freeList = Array.isArray(free) ? free.filter((n): n is number => typeof n === 'number') : [];
    if (freeList.length > 0) {
      freeList.sort((a, b) => a - b);
      const reused = freeList.shift()!;
      await txn.put(FREE_KEY, freeList);
      await txn.put(ownerKey(owner), reused);
      return reused;
    }
    const next = await txn.get(NEXT_KEY);
    const slot = typeof next === 'number' ? next : 0;
    await txn.put(NEXT_KEY, slot + 1);
    await txn.put(ownerKey(owner), slot);
    minted = true;
    return slot;
  });
  if (minted) {
    // The ledger counts EVERY name ever minted on this DO; the durable slot
    // number alone is not that count (proc-slot names share the budget), so
    // the record is the adopted total advanced by one — never an undercount.
    recordFacetNameMinted(ctx, await facetNameCountDurable(ctx) + 1);
  }
  return durableFacetName(slot);
}

/**
 * Hand the owner's slot back to the free list and drop its pin — the last
 * step of explicit removal, after the facet's SQLite is already gone. Answers
 * the freed name, or null when the owner held nothing.
 */
export async function freeDurableFacetSlot(
  ctx: DurableObjectState,
  owner: string,
  beforeFree?: (name: string) => void,
): Promise<string | null> {
  return ctx.storage.transaction(async (txn) => {
    const held = await txn.get(ownerKey(owner));
    if (typeof held !== 'number') return null;
    beforeFree?.(durableFacetName(held));
    await txn.delete(ownerKey(owner));
    const free = await txn.get(FREE_KEY);
    const freeList = Array.isArray(free) ? free.filter((n): n is number => typeof n === 'number') : [];
    freeList.push(held);
    freeList.sort((a, b) => a - b);
    await txn.put(FREE_KEY, freeList);
    return durableFacetName(held);
  });
}
