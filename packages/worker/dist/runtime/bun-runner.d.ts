/**
 * bun-runner.ts — Always-fresh-isolate dispatch for `bun`.
 *
 * Built on the same architecture as src/runtime/node-runner.ts: every
 * `bun X` invocation runs in a fresh Worker Loader isolate. The
 * dispatcher delegates to `runFresh` (in node-runner.ts) which uses
 * `facetMgr.exec` (short scripts) or `facetMgr.spawn` (--watch /
 * --inspect / --inspect-brk).
 *
 * What's bun-specific
 * ───────────────────
 * Before executing the user's script, we PREPEND a `Bun` global
 * shim object that maps the most common Bun APIs onto Workers /
 * Cloudflare-native equivalents:
 *
 *   Bun.serve(opts)          — stub that throws "not implemented"; use
 *                               node:http or a Worker fetch handler.
 *   Bun.file(path)           — VFS-backed BunFile {text, json, exists,
 *                               arrayBuffer, size, type}.
 *   Bun.write(dst, data)     — VFS write, accepts string|Uint8Array|
 *                               Response|BunFile|Blob.
 *   Bun.spawn(cmd, opts)     — node:child_process.spawn under the hood
 *                               (via the supervisor's cp-spawn pool).
 *   Bun.password.hash/verify — Web Crypto SHA-256 + PBKDF2-style
 *                               salt-or-bcrypt-compat surface.
 *   Bun.gunzip(bytes)        — DecompressionStream('gzip') wrapper.
 *   Bun.sql(connStr)         — stub that throws "not implemented in
 *                               Cloudflare Workers; use D1/Hyperdrive".
 *   Bun.S3                   — stub that throws "not implemented; use
 *                               R2 binding".
 *   Bun.argv                 — process.argv.
 *   Bun.env                  — process.env.
 *   Bun.version              — string (matches BUN_VERSION constant).
 *
 * Anti-requirements observed (mirrors node-runner.ts):
 *   - NO setTimeout / sleep on hot paths.
 *   - NO content-sniffing heuristic.
 *   - Hard-fail on missing env.LOADER (via runFresh).
 */
import type { FacetManager } from '../facets/manager.js';
import { type RunFreshResult, type RunFreshOpts } from './node-runner.js';
/** Bun version string surfaced via `bun --version` and `Bun.version`. */
export declare const BUN_VERSION = "1.1.42";
/**
 * Source code injected at the top of every `bun` script. Defines the
 * `Bun` global with the documented shims. Self-contained — no external
 * imports beyond what the loader isolate already has (web-API-native
 * crypto, fetch, ReadableStream, DecompressionStream, …).
 *
 * Kept as a single string constant so it can be prepended to user code
 * without esbuild gymnastics.
 */
export declare const BUN_SHIM_PREAMBLE: string;
/**
 * Run a bun script with the Bun shim preamble prepended.
 *
 * The user's `code` is wrapped:
 *   <BUN_SHIM_PREAMBLE>;
 *   <user code>
 *
 * Routing follows runFresh: argv flags --watch / --inspect /
 * --inspect-brk → long-running fork; otherwise short fresh-isolate.
 */
export declare function runBunScript(facetMgr: FacetManager, code: string, opts: RunFreshOpts): Promise<RunFreshResult>;
//# sourceMappingURL=bun-runner.d.ts.map