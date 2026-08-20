/**
 * limits.ts — the measured Cloudflare platform limits Nimbus is built
 * against.
 *
 * Every constant here is a fact about the platform — a hard ceiling, or a
 * measured envelope proven safe against one — rather than a Nimbus policy
 * choice. Policy constants (versions, defaults, feature bounds) live in
 * `@nimbus-sh/core/constants.js`; this table is what they are derived from.
 */
/**
 * The storage/wire chunk quantum: bytes per content chunk in the SQLite
 * VFS schema, and therefore the unit every transaction bound and streamed
 * write frame is denominated in. SQLite's per-ROW value cap is 2 MB (key
 * length included, measured single-value ceiling 2,199,981 B), so 64 KiB
 * keeps a chunk row far under it while amortizing per-row overhead.
 */
export declare const CHUNK_SIZE = 65536;
export declare const MAX_TX_BLOB_BYTES: number;
export declare const MAX_TX_LOGICAL_ROWS = 256;
export declare const MAX_TX_SQL_EXECS = 64;
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
export declare const DO_STORAGE_LIMIT_BYTES = 10000000000;
/**
 * Maximum SQL statement text per exec. Documented "100 KB"; read as binary
 * KiB because the value is SQLite's compile-time SQLITE_MAX_SQL_LENGTH
 * rather than a billing quantity (unverified reading — reached by generated
 * statements, a batched multi-VALUES insert being the realistic breach).
 */
export declare const SQLITE_MAX_STATEMENT_BYTES: number;
/**
 * Maximum bound parameters per query. The easiest cap to hit accidentally:
 * a batched insert of more than 100/columns rows in one statement breaches
 * it.
 */
export declare const SQLITE_MAX_BOUND_PARAMETERS = 100;
/**
 * Maximum bytes of one string, BLOB, or table ROW — the bound is per ROW,
 * key length included, not per value. The measured single-value ceiling is
 * 2,199,981 bytes, ABOVE this constant: budgeting each value against the
 * row bound is conservative and correct, budgeting a row against the value
 * ceiling is not. Writes over it fail; reads and deletes keep working.
 */
export declare const SQLITE_MAX_ROW_BYTES = 2000000;
/**
 * A `blockConcurrencyWhile()` callback still pending this long is
 * cancelled and the Durable Object is RESET — every event queued behind
 * the gate dies with it. Proven by probe (reset observed at 31 s against a
 * 31 s-busy neighbour; cold activations track a busy neighbour 1:1), and
 * partyserver runs `onStart()` inside the gate, so ordinary traffic can
 * reach this. Anything on that path must be bounded well below this;
 * fabric defers async reconciliation off the gate entirely (`onColdStart`).
 */
export declare const BLOCK_CONCURRENCY_CANCEL_MS = 30000;
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
export declare const WS_ATTACHMENT_LIMIT_BYTES = 16384;
export declare const MAX_RPC_SAFE_PAYLOAD_BYTES: number;
export declare const SUPERVISOR_HEAP_CEILING_BYTES: number;
export declare const SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES: number;
export declare const SUPERVISOR_READ_RESERVE_BYTES: number;
export declare const MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES: number;
export declare const PRE_BUNDLE_SLICE_CAP_BYTES: number;
export declare const PRE_BUNDLE_CONCURRENCY = 1;
//# sourceMappingURL=limits.d.ts.map