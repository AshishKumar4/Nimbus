/**
 * constants.ts — Single source of truth for all Nimbus configuration.
 */
// ── Versions ────────────────────────────────────────────────────────────
export const NIMBUS_VERSION = '2.0.0';
//
// Node version reported by Nimbus's node-shim layer (process.version,
// process.versions.node). Bumped from v20.0.0 → v22.19.0 (Node 22 LTS
// "Jod") because Node 20 fell out of support upstream and several
// scaffolders (create-astro is the canonical example) refuse to run on
// majors < 22 with the literal preflight:
//
//     const currentVersion = process.versions.node;
//     const requiredMajorVersion = Number.parseInt(currentVersion.split('.')[0], 10);
//     if (requiredMajorVersion < minimumMajorVersion /* 22 */) {
//       console.error('Node.js v' + currentVersion + ' is out-of-date');
//       process.exit(1);
//     }
//
// The version is a fingerprint, not a feature claim. Node 22-only APIs
// that user code may touch:
//   - util.styleText      → shimmed (primitives wave, see node-shims.ts)
//   - util.parseEnv       → unshimmed; throws clear ENOENT-style Error
//                           (verified non-breaking for the framework
//                           probes — none of remix/nuxt/astro/sveltekit/
//                           markflow scaffold reach it during create or
//                           dev-start phases)
//   - import.meta.dirname → ESM-only, mirrored by Vite in dev mode
//   - WebSocket global    → already provided by workerd
//   - Promise.withResolvers / Object.groupBy / Map.groupBy → V8 builtins,
//                           already available in workerd's V8 runtime
//
// ABI numbers (v8, modules) are mostly cosmetic but mirrored to Node 22
// for fingerprint consistency. v8 12.4 ships with Node 22.x; modules
// (NODE_MODULE_VERSION) is 127 for the v22 line.
export const NODE_VERSION = 'v22.19.0';
export const NODE_VERSIONS = { node: '22.19.0', v8: '12.4.254.21', modules: '127' };
export const ESBUILD_VERSION = '0.24.2';
//
// sql.js (Emscripten SQLite) version, backing the node:sqlite shim. The
// JS glue (~46 KiB) lives in the worker bundle as a string constant
// (sqlite-wasm-bundle.generated.ts); the wasm binary (~648 KiB) is staged
// to public/_assets/sqljs-<version>.wasm and fetched on demand by
// runtime/sqlite-wasm-bytes.ts, then handed to the facet via the Worker
// Loader module map (request-time WebAssembly.compile is blocked).
export const SQLJS_VERSION = '1.14.1';
// opencode-ai version whose Nimbus JS artifact is staged in
// public/_assets/opencode-<version>.js. `npm install opencode-ai` is a
// native-shard package (bin/opencode.exe + 12 platform optionalDependencies);
// the install policy maps it to this prebuilt JS bundle instead of the native
// launcher. Staged by scripts/bundle-opencode.mjs; fetched on demand by
// runtime/opencode-artifact.ts and served as the package's `opencode` bin.
export const OPENCODE_VERSION = '1.16.2';
// ── VFS Constants ───────────────────────────────────────────────────────
export const CHUNK_SIZE = 65_536; // 64KB per content chunk
export const LRU_MAX_ENTRIES = 512; // 512 × 64KB = 32MB hot cache
export const BATCH_SIZE = 64; // rows per batch INSERT
export const VFS_CAPACITY = 10 * 1024 * 1024 * 1024; // 10 GB
export const MAX_TX_BLOB_BYTES = 1 * 1024 * 1024;
export const MAX_TX_LOGICAL_ROWS = 256;
export const MAX_TX_SQL_EXECS = 64;
export const MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES = 8 * 1024 * 1024;
// Largest byte payload Nimbus sends through an ordinary Workers RPC value.
// The platform limit is 32 MiB; 28 MiB leaves room for structured-clone
// metadata and matches the proven on-demand facet transfer envelope.
export const MAX_RPC_SAFE_PAYLOAD_BYTES = 28 * 1024 * 1024;
// ── Vite Dev Server Constants ───────────────────────────────────────────
// In-memory transformed-module cache cap. Transformed user modules and
// /@modules/ bundles are also persisted (SQLite) — this LRU is just the
// hot in-isolate tier, bounded so a large project can't grow it without
// limit. Persistent caches back any eviction at near-zero cost.
export const VITE_MODULE_CACHE_MAX_ENTRIES = 1024;
// Max bytes shipped to a facet for one on-demand /@modules/ bundle. Also
// the supervisor-resident slice ceiling. 28 MiB fits under workerd's
// 32 MiB RPC arg limit (~6% structured-clone overhead) and, with the
// on-demand byte-budget gate, caps peak supervisor slice memory at one
// slice — the same envelope the install-time pre-bundler proved safe on
// shared DO isolates (concurrency=2 of max slices crashed Mossaic-scale).
export const ON_DEMAND_SLICE_CAP_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES;
// ── Facet Constants ─────────────────────────────────────────────────────
export const FACET_TIMEOUT_MS = 30_000; // 30s execution timeout
//
// W2.6a: bundle-size budget is gated on the JSON-ENCODED UTF-8 BYTE
// length of the final {bundle, manifest} payload, not on raw content
// byte sum. The dynamic worker module serializes bundle content into
// JavaScript, so workerd's per-module text-size limit applies to the
// JSON-escaped form (each `\n` / `\"` / `\u` adds bytes, plus the
// per-key string-quote overhead).
// raw → boots, 8 MiB raw → fails. Encoded as JSON that's roughly 18-25 MiB
// of module text. We target 22 MiB encoded as the hard ceiling, leaving
// ~2-3 MiB of headroom for the rest of the worker module (shims, runner
// boot code) and any minor drift in the eviction loop's accounting.
//
// facet-manager.ts:buildPrefetchBundle uses TextEncoder().encode().length
// to measure exact UTF-8 bytes (not JS string .length, which counts UTF-16
// code units and undercounts non-ASCII content).
//
// The raw file/byte caps bound optional snapshot enrichment only. The
// statically-proven require closure is uncapped and oversized closures are
// partitioned into side modules, each below BUNDLE_MAX_ENCODED_BYTES.
// VFS_BUNDLE_MAX_DEPTH was dropped because the static walker is bounded by
// the require graph itself; the manifest pass has its own depth limit.
export const VFS_BUNDLE_MAX_FILES = 4000;
export const VFS_BUNDLE_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB raw
export const BUNDLE_MAX_ENCODED_BYTES = 22 * 1024 * 1024; // 22 MiB JSON-encoded UTF-8
// ── npm Constants ───────────────────────────────────────────────────────
export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_CONCURRENCY = 12;
export const NPM_DECOMPRESS_TIMEOUT = 15_000;
export const PRE_BUNDLE_SLICE_CAP_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES;
export const PRE_BUNDLE_CONCURRENCY = 1;
// ── Dev Server Constants ────────────────────────────────────────────────
export const DEFAULT_VITE_PORT = 5173;
export const DEFAULT_PREVIEW_BASE = '/preview';
export const DEFAULT_WORKER_BASE = '/worker';
export const WRANGLER_DEBOUNCE_MS = 250;
// ── Session AI gateway ──────────────────────────────────────────────────
//
// The loopback port on which the supervisor serves the session's
// OpenAI-compatible inference endpoint (src/session/ai.ts). Deliberately
// outside the range users reach for when starting a dev server, and served
// only on loopback — it is never registered in the PortRegistry, so it is
// unreachable through /port/<n> or a shareable preview hostname.
export const NIMBUS_AI_GATEWAY_PORT = 8790;
// ── Compatibility ───────────────────────────────────────────────────────
export const CF_COMPAT_DATE = '2026-04-01';
// ── Supervisor heap budget [C'.1] ───────────────────────────────────────
//
// The supervisor isolate's 128 MiB workerd cap is a HARD platform ceiling
// (per docs/research/cf-primitives-dossier.md §6 invariant I1 — 128 MiB
// per V8 isolate, may be shared across same-class peer DOs co-tenanting in
// one process). Nimbus targets HALF of that as a self-imposed soft ceiling
// so the supervisor always has runway when workerd LRU-evicts neighbours
// or AIR (Asynchronous Isolate Recreation) folds growing isolates.
//
// 64 MiB is a budget, not a measurement. Every supervisor allocation
// site is accounted for in src/observability/heap-estimate.ts which sums
// known contributors: the supervisor baseline, VFS LRU and in-flight
// writes, pre-bundle slices, and streaming RPC buffers.
export const SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;
// Shared allowance for transient allocations in the supervisor DO. With the
// VFS LRU shrunk to 8 MiB during an active reservation, 40 MiB of admitted
// payload plus the 9 MiB bundle baseline stays below the 64 MiB soft ceiling
// with 7 MiB left for metadata, structured-clone overhead, and runtime state.
// This is 31.25% of the platform's 128 MiB hard isolate ceiling.
export const SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES = 40 * 1024 * 1024;
// ── OS Defaults ─────────────────────────────────────────────────────────
export const DEFAULT_HOSTNAME = 'nimbus';
export const DEFAULT_HOME = '/home/user';
export const DEFAULT_USER = 'user';
export const DEFAULT_SHELL = '/bin/sh';
export const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin:/home/user/.gem/bin';
export const DEFAULT_MOUNT_POINTS = ['bin', 'etc', 'home', 'tmp', 'var', 'usr', 'opt'];
// ── npm packages the facet runtime provides itself ──────────────────────
//
// A package listed here is registered in node-shims' `builtins` table, so a
// facet's `require()` (and every `import` esbuild lowers into one) resolves
// to the Nimbus implementation and never reaches node_modules. Three call
// sites read this list and would otherwise drift: the shim registration, the
// `module.builtinModules` view (these are npm packages, not node core, and
// must not be reported as core), and the prefetch walker, which must not
// spend bundle bytes shipping a package it has just shadowed.
//
// undici — Node's reference fetch implementation, and a very common
// transitive dependency. It speaks HTTP over raw TCP through Node internals
// a facet does not have, and its `install()` replaces globalThis.fetch with
// an implementation that throws on first use AND drops Nimbus's in-session
// loopback routing and AI-egress mediation. See runtime/undici-shim.ts.
export const FACET_PROVIDED_PACKAGES = ['undici'];
