import type { FeedPosition } from '../runtime/feed-position.js';

/** The cursor a facet snapshot travels with (the namespace's position it was read at), or `null` when it has none. */
export type FacetVfsCursor = FeedPosition;

/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body (the cursor its
 * store boots at). `null` is a real answer: a facet built without a VFS has no
 * state to be coherent with.
 */
export function serializeFacetVfsCursor(cursor: FacetVfsCursor | undefined): string {
  return JSON.stringify(cursor ?? null);
}
