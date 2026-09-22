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

/**
 * Bound parameters per SQL statement on Durable Objects SQLite. Measured
 * 2026-09-21 on workerd: 100 bind, 101 fail as `too many SQL variables`
 * (a 9-row insert of 12 columns fails, 8 rows succeed). Every IN-list and
 * multi-row VALUES statement is sized from this.
 */
export const SQL_MAX_BOUND_PARAMETERS = 100;

// ── SQLite storage walls ────────────────────────────────────────────────

/**
 * Storage per SQLite-backed Durable Object: 10 decimal GB documented
 * (Workers Paid), shared by the root object, every facet beneath it, and
 * every clone — a copy-on-write clone consumes its FULL logical bytes with
 * no CoW credit. Probed window: 10.58e9 logical bytes fit, 11.6e9 failed —
 * 10 GiB (10,737,418,240) falls INSIDE that window and is not a number to
 * design to. At the wall, ordinary writes fail catchably as SQLITE_FULL
 * ('database or disk is full') while reads and DELETEs keep working, so the
 * recovery is to drain; a facet CLONE over the wall is an uncatchable reset
 * that empties the destination, so clone admission is decided BEFORE the
 * clone, with reserve.
 */
export const DO_STORAGE_LIMIT_BYTES = 10_000_000_000;

/**
 * Maximum SQL statement text per exec. Documented "100 KB"; read as binary
 * KiB because the value is SQLite's compile-time SQLITE_MAX_SQL_LENGTH
 * rather than a billing quantity (unverified reading — reached by generated
 * statements, a batched multi-VALUES insert being the realistic breach).
 */
export const SQLITE_MAX_STATEMENT_BYTES = 100 * 1024;

/**
 * Maximum bound parameters per query. The easiest cap to hit accidentally:
 * a batched insert of more than 100/columns rows in one statement breaches
 * it.
 */
export const SQLITE_MAX_BOUND_PARAMETERS = 100;

/**
 * Maximum bytes of one string, BLOB, or table ROW — the bound is per ROW,
 * key length included, not per value. The measured single-value ceiling is
 * 2,199,981 bytes, ABOVE this constant: budgeting each value against the
 * row bound is conservative and correct, budgeting a row against the value
 * ceiling is not. Writes over it fail; reads and deletes keep working.
 */
export const SQLITE_MAX_ROW_BYTES = 2_000_000;

// ── Init-gate hazard ────────────────────────────────────────────────────

/**
 * A `blockConcurrencyWhile()` callback still pending this long is
 * cancelled and the Durable Object is RESET — every event queued behind
 * the gate dies with it. Proven by probe (reset observed at 31 s against a
 * 31 s-busy neighbour; cold activations track a busy neighbour 1:1), and
 * partyserver runs `onStart()` inside the gate, so ordinary traffic can
 * reach this. Anything on that path must be bounded well below this;
 * fabric defers async reconciliation off the gate entirely (`onColdStart`).
 */
export const BLOCK_CONCURRENCY_CANCEL_MS = 30_000;

// ── Eviction window ─────────────────────────────────────────────────────

/**
 * Cadence of the alarm that keeps a session Durable Object in memory while
 * a resident process runs. The platform evicts an object after roughly ten
 * seconds with no in-flight event; a pending promise (`ctx.waitUntil`) is
 * not one, and facets die with their parent. Measured 2026-09-21 on local
 * workerd and on Cloudflare: a quiet resident process survived 8 s of
 * silence and was re-driven under a new pid namespace after 12 s.
 */
export const RESIDENT_KEEPALIVE_MS = 5_000;

/**
 * How long the keep-alive holds a session after its last client is gone.
 *
 * The keep-alive exists so a quiet process survives while its user is
 * present. Unbounded, it made every abandoned session with a dev server
 * run forever: the probe suite's cancelled runs left staging with resident
 * watchers polling `stat` at ~7.5/s in the isolate every session shares,
 * and launches that pass on a fresh Worker reset there (2026-09-22). Past
 * this grace with no attached socket and no request, the session idles
 * out as it did before the keep-alive, and the launch journal re-drives
 * the process when a client returns. Long enough for a tab reload.
 */
export const RESIDENT_KEEPALIVE_DETACHED_MS = 60_000;

// ── WebSocket attachment bound ──────────────────────────────────────────

/**
 * Bytes one hibernatable WebSocket attachment may serialize to. Verified in
 * workerd source at the pinned version (v1.20260603.1,
 * src/workerd/api/web-socket.h: `MAX_ATTACHMENT_SIZE = 1024 * 16`). The
 * bound is on the SERIALIZED bytes — workerd re-serializes on every
 * `serializeAttachment` call to check it — not on UTF-8 JSON text, so a
 * JSON-length measurement is an approximation and only the platform's own
 * refusal ("A WebSocket 'attachment' cannot be larger than 16384 bytes.")
 * is the ceiling.
 */
export const WS_ATTACHMENT_LIMIT_BYTES = 16_384;

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

// ── Resident module-map member bound ────────────────────────────────────

/**
 * Bytes ONE member of a resident process's generated module map may carry.
 *
 * Distinct from the loader's per-member platform ceiling, and much smaller,
 * because the two bound different things. The platform ceiling asks what
 * workerd will accept. This asks what the SUPERVISOR can hold while handing
 * it over: every member is read back off the image store into the
 * coordinator's own 128 MiB isolate at boot (`residentLoaderConfig`), so the
 * map's total is resident by necessity and the LARGEST member is paid for a
 * second time on top of it, as the bytes read and the string decoded from
 * them.
 *
 * Sizing the split by the platform ceiling instead is what reset the object
 * on `astro dev`: the closure packed one member at 22,673,358 bytes, whose
 * read-back cost ~68 MB beside the ~25 MB map it belonged to, and the alarm
 * turn that finished materializing the images died with "Durable Object's
 * isolate exceeded its memory limit and was reset" (measured 2026-09-21 on
 * nimbus-probe-staging). `nuxt dev` and the opencode TUI reached the same
 * wall from the inline side, as a single ~13.4 MB `worker.js`.
 *
 * 4 MiB keeps that second copy a small fraction of the map rather than a
 * multiple of it: a bundle at VFS_BUNDLE_MAX_BYTES becomes ~6 members, which
 * is a handful more images and no additional turns — the write path already
 * paces by bytes, not by member — for a read-back peak of the map plus 4 MiB
 * instead of the map plus twice its largest member.
 */
export const FACET_MODULE_MEMBER_MAX_BYTES = 4 * 1024 * 1024;
