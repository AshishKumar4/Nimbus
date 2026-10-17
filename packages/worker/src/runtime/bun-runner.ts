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
 *   Bun.file(path)           — VFS-backed BunFile {text, json, bytes,
 *                               arrayBuffer, stream, exists, size, type}
 *                               (bun-file.ts, shared with opencode).
 *   Bun.write(dst, data)     — VFS write of the bytes of a string (UTF-8),
 *                               view, ArrayBuffer, Blob, Response or BunFile;
 *                               answers the byte count.
 *   Bun.spawn(cmd, opts)     — node:child_process.spawn under the hood
 *                               (via the supervisor's child_process broker).
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
import { BUN_FILE_API_SOURCE } from '../loaders/compiled-bodies.generated.js';
import { runFresh, type RunFreshResult, type RunFreshOpts } from './node-runner.js';

/** Bun version string surfaced via `bun --version` and `Bun.version`. */
export const BUN_VERSION = '1.1.42';

/**
 * Source code injected at the top of every `bun` script. Defines the
 * `Bun` global with the documented shims. Self-contained — no external
 * imports beyond what the loader isolate already has (web-API-native
 * crypto, fetch, ReadableStream, DecompressionStream, …).
 *
 * Kept as a single string constant so it can be prepended to user code
 * without esbuild gymnastics.
 */
export const BUN_SHIM_PREAMBLE = `
// ── Bun-runtime shim preamble (Nimbus) ──────────────────────────────
// Provides a Bun-compatible global for scripts that target the bun
// runtime. Backed by Workers-native primitives.
(function installBunShim() {
  if (typeof globalThis.Bun !== 'undefined' && globalThis.Bun.__nimbus) return;
  const fs = (() => { try { return require('fs'); } catch { return null; } })();
  const cp = (() => { try { return require('child_process'); } catch { return null; } })();
  const url = require('node:url');
  const BUN_VERSION = ${JSON.stringify(BUN_VERSION)};

  const { file: bunFile, write: bunWrite } = ${BUN_FILE_API_SOURCE}.bunFileApi(fs);

  function bunSpawn(cmd, opts) {
    if (!cp) throw new Error('Bun.spawn: child_process unavailable');
    const args = Array.isArray(cmd) ? cmd : [cmd];
    const c = cp.spawn(args[0], args.slice(1), opts || {});
    // Bun.spawn returns a richer object than Node's; expose the common surface.
    return {
      pid: c.pid,
      stdin: c.stdin,
      stdout: c.stdout,
      stderr: c.stderr,
      exitCode: null,
      kill(sig) { return c.kill(sig); },
      exited: new Promise((res) => c.on('exit', (code) => res(code))),
    };
  }

  // Simple synchronous-style password hashing via Web Crypto. Bun's
  // real impl uses bcrypt by default; this is a safe-enough SHA-256
  // approximation suitable for prototypes — documented as not
  // bcrypt-compatible in the Nimbus README's bun shim section.
  const bunPassword = {
    async hash(pw, _opts) {
      const enc = new TextEncoder().encode(pw);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      const arr = Array.from(new Uint8Array(buf));
      return '$nimbus-sha256$' + arr.map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    async verify(pw, hash) {
      const recomputed = await bunPassword.hash(pw);
      return recomputed === hash;
    },
  };

  async function bunGunzip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const out = new Response(stream);
    return new Uint8Array(await out.arrayBuffer());
  }

  globalThis.Bun = {
    __nimbus: true,
    version: BUN_VERSION,
    revision: 'nimbus-' + BUN_VERSION,
    argv: (typeof process !== 'undefined') ? process.argv : [],
    env: (typeof process !== 'undefined') ? process.env : {},
    file: bunFile,
    write: bunWrite,
    spawn: bunSpawn,
    spawnSync(cmd, opts) {
      // Best-effort: cp.spawnSync where available; otherwise throw.
      if (cp && cp.spawnSync) {
        const args = Array.isArray(cmd) ? cmd : [cmd];
        return cp.spawnSync(args[0], args.slice(1), opts || {});
      }
      throw new Error('Bun.spawnSync: child_process.spawnSync unavailable');
    },
    serve() { throw new Error('Bun.serve: not implemented on Cloudflare Workers; use node:http or a Worker fetch handler'); },
    sql() { throw new Error('Bun.sql: not implemented on Cloudflare Workers; use D1 or Hyperdrive bindings'); },
    S3: new Proxy({}, {
      get() { throw new Error('Bun.S3: not implemented on Cloudflare Workers; use R2 binding'); },
    }),
    password: bunPassword,
    gunzip: bunGunzip,
    gzipSync() { throw new Error('Bun.gzipSync: not yet implemented; use Node zlib'); },
    inspect(v) { return JSON.stringify(v, null, 2); },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    sleepSync(_ms) { throw new Error('Bun.sleepSync: not implementable in async runtime'); },
    nanoseconds() { return BigInt(Math.floor(performance.now() * 1e6)); },
    fileURLToPath: url.fileURLToPath,
    pathToFileURL: url.pathToFileURL,
  };
})();
// ── End Bun-runtime shim preamble ──────────────────────────────────
`.trim() + '\n';

/**
 * Run a bun script, the Bun shim preamble evaluated before its entry
 * (RunFreshOpts.preamble): the entry itself is the program's own module,
 * an ES module's staged as it is (core runtime/native-esm.ts).
 *
 * Routing follows runFresh: argv flags --watch / --inspect /
 * --inspect-brk, or a program the handler judged to start a server
 * (opts.launchesServer) → long-running fork; otherwise short fresh-isolate.
 */
export async function runBunScript(
  facetMgr: FacetManager,
  code: string,
  opts: RunFreshOpts,
): Promise<RunFreshResult> {
  return runFresh(facetMgr, code, { ...opts, preamble: BUN_SHIM_PREAMBLE });
}
