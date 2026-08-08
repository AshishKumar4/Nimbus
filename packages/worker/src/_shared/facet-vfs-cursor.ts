/**
 * Seed the coherence cursor the facet's staged VFS snapshot was read at.
 *
 * A facet's resident set is a cache of the supervisor's VFS, and the cursor is
 * the only thing that says WHICH state it caches. Without one the first ACQUIRE
 * carries a null epoch, and a null epoch is not a stale cursor the authority can
 * compute a delta from — it can only answer poison, "drop everything". So the
 * first async fs call in the process throws away every staged cell, and the next
 * synchronous read of any of them raises EAGAIN for content that was staged
 * correctly and never changed. Measured: pi, launched as a bin, lost all 3210
 * cells of its bundle to one `fs.promises` call and then failed reading its own
 * `dist/modes/interactive/theme/dark.json`.
 *
 * Shared source rather than a line per body: the long-running node body and the
 * staged-artifact body each hold a hand-written copy of the snapshot preamble,
 * and neither gained this seed when the one-shot body did. That drift is the
 * defect, and one definition every generator splices is what makes it
 * unrepeatable.
 *
 * Splice it AFTER `__MODULE_VFS_CURSOR` is defined and BEFORE the shims: the
 * shims read the cursor into a closure const as they evaluate, so an assignment
 * that lands later replaces an object nothing still points at.
 *
 * Where `__MODULE_VFS_CURSOR` comes from is the generator's business, and for
 * the two node bodies there is only one right answer: the invocation. Their
 * generated text is content-addressed — the one-shot body is cached on
 * hash(code + bundle + manifest), the resident body is stored as a facet image
 * named by its own digest — and a cursor carries a revision that advances on
 * every spawn and an epoch that belongs to one supervisor incarnation. Baked
 * in, it gives the same program a new image each time and hands a shared body
 * another session's epoch. So it rides the request body and the start payload
 * respectively, the same channel argv and env want. The staged-artifact body
 * is generated from a per-invocation spec that is not addressed by its bytes,
 * so there it is simply one more field of that spec.
 */
export const VFS_CURSOR_SEED_SOURCE = `
if (__MODULE_VFS_CURSOR) {
  globalThis.__nimbusVfsCursor = {
    epoch: __MODULE_VFS_CURSOR.epoch,
    rev: __MODULE_VFS_CURSOR.rev,
  };
}
`;

/** The cursor a facet snapshot travels with, or `null` when it has none. */
export interface FacetVfsCursor {
  epoch: string;
  rev: number;
}

/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body. `null` is a
 * real answer — a facet built without a VFS has no state to be coherent with —
 * and the seed above is a no-op for it.
 */
export function serializeFacetVfsCursor(cursor: FacetVfsCursor | undefined): string {
  return JSON.stringify(cursor ?? null);
}
