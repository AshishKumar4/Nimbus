export const VFS_CURSOR_SEED_SOURCE = `
if (__MODULE_VFS_CURSOR) {
  globalThis.__nimbusVfsCursor = { position: __MODULE_VFS_CURSOR };
}
`;
/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body. `null` is a
 * real answer — a facet built without a VFS has no state to be coherent with —
 * and the seed above is a no-op for it.
 */
export function serializeFacetVfsCursor(cursor) {
    return JSON.stringify(cursor ?? null);
}
