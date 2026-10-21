/**
 * Bounds of the in-facet resident store (vfs/resident) that the
 * supervisor also needs, apart from the store's components so that the
 * Worker, which has a size gate
 * (tests/behavioral/assets-fetch/new/worker-bundle-size.mjs), imports them
 * without the store: the facet receives the store as a staged asset
 * (scripts/bundle-node-shims.mjs).
 */
import { VFS_BUNDLE_MAX_BYTES } from '@nimbus-sh/core/constants.js';
/**
 * Bytes of file content in one row: one value of the store's key-value
 * storage (kv-tables.ts), so the size that costs least per byte to read.
 *
 * Measured on a deployed Durable Object (2026-10-20, file-engine-d4-
 * measurements.md, per-op CPU): a synchronous kv.get of a 64 KiB value costs
 * 173 µs and of a 1 MiB value 9.5 ms. A value is structured-cloned, which
 * grows faster than its size, so a 1 MiB file read whole costs less as 16
 * values of 64 KiB (2.8 ms) than as one (9.5 ms). For a 40 MiB launch: 640
 * reads, 111 ms, at 64 KiB; 40 reads, 380 ms, at 1 MiB. Fewer, larger values
 * cost more; smaller ones add a key and a call each for no saving. A launch's
 * 640 puts in one turn are inside what was measured: 2,000 unconfirmed puts
 * in one turn, ten runs, none refused. The row ceiling (8 MiB, SQLITE_TOOBIG,
 * the same in production and local workerd, 2026-10-21) is far above it.
 */
export const RESIDENT_CHUNK_BYTES = 65_536;
/**
 * What a one-shot's store may hold in its heap: the closure bound a one-shot
 * is already held to (VFS_BUNDLE_MAX_BYTES, the module map it adopts) plus
 * 16 MiB for the namespace image and the data plan. A one-shot runs in a
 * 128 MiB isolate, and today holds the same module map in its heap as a
 * table; past this budget the store degrades as the durable one does near
 * the session's limit: a fill is refused (the read is an honest miss), and an
 * own write is held within its own bound or named ENOSPC.
 */
export const ONE_SHOT_STORE_MEMORY_BYTES = VFS_BUNDLE_MAX_BYTES + 16 * 1024 * 1024;
