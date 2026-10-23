/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body (the cursor its
 * store boots at). `null` is a real answer: a facet built without a VFS has no
 * state to be coherent with.
 */
export function serializeFacetVfsCursor(cursor) {
    return JSON.stringify(cursor ?? null);
}
