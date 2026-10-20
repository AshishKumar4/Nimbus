import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
/**
 * The files in the image directories that look like a generated entry an
 * earlier release wrote, with its environment (RecipeScan): regular files
 * the kernel owns, named by a digest, in a directory the kernel owns. Each
 * is read a slice at a time, never whole, as an entry can be tens of MiB
 * (the store's own write slice: whole chunks within one storage
 * transaction). Paths are relative to the root.
 */
export declare function legacyGeneratedImages(vfs: SqliteVFS): string[];
/**
 * For a host that owns /.nimbus/facet-images whole (it writes no image of its
 * own there, and no one else in its sessions can): the generated entries
 * earlier releases left there, with their environments, removed. Answers
 * how many.
 */
export declare function removeLegacyGeneratedImages(vfs: SqliteVFS): number;
//# sourceMappingURL=legacy-images.d.ts.map