/**
 * constants.ts — Single source of truth for all Nimbus configuration.
 */
export declare const NIMBUS_VERSION = "2.0.0";
export declare const NODE_VERSION = "v22.11.0";
export declare const NODE_VERSIONS: {
    node: string;
    v8: string;
    modules: string;
};
export declare const ESBUILD_VERSION = "0.24.2";
export declare const CHUNK_SIZE = 65536;
export declare const LRU_MAX_ENTRIES = 512;
export declare const BATCH_SIZE = 64;
export declare const VFS_CAPACITY: number;
export declare const FACET_TIMEOUT_MS = 30000;
export declare const VFS_BUNDLE_MAX_FILES = 4000;
export declare const VFS_BUNDLE_MAX_BYTES: number;
export declare const BUNDLE_MAX_ENCODED_BYTES: number;
export declare const NPM_REGISTRY = "https://registry.npmjs.org";
export declare const NPM_CONCURRENCY = 12;
export declare const NPM_DECOMPRESS_TIMEOUT = 15000;
export declare const DEFAULT_VITE_PORT = 5173;
export declare const DEFAULT_PREVIEW_BASE = "/preview";
export declare const DEFAULT_WORKER_BASE = "/worker";
export declare const WRANGLER_DEBOUNCE_MS = 250;
export declare const CF_COMPAT_DATE = "2026-04-01";
export declare const SUPERVISOR_HEAP_CEILING_BYTES: number;
export declare const DEFAULT_HOSTNAME = "nimbus";
export declare const DEFAULT_HOME = "/home/user";
export declare const DEFAULT_USER = "user";
export declare const DEFAULT_SHELL = "/bin/sh";
export declare const DEFAULT_MOUNT_POINTS: string[];
//# sourceMappingURL=constants.d.ts.map