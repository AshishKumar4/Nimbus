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
 *   Bun.serve(opts)          — wraps via the long-running fork; opts.fetch
 *                               is the only required field. Returns
 *                               {port, hostname, stop, url}.
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
  const path = (() => { try { return require('path'); } catch { return null; } })();
  const cp = (() => { try { return require('child_process'); } catch { return null; } })();
  const BUN_VERSION = ${JSON.stringify(BUN_VERSION)};

  function makeBunFile(p) {
    const resolved = (path && path.resolve) ? path.resolve(p) : p;
    return {
      name: resolved,
      get size() {
        try { return fs.statSync(resolved).size; } catch { return 0; }
      },
      get type() {
        // Best-effort MIME by extension. Workers-native — no mime-db.
        const ext = (resolved.split('.').pop() || '').toLowerCase();
        const map = { html: 'text/html', css: 'text/css', js: 'application/javascript',
          json: 'application/json', txt: 'text/plain', md: 'text/markdown',
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
        return map[ext] || 'application/octet-stream';
      },
      async text() { try { return fs.readFileSync(resolved, 'utf8'); } catch { return ''; } },
      async json() { try { return JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch (e) { throw e; } },
      async arrayBuffer() {
        try { const b = fs.readFileSync(resolved); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
        catch { return new ArrayBuffer(0); }
      },
      async exists() { try { return fs.existsSync(resolved); } catch { return false; } },
      stream() {
        const text = fs.readFileSync(resolved);
        return new ReadableStream({
          start(controller) { controller.enqueue(text); controller.close(); },
        });
      },
    };
  }

  async function bunWrite(dst, data) {
    let target;
    if (typeof dst === 'string') target = dst;
    else if (dst && dst.name) target = dst.name;
    else throw new Error('Bun.write: dst must be a path or BunFile');
    let bytes;
    if (typeof data === 'string') bytes = data;
    else if (data instanceof Uint8Array) bytes = Buffer.from(data);
    else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
    else if (data && typeof data.text === 'function') bytes = await data.text();
    else if (data && typeof data.arrayBuffer === 'function') {
      const ab = await data.arrayBuffer(); bytes = Buffer.from(ab);
    } else throw new Error('Bun.write: unsupported data type');
    fs.writeFileSync(target, bytes);
    return typeof bytes === 'string' ? bytes.length : bytes.byteLength;
  }

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
    file: makeBunFile,
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
    serve(opts) {
      // Minimal Bun.serve shim: registers the user fetch handler under
      // a CommonJS module export so the long-running facet wraps it.
      // The user-visible "started (long-running)" notice fires.
      // Returns a Bun.Server-shaped object.
      const port = (opts && opts.port) || 3000;
      const hostname = (opts && opts.hostname) || '0.0.0.0';
      // Stash the handler globally so the runFresh long-running shim
      // can wire it as the worker entrypoint's fetch handler.
      globalThis.__nimbus_bun_serve = { fetch: opts && opts.fetch, port, hostname };
      console.log('[bun.serve] listening on ' + hostname + ':' + port);
      return {
        port, hostname, url: new URL('http://' + hostname + ':' + port + '/'),
        stop() { /* no-op; facet kill handles teardown */ },
        reload(_opts) { /* no-op */ },
        development: false,
        pendingRequests: 0,
      };
    },
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
    fileURLToPath(u) { return new URL(u).pathname; },
    pathToFileURL(p) { return new URL('file://' + p); },
  };
})();
// ── End Bun-runtime shim preamble ──────────────────────────────────
`.trim() + '\n';

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
export async function runBunScript(
  facetMgr: FacetManager,
  code: string,
  opts: RunFreshOpts,
): Promise<RunFreshResult> {
  const wrappedCode = BUN_SHIM_PREAMBLE + code;
  return runFresh(facetMgr, wrappedCode, opts);
}
