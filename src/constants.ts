/**
 * constants.ts — Single source of truth for all Nimbus configuration.
 */

// ── Versions ────────────────────────────────────────────────────────────
export const NIMBUS_VERSION = '2.0.0';
export const NODE_VERSION = 'v20.0.0';
export const NODE_VERSIONS = { node: '20.0.0', v8: '11.0.0', modules: '115' };
export const ESBUILD_VERSION = '0.24.2';

// ── VFS Constants ───────────────────────────────────────────────────────
export const CHUNK_SIZE = 65_536;        // 64KB per content chunk
export const LRU_MAX_ENTRIES = 512;      // 512 × 64KB = 32MB hot cache
export const BATCH_SIZE = 64;            // rows per batch INSERT
export const VFS_CAPACITY = 10 * 1024 * 1024 * 1024; // 10 GB

// ── Facet Constants ─────────────────────────────────────────────────────
export const FACET_TIMEOUT_MS = 30_000;  // 30s execution timeout
//
// W2.6a: bundle-size budget is gated on the JSON-ENCODED UTF-8 BYTE
// length of the final {bundle, manifest} payload, not on raw content
// byte sum. The dynamic worker module embeds the bundle as
// `const __MODULE_VFS_BUNDLE = ${JSON.stringify(bundle)}`, so workerd's
// per-module text-size limit applies to the JSON-escaped form (each
// `\n` / `\"` / `\u` adds bytes, plus the per-key string-quote overhead).
// Empirical W2.5b sweep (audit/sections/W2.6-plan.md §2.2) showed 6 MiB
// raw → boots, 8 MiB raw → fails. Encoded as JSON that's roughly 18-25 MiB
// of module text. We target 22 MiB encoded as the hard ceiling, leaving
// ~2-3 MiB of headroom for the rest of the worker module (shims, runner
// boot code) and any minor drift in the eviction loop's accounting.
//
// facet-manager.ts:buildPrefetchBundle uses TextEncoder().encode().length
// to measure exact UTF-8 bytes (not JS string .length, which counts UTF-16
// code units and undercounts non-ASCII content).
//
// VFS_BUNDLE_MAX_BYTES (raw) is retained as a cheap pre-check so we
// don't waste cycles building a bundle that will obviously blow the
// encoded ceiling. 24 MiB raw will JSON-encode to roughly 30-50 MiB,
// so we keep the raw cap a comfortable margin under the encoded one.
// VFS_BUNDLE_MAX_FILES is retained for prefetch-side recursion safety.
// VFS_BUNDLE_MAX_DEPTH dropped — the prefetch walk is bounded by the
// require() graph itself; manifest pass uses MANIFEST_MAX_DEPTH (local
// to facet-manager.ts).
export const VFS_BUNDLE_MAX_FILES = 4000;
export const VFS_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;          // 24 MiB raw
export const BUNDLE_MAX_ENCODED_BYTES = 22 * 1024 * 1024;      // 22 MiB JSON-encoded UTF-8

// ── npm Constants ───────────────────────────────────────────────────────
export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_CONCURRENCY = 12;
export const NPM_DECOMPRESS_TIMEOUT = 15_000;

// ── Dev Server Constants ────────────────────────────────────────────────
export const DEFAULT_VITE_PORT = 5173;
export const DEFAULT_PREVIEW_BASE = '/preview';
export const DEFAULT_WORKER_BASE = '/worker';
export const WRANGLER_DEBOUNCE_MS = 250;

// ── Compatibility ───────────────────────────────────────────────────────
export const CF_COMPAT_DATE = '2026-04-01';

// ── OS Defaults ─────────────────────────────────────────────────────────
export const DEFAULT_HOSTNAME = 'nimbus';
export const DEFAULT_HOME = '/home/user';
export const DEFAULT_USER = 'user';
export const DEFAULT_SHELL = '/bin/sh';
export const DEFAULT_MOUNT_POINTS = ['bin', 'etc', 'home', 'tmp', 'var', 'usr', 'opt'];
