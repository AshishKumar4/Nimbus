/**
 * limits.ts — the measured Cloudflare platform limits Nimbus is built
 * against.
 *
 * Every constant here is a fact about the platform — a hard ceiling, or a
 * measured envelope proven safe against one — rather than a Nimbus policy
 * choice. Policy constants (versions, defaults, feature bounds) live in
 * `@nimbus-sh/core/constants.js`; this table is what they are derived from.
 */

// ── Storage-transaction bounds ──────────────────────────────────────────
//
// The platform resets a Durable Object over what ONE TURN has outstanding
// in storage ("Internal error in Durable Object storage caused object to
// be reset"), not over what it eventually writes. These bounds keep any
// one transaction below that wall.

/**
 * The storage/wire chunk quantum: bytes per content chunk in the SQLite
 * VFS schema, and therefore the unit every transaction bound and streamed
 * write frame is denominated in. SQLite's per-ROW value cap is 2 MB (key
 * length included, measured single-value ceiling 2,199,981 B), so 64 KiB
 * keeps a chunk row far under it while amortizing per-row overhead.
 */
export const CHUNK_SIZE = 65_536;

export const MAX_TX_BLOB_BYTES = 1 * 1024 * 1024;
export const MAX_TX_LOGICAL_ROWS = 256;
export const MAX_TX_SQL_EXECS = 64;

// ── RPC payload envelope ────────────────────────────────────────────────

// Largest byte payload Nimbus sends through an ordinary Workers RPC value.
// The platform limit is 32 MiB; 28 MiB leaves room for structured-clone
// metadata and matches the proven on-demand facet transfer envelope.
export const MAX_RPC_SAFE_PAYLOAD_BYTES = 28 * 1024 * 1024;

// ── Supervisor heap budget [C'.1] ───────────────────────────────────────
//
// Three distinct memory regimes, not one shared pool:
//
//   - Supervisor DO isolate: 128 MiB HARD platform ceiling ("Each isolate
//     can consume up to 128 MB of memory" —
//     https://developers.cloudflare.com/workers/platform/limits/).
//   - Facets: ~208-256 MiB EACH, measured — memory independent of the
//     supervisor and of each other (1,664 MiB live across 8 facets +
//     parent) but CPU SHARED across the actor thread. See
//     packages/fabric/src/process-fabric.ts.
//   - Peer DOs: independent memory AND CPU budgets, measured 1.2 GiB
//     live across 8 peers.
//
// Nimbus targets HALF of the supervisor's 128 MiB as a self-imposed soft
// ceiling so the supervisor always has runway when workerd LRU-evicts
// neighbours or AIR (Asynchronous Isolate Recreation) folds growing
// isolates.
//
// 64 MiB is a soft admission budget, not a measurement — the right value
// is unmeasured — and nothing enforces it directly.
// heap-estimate.ts sums the INSTRUMENTED contributors —
// the supervisor baseline, VFS LRU and in-flight writes, pre-bundle
// slices, streaming RPC buffers, and the prefetch-bundle build lease and
// cache gauge — which is a lower bound, not full coverage; allocation
// sites known to be missing are listed in HEAP_BLIND_SPOTS. Read a low
// percentOfCeiling accordingly.
export const SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;

// Shared allowance for transient allocations in the supervisor DO. With the
// VFS LRU shrunk to 8 MiB during an active reservation, 40 MiB of admitted
// payload plus the 9 MiB bundle baseline stays below the 64 MiB soft ceiling
// with 7 MiB left for metadata, structured-clone overhead, and runtime state.
// This is 31.25% of the platform's 128 MiB hard isolate ceiling.
export const SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES = 40 * 1024 * 1024;

// Reserved slice of that allowance for chunk-sized filesystem reads, so a
// read is never queued behind a multi-megabyte owner for a wait that has
// nothing to do with its own cost. A read only draws on this when the shared
// budget is already contended — which is exactly when the VFS LRU is shrunk
// to 8 MiB — so peak accounting is 40 + 1 admitted, 8 LRU, 9 bundle baseline:
// 58 MiB, still under the 64 MiB soft ceiling.
//
// 1 MiB is 16 concurrent READ_STREAM_CHUNK_BYTES reads. The point is not
// depth, it is that a read loop keeps moving while a heavy owner works
// instead of stopping dead for the duration.
export const SUPERVISOR_READ_RESERVE_BYTES = 1024 * 1024;

// Global bound on supervisor-resident write-stream credit, shared by every
// concurrent streamed bulk write into one DO. Part of the same supervisor
// budget arithmetic as the allocation budget above.
export const MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES = 8 * 1024 * 1024;

// ── Pre-bundle admission envelope ───────────────────────────────────────
//
// The proven-safe envelope for shipping module slices through a shared DO
// isolate: one slice at the RPC envelope at a time. Measured the hard way —
// concurrency=2 of max slices crashed Mossaic-scale installs on shared DO
// isolates. The heap estimator's pre-bundle lane models exactly this bound.
export const PRE_BUNDLE_SLICE_CAP_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES;
export const PRE_BUNDLE_CONCURRENCY = 1;
