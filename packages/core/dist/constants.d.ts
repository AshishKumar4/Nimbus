/**
 * constants.ts — Single source of truth for all Nimbus configuration.
 *
 * Nimbus POLICY only. The measured platform limits these policies are
 * derived from (tx bounds, the RPC envelope, supervisor budgets) live in
 * `@nimbus-sh/platform/limits.js`.
 */
export { CHUNK_SIZE, MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES, MAX_RPC_SAFE_PAYLOAD_BYTES, MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS, PRE_BUNDLE_CONCURRENCY, PRE_BUNDLE_SLICE_CAP_BYTES, SUPERVISOR_HEAP_CEILING_BYTES, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, SUPERVISOR_READ_RESERVE_BYTES, } from '@nimbus-sh/platform/limits.js';
export declare const NIMBUS_VERSION = "2.0.0";
export declare const NODE_VERSION = "v22.22.3";
export declare const NODE_VERSIONS: {
    node: string;
    v8: string;
    modules: string;
};
/** The npm this runtime's npm answers as (`npm --version`, npm's engine check). */
export declare const NPM_VERSION = "10.0.0";
export declare const ESBUILD_VERSION = "0.24.2";
export declare const SQLJS_VERSION = "1.14.1";
export declare const OPENCODE_VERSION = "1.16.2";
export declare const LRU_MAX_ENTRIES = 512;
export declare const BATCH_SIZE = 64;
/** The storage a session holds: the limit it enforces (DO_STORAGE_LIMIT_BYTES), which statfs reports. */
export declare const VFS_CAPACITY = 10000000000;
export declare const INODE_CACHE_MAX_ENTRIES = 8192;
export declare const FS_READ_BATCH_PATH_LIMIT = 1024;
export declare const FS_READ_BATCH_REQUEST_BYTES: number;
export declare const FS_LIST_PAGE_LIMIT = 8192;
/**
 * Authority-owned directory descriptions outstanding from one process's
 * prefetch channels, and how many one batch opens: git status on Express
 * (69 directories) walks its tree in two batches of 64.
 */
export declare const DIRECTORY_PREFETCH_LIMIT = 128;
export declare const DIRECTORY_BATCH_LIMIT = 64;
/**
 * How long a run's end waits for its directory channel's last exchange:
 * past it (an earlier exchange the session never answered holds the
 * channel's turn) the run ends anyway, and what the channel still holds is
 * charged to the process's scope until its release, as an abandoned
 * answer's descriptions are. The WASI park deadline's length.
 */
export declare const DIRECTORY_END_WAIT_MS = 10000;
/**
 * How far ahead of the first request of a directory channel that has not
 * reached the session a request may be numbered: a run sends one exchange
 * at a time, and its end beside at most one unanswered, so a few is plenty;
 * a request past it is refused. It bounds what the session keeps of a
 * channel's requests in flight, live or ended.
 */
export declare const DIRECTORY_SEQUENCE_WINDOW = 8;
export declare const FS_LIST_TREE_MAX_ENTRIES: number;
export declare const MOUNT_LIST_NAME_LIMIT = 8192;
export declare const VFS_DELIVERY_RETRY_WINDOW_MS = 5000;
export declare const VFS_DELIVERY_RECEIPT_RETENTION_MS: number;
export declare const VFS_DELIVERY_TOMBSTONE_RETENTION_MS: number;
export declare const VFS_DELIVERY_TOMBSTONE_LIMIT = 65536;
export declare const VITE_MODULE_CACHE_MAX_ENTRIES = 1024;
export declare const ON_DEMAND_SLICE_CAP_BYTES: number;
export declare const VFS_BUNDLE_MAX_FILES = 4000;
export declare const VFS_BUNDLE_MAX_BYTES: number;
export declare const BUNDLE_MAX_ENCODED_BYTES: number;
export declare const PREFETCH_CACHE_MAX_BYTES: number;
export declare const TRANSFORM_STORE_MAX_BYTES: number;
export declare const TRANSFORM_STORE_MAX_ENTRY_BYTES: number;
export declare const CWD_SNAPSHOT_MAX_FILE_BYTES: number;
/**
 * Largest regular file a WASI guest holds resident: a read-only open at or
 * under this size is answered from the facet's own copy of the content (one
 * stat per open, one read per revision), a larger one is windowed through
 * the supervisor. CPython's stdlib archive (3.7 MiB) and busybox sit under it.
 */
export declare const WASI_RESIDENT_FILE_CAP_BYTES: number;
export declare const NPM_REGISTRY = "https://registry.npmjs.org";
export declare const DEFAULT_VITE_PORT = 5173;
export declare const NIMBUS_AI_GATEWAY_PORT = 8790;
export declare const CF_COMPAT_DATE = "2026-09-26";
export declare const DEFAULT_HOSTNAME = "nimbus";
/**
 * The system Nimbus presents, as uname(2) reports it: the shell's `uname`
 * and node's os (type, hostname, release, version, machine) read it. Linux,
 * since third-party install scripts gate on `uname -s`; a Linux release
 * string, which release parsers read a major version from; the machine
 * honest: the code that runs is wasm, not x86_64.
 */
export declare const SYSTEM_IDENTITY: {
    readonly sysname: "Linux";
    readonly nodename: "nimbus";
    readonly release: "6.0.0-nimbus";
    readonly version: "#1 Nimbus";
    readonly machine: "wasm";
};
/** What node reports of that system (process.platform and arch, os.platform() and arch()), and npm reads. */
export declare const NODE_SYSTEM: {
    readonly platform: "linux";
    readonly arch: "x64";
};
export declare const DEFAULT_HOME = "/home/user";
export declare const DEFAULT_USER = "user";
export declare const DEFAULT_SHELL = "/bin/sh";
/** A login's PATH: the system directories, then the user's own bins under `home`. */
export declare function defaultPath(home: string): string;
export declare const DEFAULT_PATH: string;
export declare const SEEDED_TOP_LEVEL_DIRS: string[];
export declare const GUEST_COMPAT_FLAGS: readonly string[];
export declare const FACET_PROVIDED_PACKAGE_ENTRYPOINTS: Readonly<Record<string, string>>;
export declare const FACET_PROVIDED_PACKAGES: readonly string[];
//# sourceMappingURL=constants.d.ts.map