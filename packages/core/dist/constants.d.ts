/**
 * constants.ts — Single source of truth for all Nimbus configuration.
 *
 * Nimbus POLICY only. The measured platform limits these policies are
 * derived from (tx bounds, the RPC envelope, supervisor budgets) live in
 * `@nimbus-sh/platform/limits.js`.
 */
export declare const NIMBUS_VERSION = "2.0.0";
export declare const NODE_VERSION = "v22.19.0";
export declare const NODE_VERSIONS: {
    node: string;
    v8: string;
    modules: string;
};
export declare const ESBUILD_VERSION = "0.24.2";
export declare const SQLJS_VERSION = "1.14.1";
export declare const OPENCODE_VERSION = "1.16.2";
export declare const LRU_MAX_ENTRIES = 512;
export declare const BATCH_SIZE = 64;
export declare const VFS_CAPACITY: number;
export declare const FS_READ_BATCH_PATH_LIMIT = 1024;
export declare const FS_READ_BATCH_REQUEST_BYTES: number;
export declare const FS_LIST_PAGE_LIMIT = 8192;
/**
 * How long assembling a process's filesystem bundle may take.
 *
 * Sits under FACET_TIMEOUT_MS because it is paid BEFORE the process starts and
 * the two are sequential: a build that used the whole facet budget would leave
 * the program none. A miss on a large tree measures in low seconds, so this is
 * a bound on a defect rather than on a workload.
 */
export declare const BUNDLE_BUILD_DEADLINE_MS = 20000;
export declare const VITE_MODULE_CACHE_MAX_ENTRIES = 1024;
export declare const ON_DEMAND_SLICE_CAP_BYTES: number;
export declare const FACET_TIMEOUT_MS = 30000;
export declare const VFS_BUNDLE_MAX_FILES = 4000;
export declare const VFS_BUNDLE_MAX_BYTES: number;
export declare const BUNDLE_MAX_ENCODED_BYTES: number;
export declare const PREFETCH_CACHE_MAX_BYTES: number;
export declare const CWD_SNAPSHOT_MAX_FILE_BYTES: number;
export declare const NPM_REGISTRY = "https://registry.npmjs.org";
export declare const NPM_CONCURRENCY = 12;
export declare const NPM_DECOMPRESS_TIMEOUT = 15000;
export declare const DEFAULT_VITE_PORT = 5173;
export declare const DEFAULT_PREVIEW_BASE = "/preview";
export declare const DEFAULT_WORKER_BASE = "/worker";
export declare const WRANGLER_DEBOUNCE_MS = 250;
export declare const NIMBUS_AI_GATEWAY_PORT = 8790;
export declare const CF_COMPAT_DATE = "2026-04-01";
export declare const DEFAULT_HOSTNAME = "nimbus";
export declare const DEFAULT_HOME = "/home/user";
export declare const DEFAULT_USER = "user";
export declare const DEFAULT_SHELL = "/bin/sh";
export declare const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin:/home/user/.gem/bin";
export declare const DEFAULT_MOUNT_POINTS: string[];
export declare const FACET_PROVIDED_PACKAGES: readonly string[];
//# sourceMappingURL=constants.d.ts.map