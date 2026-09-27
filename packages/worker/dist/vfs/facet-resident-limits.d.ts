/**
 * Bounds of the in-facet resident store (vfs/facet-resident-store.ts) that the
 * supervisor also needs.
 *
 * They live apart from the store because that module exports the store's
 * source text, FACET_RESIDENT_STORE_SOURCE (~105 KB). The facet receives that
 * text as a staged asset (scripts/bundle-node-shims.mjs), and importing a
 * constant from the store module would bundle the text into the Worker too:
 * esbuild keeps a template literal with substitutions even when nothing reads
 * it. The Worker bundle has a size gate
 * (tests/behavioral/assets-fetch/new/worker-bundle-size.mjs).
 */
/**
 * Bytes of file content in one row.
 *
 * The measured ceiling is 2,199,981 bytes in a single value (bisected, with a
 * 12-char key; the limit is on the row, so a longer path buys less). 1 MiB
 * leaves better than 2x of headroom against a limit whose exact form is not
 * contractual, and keeps the per-read allocation of a large file bounded.
 * Files at or under it — effectively all of them — are one row and one query.
 */
export declare const RESIDENT_CHUNK_BYTES = 1048576;
/**
 * What a one-shot's store may hold in its heap: the closure bound a one-shot
 * is already held to (VFS_BUNDLE_MAX_BYTES, the module map it adopts) plus
 * 16 MiB for the namespace image and the data plan. A one-shot runs in a
 * 128 MiB isolate, and today holds the same module map in its heap as a
 * table; past this budget the store degrades as the durable one does near
 * the session's limit: a fill is refused (the read is an honest miss), and an
 * own write is held within its own bound or named ENOSPC.
 */
export declare const ONE_SHOT_STORE_MEMORY_BYTES: number;
//# sourceMappingURL=facet-resident-limits.d.ts.map