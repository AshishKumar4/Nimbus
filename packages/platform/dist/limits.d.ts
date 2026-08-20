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
export declare const MAX_RPC_SAFE_PAYLOAD_BYTES: number;
export declare const SUPERVISOR_HEAP_CEILING_BYTES: number;
export declare const SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES: number;
export declare const SUPERVISOR_READ_RESERVE_BYTES: number;
export declare const MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES: number;
export declare const PRE_BUNDLE_SLICE_CAP_BYTES: number;
export declare const PRE_BUNDLE_CONCURRENCY = 1;
//# sourceMappingURL=limits.d.ts.map