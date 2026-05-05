/**
 * facet-manager.ts — Nimbus v2.0 Facet Process Manager.
 *
 * Uses the real Cloudflare DO Facets API:
 *   1. LOADER.get(codeId, callback) — creates/reuses a warm dynamic worker
 *   2. ctx.facets.get(name, callback) — creates a child DO facet with own SQLite
 *   3. Dynamic code exports class NodeProcess extends DurableObject
 *   4. facet.run(argsJson) — RPC call to execute code
 *   5. ctx.facets.abort(name) / ctx.facets.delete(name) for lifecycle
 *
 * Fallback: If facets API is unavailable (local dev), falls back to
 * LOADER.load() + getEntrypoint().fetch() with a plain fetch handler.
 */

import { ProcessTable, type ProcessEntry } from './process-table.js';
import { generateShimsCode } from './node-shims.js';
import { getRealNodeImportsCode } from './_shared/real-node-imports.js';
import type { SqliteVFS } from './sqlite-vfs.js';
import type { PortRegistry } from './port-registry.js';
import { getCtxExports } from './ctx-exports.js';
import { prefetchForRequire } from './require-resolver.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from './oom-discriminator.js';
import { classifyError } from './oom-classify.js';
import { EsbuildService } from './esbuild-service.js';
import {
  CF_COMPAT_DATE, FACET_TIMEOUT_MS,
  VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES,
  BUNDLE_MAX_ENCODED_BYTES,
} from './constants.js';

/** Result returned from a facet execution */
export interface FacetExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Files written by the script (path → content), to be flushed back to VFS */
  vfsWrites?: Record<string, string>;
}

// ── Code generators ─────────────────────────────────────────────────────

const SHIMS = generateShimsCode();

/**
 * Static `import * as __real_X from 'node:X'` block.  Prepended to both
 * facet-code templates (NodeProcess + LOADER.load fallback) so the
 * SHIMS string can forward to workerd's real `node:*` builtins.
 * See src/_shared/real-node-imports.ts for the rationale + matrix.
 */
const REAL_NODE_IMPORTS = getRealNodeImportsCode();

/** Simple hash for deduplicating identical code across invocations. */
function hashCode(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 'code-' + (h >>> 0).toString(36);
}

// generateNpmFacetCode() removed — the legacy in-facet npm installer has been
// superseded by the supervisor-side pipeline: npm-installer.ts orchestrates,
// npm-resolver.ts handles packument + semver, npm-tarball.ts handles tarball
// fetch/extract, and npm-install-facet.ts is the small pure-fn facet body
// dispatched via NimbusFacetPool. A ~193-line dead stub used to live here;
// it was removed in Arc A Phase 1 of the refactor.

/**
 * Generate vite dev server facet code.
 * Long-running dynamic worker that serves files via SUPERVISOR RPC.
 * Transforms TS/TSX/JSX via SUPERVISOR.transform() (esbuild in supervisor).
 */
function generateViteFacetCode(root: string, basePath: string): string {
  const safeRoot = JSON.stringify(root);
  const safeBase = JSON.stringify(basePath);
  return `
const ROOT = ${safeRoot};
const BASE = ${safeBase};

const MIME = {
  '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8',
  '.mjs':'application/javascript;charset=utf-8', '.ts':'application/javascript;charset=utf-8',
  '.tsx':'application/javascript;charset=utf-8', '.jsx':'application/javascript;charset=utf-8',
  '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.txt':'text/plain;charset=utf-8',
};

const HMR_CLIENT = '<script type="module">window.addEventListener("message",e=>{if(e.data?.type==="nimbus-hmr"){if(e.data.event==="full-reload")location.reload();if(e.data.event==="css-update")document.querySelectorAll("link[rel=stylesheet]").forEach(l=>{l.href=l.href.split("?")[0]+"?t="+Date.now();})}});console.log("[nimbus-hmr] connected");</script>';

function ext(p) { const i = p.lastIndexOf('.'); return i > 0 ? p.substring(i) : ''; }
function strip(p) { return p.replace(/^\\/+/,''); }

export default {
  async fetch(request, workerEnv) {
    const sup = workerEnv?.SUPERVISOR;
    const url = new URL(request.url);
    let pathname = url.pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

    try {
      // / or /index.html → serve HTML with HMR + path rewriting
      if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = strip(ROOT + '/index.html');
        let html = sup ? await sup.readFile(htmlPath) : null;
        if (!html) return new Response('<!DOCTYPE html><html><body><h1>No index.html</h1></body></html>', { headers: {...headers, 'Content-Type': 'text/html;charset=utf-8'} });
        // Inject HMR client
        if (html.includes('</head>')) html = html.replace('</head>', HMR_CLIENT + '</head>');
        else html = HMR_CLIENT + html;
        // Rewrite absolute paths to include basePath
        if (BASE && BASE !== '/') {
          html = html.replace(/(\\s(?:src|href|action)=)(["'])(\\/((?!\\/)[^"']*))(\\2)/gi, (m,attr,q,path) => {
            if (path.startsWith(BASE+'/') || path === BASE) return m;
            return attr + q + BASE + path + q;
          });
        }
        // Detect importmap (skip bare import rewriting if present)
        const hasImportmap = html.includes('"importmap"');
        return new Response(html, { headers: {...headers, 'Content-Type': 'text/html;charset=utf-8'}, status: 200 });
      }

      // Static/transformed file serving
      const vfsPath = strip(ROOT + pathname);
      const e = ext(pathname);

      // TS/TSX/JSX → transform via SUPERVISOR.transform()
      if (e === '.ts' || e === '.tsx' || e === '.jsx') {
        let code = sup ? await sup.readFile(vfsPath) : null;
        if (!code) return new Response('Not found: ' + pathname, { status: 404, headers });
        // Detect JSX framework
        const hasPreact = code.includes('from "preact"') || code.includes("from 'preact'");
        const loader = e === '.tsx' ? 'tsx' : e === '.jsx' ? 'jsx' : 'ts';
        if (sup) {
          try {
            const result = await sup.transform(code, loader);
            if (result) code = result.code;
          } catch {}
        }
        return new Response(code, { headers: {...headers, 'Content-Type': 'application/javascript;charset=utf-8'} });
      }

      // CSS
      if (e === '.css') {
        const css = sup ? await sup.readFile(vfsPath) : null;
        if (!css) return new Response('Not found', { status: 404, headers });
        return new Response(css, { headers: {...headers, 'Content-Type': 'text/css;charset=utf-8'} });
      }

      // JS files
      if (e === '.js' || e === '.mjs') {
        const code = sup ? await sup.readFile(vfsPath) : null;
        if (!code) return new Response('Not found', { status: 404, headers });
        return new Response(code, { headers: {...headers, 'Content-Type': 'application/javascript;charset=utf-8'} });
      }

      // Other files
      if (sup) {
        const content = await sup.readFile(vfsPath);
        if (content) {
          const ct = MIME[e] || 'application/octet-stream';
          return new Response(content, { headers: {...headers, 'Content-Type': ct} });
        }
      }

      // SPA fallback
      const accept = request.headers.get('Accept') || '';
      if (!pathname.includes('.') && (accept.includes('text/html') || accept.includes('*/*'))) {
        // Recurse to serve index.html
        return this.fetch(new Request(url.origin + '/', request), workerEnv);
      }

      return new Response('Not found: ' + pathname, { status: 404, headers });
    } catch (e) {
      return new Response('Vite facet error: ' + (e?.message || e), { status: 500, headers });
    }
  }
};
`;
}

/**
 * Generate dynamic worker code with a DurableObject class.
 * This is used with LOADER.get() + ctx.facets.get() (production path).
 */
function generateFacetCode(userCode: string, vfsState: FacetVfsState): string {
  const safeCode = JSON.stringify(userCode);
  const safeBundle = JSON.stringify(vfsState.bundle);
  const safeManifest = JSON.stringify(vfsState.manifest);
  return `
import { DurableObject } from "cloudflare:workers";
${REAL_NODE_IMPORTS}

const USER_CODE = ${safeCode};
const __compiledFn = new Function(
  "exports", "require", "module", "__filename", "__dirname",
  "console", "process", "Buffer",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "global", "__args",
  USER_CODE
);

// VFS bundle + manifest + pre-compiled modules — all at module level (startup time).
// __MODULE_VFS_BUNDLE   = capped path→content (workerd module-size budget).
// __MODULE_VFS_MANIFEST = uncapped path→child-names map for directory shape
//                         (W2.5b root-cause fix — see facet-manager.ts:453).
const __MODULE_VFS_BUNDLE = ${safeBundle};
const __MODULE_VFS_MANIFEST = ${safeManifest};
const __compiledModules = new Map();
// W3.5 Fix C: stop swallowing pre-compile errors. Record the path → error
// message so __loadModule can surface the real reason (typically
// SyntaxError on ESM source) instead of the misleading "file was not
// pre-bundled" message at request time.
const __compileFailures = new Map();
for (const [__p, __c] of Object.entries(__MODULE_VFS_BUNDLE)) {
  if (__p.endsWith(".js") || __p.endsWith(".mjs") || __p.endsWith(".cjs")) {
    try {
      __compiledModules.set(__p, new Function("exports","require","module","__filename","__dirname", __c));
    } catch (__e) {
      __compileFailures.set(__p, __e && __e.message ? __e.message : String(__e));
    }
  }
}

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

export class NodeProcess extends DurableObject {
  async run(argsJson) {
    const args = JSON.parse(argsJson);
    const { argv, env, cwd: _cwd, filename, dirname } = args;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __supervisor = this.env?.SUPERVISOR || null;
    const __pendingIO = [];
    // Fix 6 orphan-detection counters: every supervisor RPC push catches
    // its own rejection (necessary for allSettled semantics), but that
    // previously swallowed the drop silently. Count them so reportExit
    // can include a summary in its tail, and the supervisor's ring
    // buffer has proof that output was lost.
    let __rpcDrops = 0;
    let __rpcDropBytes = 0;
    let __rpcLastError = "";
    const __onRpcDrop = (bytes, e) => {
      __rpcDrops++;
      __rpcDropBytes += bytes | 0;
      if (e) { __rpcLastError = (e && e.message) || String(e); }
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __vfsWrites = {};
    const __vfsDirs = {};

${SHIMS}

    // Override console AND process.stdout/stderr for live SUPERVISOR streaming
    if (__supervisor) {
      __consoleMod.log = (...a) => { const s = __utilMod.format(...a) + "\\n"; stdout += s; __pendingIO.push(__supervisor.stdout(s).catch((e) => __onRpcDrop(s.length, e))); };
      __consoleMod.error = (...a) => { const s = __utilMod.format(...a) + "\\n"; stderr += s; __pendingIO.push(__supervisor.stderr(s).catch((e) => __onRpcDrop(s.length, e))); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      // Hook process.stdout/stderr.write for live streaming (libraries use this directly)
      __processMod.stdout.write = (d) => { const s = String(d); stdout += s; __pendingIO.push(__supervisor.stdout(s).catch((e) => __onRpcDrop(s.length, e))); return true; };
      __processMod.stderr.write = (d) => { const s = String(d); stderr += s; __pendingIO.push(__supervisor.stderr(s).catch((e) => __onRpcDrop(s.length, e))); return true; };
    }

    const mod = { exports: {} };
    try {
      __compiledFn(
        mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user",
        __consoleMod, __processMod, __BufferMod,
        globalThis.setTimeout, globalThis.setInterval, globalThis.clearTimeout, globalThis.clearInterval,
        globalThis, argv || []
      );
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        // Stream the trace live so it lands in the supervisor ring buffer.
        // Without this, the error is visible only in the local 'stderr'
        // string which gets zeroed below when __supervisor is attached,
        // leaving the user with an empty prompt after a crash.
        if (__supervisor) {
          try { __pendingIO.push(__supervisor.stderr(trace + "\\n").catch((e2) => __onRpcDrop((trace || "").length + 1, e2))); } catch {}
        }
      }
    }

    // Drain microtasks
    await new Promise(r => setTimeout(r, 0));

    // Flush writes via SUPERVISOR RPC if available (live VFS writes)
    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(
          __supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; })
        );
      }
    }

    // Await all pending I/O (live stdout, writes)
    if (__pendingIO.length > 0) {
      await Promise.allSettled(__pendingIO);
    }

    // Fix 6: a second drain pass. If any setTimeout-scheduled callback
    // fired during the first allSettled and pushed more writes, they sit
    // on __pendingIO past the first drain. Yield once more, then re-settle
    // if new items arrived. Capped at one additional round so a run-away
    // setInterval can't hold the facet open forever.
    const __preSecondDrain = __pendingIO.length;
    await new Promise(r => setTimeout(r, 0));
    if (__pendingIO.length > __preSecondDrain) {
      await Promise.allSettled(__pendingIO.slice(__preSecondDrain));
    }

    // W8 BLOCKER-1 fix: parent-exit synchronous flush of any live
    // child_process children. Without this, output from spawn-and-forget
    // children (e.g., concurrently 'echo a' 'echo b' from a parent that
    // exits before its data listeners drain) gets dropped between the
    // last cpReadOutput poll and reportExit. __cpDrainAllChildren issues
    // a single cpDrainOutput RPC per live child to flush remaining
    // buffers; idempotent on already-exited children.
    try {
      if (__childProcessMod && typeof __childProcessMod.__cpDrainAllChildren === "function") {
        await __childProcessMod.__cpDrainAllChildren();
      }
    } catch (e) {
      // Best-effort. Drain failure must not block reportExit.
    }

    // Report exit AFTER I/O drains so the ring buffer has everything the
    // facet wrote before the dump fires on the supervisor side.
    //
    // Fix 6: include an orphan-drop tail in the exit report so the
    // supervisor knows how many writes (and bytes) were lost, plus the
    // last RPC error for debugging. Empty string when clean. Pid is
    // intentionally omitted — the supervisor already knows the pid
    // (it's the RPC parameter) and prepends its own banner.
    if (__supervisor) {
      let __tail = "";
      if (__rpcDrops > 0) {
        __tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
                 __rpcDropBytes + " bytes lost" +
                 (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      }
      try { await __supervisor.reportExit(exitCode, __tail); } catch {}
    }

    // Return results:
    // - When SUPERVISOR streamed output live, return empty stdout/stderr
    //   (prevents double display in the terminal)
    // - Failed writes fall back to the old vfsWrites path for supervisor-side flush
    return JSON.stringify({
      exitCode,
      stdout: __supervisor ? "" : stdout,
      stderr: __supervisor ? "" : stderr,
      vfsWrites: __supervisor ? __failedWrites : __vfsWrites,
    });
  }
}
`;
}

/**
 * Generate fallback code with a plain fetch handler.
 * Used with LOADER.load() when facets are unavailable (local dev).
 */
function generateEntrypointCode(userCode: string, vfsState: FacetVfsState): string {
  const safeCode = JSON.stringify(userCode);
  const safeBundle = JSON.stringify(vfsState.bundle);
  const safeManifest = JSON.stringify(vfsState.manifest);
  return `
${REAL_NODE_IMPORTS}

const USER_CODE = ${safeCode};
const __compiledFn = new Function(
  "exports", "require", "module", "__filename", "__dirname",
  "console", "process", "Buffer",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "global", "__args",
  USER_CODE
);

// VFS bundle + manifest + pre-compiled modules — all at module level (startup time).
// See generateFacetCode for the rationale; this is the fallback (LOADER.load)
// path used when facets API is unavailable.
const __MODULE_VFS_BUNDLE = ${safeBundle};
const __MODULE_VFS_MANIFEST = ${safeManifest};
const __compiledModules = new Map();
// W3.5 Fix C: keep this template byte-equivalent to generateFacetCode's
// pre-compile loop so __loadModule sees the same diagnostic surface.
const __compileFailures = new Map();
for (const [__p, __c] of Object.entries(__MODULE_VFS_BUNDLE)) {
  if (__p.endsWith(".js") || __p.endsWith(".mjs") || __p.endsWith(".cjs")) {
    try {
      __compiledModules.set(__p, new Function("exports","require","module","__filename","__dirname", __c));
    } catch (__e) {
      __compileFailures.set(__p, __e && __e.message ? __e.message : String(__e));
    }
  }
}

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

export default {
  async fetch(request, workerEnv) {
    const args = await request.json();
    const { argv, env, cwd: _cwd, filename, dirname } = args;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __supervisor = workerEnv?.SUPERVISOR || null;
    const __pendingIO = [];
    // Fix 6 orphan counters (same as NodeProcess.run) — count RPC writes
    // that get dropped during isolate teardown so reportExit can report them.
    let __rpcDrops = 0;
    let __rpcDropBytes = 0;
    let __rpcLastError = "";
    const __onRpcDrop = (bytes, e) => {
      __rpcDrops++;
      __rpcDropBytes += bytes | 0;
      if (e) { __rpcLastError = (e && e.message) || String(e); }
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __vfsWrites = {};
    const __vfsDirs = {};

${SHIMS}

    // Override console AND process.stdout/stderr for live SUPERVISOR streaming
    if (__supervisor) {
      __consoleMod.log = (...a) => { const s = __utilMod.format(...a) + "\\n"; stdout += s; __pendingIO.push(__supervisor.stdout(s).catch((e) => __onRpcDrop(s.length, e))); };
      __consoleMod.error = (...a) => { const s = __utilMod.format(...a) + "\\n"; stderr += s; __pendingIO.push(__supervisor.stderr(s).catch((e) => __onRpcDrop(s.length, e))); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      __processMod.stdout.write = (d) => { const s = String(d); stdout += s; __pendingIO.push(__supervisor.stdout(s).catch((e) => __onRpcDrop(s.length, e))); return true; };
      __processMod.stderr.write = (d) => { const s = String(d); stderr += s; __pendingIO.push(__supervisor.stderr(s).catch((e) => __onRpcDrop(s.length, e))); return true; };
    }

    const mod = { exports: {} };
    try {
      __compiledFn(
        mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user",
        __consoleMod, __processMod, __BufferMod,
        globalThis.setTimeout, globalThis.setInterval, globalThis.clearTimeout, globalThis.clearInterval,
        globalThis, argv || []
      );
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        if (__supervisor) {
          try { __pendingIO.push(__supervisor.stderr(trace + "\\n").catch((e2) => __onRpcDrop((trace || "").length + 1, e2))); } catch {}
        }
      }
    }

    await new Promise(r => setTimeout(r, 0));

    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
      }
    }
    if (__pendingIO.length > 0) await Promise.allSettled(__pendingIO);

    // Fix 6: second drain pass for any setTimeout-scheduled writes that
    // landed after the first allSettled. Bounded to one additional round.
    const __preSecondDrain = __pendingIO.length;
    await new Promise(r => setTimeout(r, 0));
    if (__pendingIO.length > __preSecondDrain) {
      await Promise.allSettled(__pendingIO.slice(__preSecondDrain));
    }

    // W8 BLOCKER-1 fix: parent-exit synchronous flush of child_process
    // children. See generateFacetCode for the rationale.
    try {
      if (__childProcessMod && typeof __childProcessMod.__cpDrainAllChildren === "function") {
        await __childProcessMod.__cpDrainAllChildren();
      }
    } catch (e) { /* best-effort */ }

    // Report exit after draining so the ring buffer is complete before
    // the supervisor decides whether to emit a dump. Fix 6: include an
    // orphan-drop tail if RPC writes were lost during teardown.
    if (__supervisor) {
      let __tail = "";
      if (__rpcDrops > 0) {
        __tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
                 __rpcDropBytes + " bytes lost" +
                 (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      }
      try { await __supervisor.reportExit(exitCode, __tail); } catch {}
    }

    return Response.json({
      exitCode,
      stdout: __supervisor ? "" : stdout,
      stderr: __supervisor ? "" : stderr,
      vfsWrites: __supervisor ? __failedWrites : __vfsWrites,
    });
  }
};
`;
}

// ── VFS bundler ─────────────────────────────────────────────────────────

/**
 * Result of preparing facet VFS state.
 *   - bundle:   path → utf8 content for the files reachable from the
 *               entry's require() chain plus a greedy oversample of
 *               every installed package's package.json + main entry.
 *               Content cap is on the JSON-encoded payload, not the raw
 *               byte sum (W2.6a §2.3 — workerd's per-module text-size
 *               budget applies to the JSON-stringified literal embedded
 *               in the dynamic worker module text, NOT the raw content
 *               byte sum. See audit/sections/W2.6-plan.md.)
 *
 *   - manifest: path → child names map for directory listings (uncapped,
 *               unchanged from W2.5b). Walks the SqliteVFS regardless of
 *               the content cap so that fs.readdirSync / fs.statSync(dir)
 *               inside the facet see the *true* directory shape rather
 *               than just the subset that fit in the content bundle.
 *
 * Sizing: a manifest entry is one short string per file/dir name. For
 * 1928 files / 319 dirs (fastify install) total manifest JSON is ~50 KiB
 * — three orders of magnitude smaller than the content bundle.
 */
interface FacetVfsState {
  bundle: Record<string, string>;
  manifest: Record<string, string[]>;
  /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
  reachableCount: number;
  /** Diagnostics: was the bundle truncated by the encoded-size cap? */
  truncated: boolean;
}

const MANIFEST_MAX_DEPTH = 12;

/**
 * Build the manifest pass — uncapped path→child-names map. UNCHANGED
 * from W2.5b; this is the W2.5b root-cause fix and continues to keep
 * fs.readdirSync / fs.statSync honest regardless of which subset of
 * file CONTENT we ship.
 */
function buildManifest(vfs: SqliteVFS, cwd: string): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  function walk(dirPath: string, depth = 0) {
    if (depth > MANIFEST_MAX_DEPTH) return;
    const stripped = dirPath.replace(/^\/+/, '');
    if (stripped in manifest) return;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(stripped); }
    catch { return; }
    manifest[stripped] = entries.map((e) => e.name);
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const childPath = stripped ? stripped + '/' + entry.name : entry.name;
        walk(childPath, depth + 1);
      }
    }
  }
  const cwdStripped = cwd.replace(/^\/+/, '');
  walk(cwdStripped, 0);
  const nmDir = cwdStripped + '/node_modules';
  if (vfs.exists(nmDir) && vfs.isDirectory(nmDir)) {
    walk(nmDir, 0);
  }
  return manifest;
}

/**
 * Greedy-oversample every installed package's main entry. The static
 * prefetch via require-resolver covers the require() chain literally
 * present in source; greedy oversampling adds a safety net for dynamic
 * patterns the regex misses (jest/`bindings`/`import-local` style
 * computed-path requires). Bounded to package.json + 1 main-entry file
 * per package — sub-agent §Q3 quantified the worst-case cumulative
 * budget impact (~322 KiB for fastify, ~1.7 MiB for ts-jest).
 */
function greedyAddMainEntries(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  let added = 0;
  const cwdStripped = cwd.replace(/^\/+/, '');
  const nmDir = cwdStripped + '/node_modules';
  if (!(vfs.exists(nmDir) && vfs.isDirectory(nmDir))) return { added };

  const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];

  function addOne(path: string): boolean {
    const stripped = path.replace(/^\/+/, '');
    if (stripped in bundle) return false;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return false;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return false;
    try {
      if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return false;
      const content = vfs.readFileString(stripped);
      if (budgetState.totalBytes + content.length > VFS_BUNDLE_MAX_BYTES) return false;
      bundle[stripped] = content;
      budgetState.totalBytes += content.length;
      budgetState.fileCount++;
      added++;
      return true;
    } catch { return false; }
  }

  function addPkgEntry(pkgDir: string) {
    addOne(pkgDir + '/package.json');
    let meta: any;
    try { meta = JSON.parse(vfs.readFileString(pkgDir + '/package.json')); }
    catch { meta = null; }
    const candidates = new Set<string>();
    if (meta) {
      if (typeof meta.main === 'string') candidates.add(meta.main);
      if (typeof meta.module === 'string') candidates.add(meta.module);
      const exp = meta.exports;
      if (typeof exp === 'string') candidates.add(exp);
      else if (exp && typeof exp === 'object') {
        const dot = (exp as any)['.'];
        if (typeof dot === 'string') candidates.add(dot);
        else if (dot && typeof dot === 'object') {
          for (const k of ['require', 'node', 'default', 'import']) {
            const v = (dot as any)[k];
            if (typeof v === 'string') candidates.add(v);
          }
        }
      }
    }
    if (candidates.size === 0) candidates.add('index.js');
    for (const rel of candidates) {
      const norm = rel.replace(/^\.\//, '');
      const base = pkgDir + '/' + norm;
      let landed = false;
      const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
      for (const candidate of tries) {
        if (vfs.exists(candidate.replace(/^\/+/, '')) &&
            !vfs.isDirectory(candidate.replace(/^\/+/, ''))) {
          if (addOne(candidate)) { landed = true; break; }
        }
      }
      if (landed) break;
    }
  }

  try {
    for (const pkg of vfs.readdir(nmDir)) {
      if (pkg.type !== 'directory') continue;
      const pkgDir = nmDir + '/' + pkg.name;
      if (pkg.name.startsWith('@')) {
        try {
          for (const sub of vfs.readdir(pkgDir)) {
            if (sub.type === 'directory') addPkgEntry(pkgDir + '/' + sub.name);
          }
        } catch { /* ignore */ }
      } else {
        addPkgEntry(pkgDir);
      }
    }
  } catch { /* ignore */ }
  return { added };
}

/**
 * W3.5 Fix B helper — detect ESM source by sniffing for top-level
 * `import` / `export` STATEMENTS. Identifier/property uses (`obj.import`,
 * `pkg.export`) won't match because we anchor at start-of-line / `^\s*`.
 *
 * Comment stripping is intentionally cheap: regex over `//…` and
 * `/* … *​/` blocks. Strings containing the patterns won't be touched,
 * but esbuild produces valid CJS for any input it parses, so a false
 * positive is harmless (just a wasted transform).
 *
 * Misses to be aware of:
 *   - JSX-only files with no import/export — but those wouldn't load via
 *     plain new Function anyway (loader: 'js' rejects JSX).
 *   - Files inside a "type":"module" package that don't use import/export
 *     keywords (rare; nominally CJS-shaped). Accepted limitation, called
 *     out in audit/sections/W3.5-plan.md §6.
 */
function looksLikeEsm(src: string): boolean {
  // Cheap comment strip. Not a full parser — enough to avoid the
  // common false positives ("// import X" or `/* export */`).
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // import STATEMENT: `^\s*import\s+(string|identifier|*|{)`. Skips
  // dynamic `import(...)` (which is fine in CJS).
  const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
  // export STATEMENT: `^\s*export\s+(default|{|*|let|const|var|function|class|async|type)`.
  const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
  return importStmt.test(stripped) || exportStmt.test(stripped);
}

/**
 * W3.5 Fix B — module-level cache for ESM→CJS transform results, keyed
 * by content hash. A cheap FNV-1a 32-bit hash is enough (collisions are
 * astronomically rare for the size of bundles we ship; on collision the
 * pre-compile would still succeed because the cached result is a valid
 * CJS rebuild of an equally-valid ESM input).
 *
 * Lives at module scope so warm exec invocations hit the cache without
 * paying the wasm cold-start cost again.
 */
const __esmTransformCache = new Map<string, string>();
function __cacheKey(src: string): string {
  // FNV-1a 32-bit. Only used for cache keys, NEVER for content
  // integrity. The ~30-byte string we return is a hex hash + length —
  // length disambiguates collisions across the rare 32-bit overlap.
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + src.length.toString(16);
}

/**
 * Transform every ESM-shaped file in the bundle to CJS via esbuild.
 * Mutates `bundle` in place. Errors are swallowed (the file is left as
 * ESM source); the facet's pre-compile loop will record the SyntaxError
 * into __compileFailures and __loadModule will surface it (Fix C).
 *
 * Skips:
 *   - .json (esbuild can transform but there's no payoff and it's a
 *     no-op on our pre-compile loop too).
 *   - .cjs (already CJS; transform is a wash).
 *   - files that pass the regex sniff cleanly (heuristic: no top-level
 *     import/export → CJS-shaped already).
 *
 * Returns the count of files transformed (for diagnostics).
 */
async function transformEsmInBundle(
  bundle: Record<string, string>,
  esbuild: EsbuildService,
): Promise<{ transformed: number; failed: number }> {
  let transformed = 0;
  let failed = 0;
  // Snapshot the keys first — esbuild calls await; never iterate-and-mutate.
  const candidates: string[] = [];
  for (const path of Object.keys(bundle)) {
    if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue;
    const src = bundle[path];
    if (!looksLikeEsm(src)) continue;
    candidates.push(path);
  }
  for (const path of candidates) {
    const src = bundle[path];
    const key = __cacheKey(src);
    const cached = __esmTransformCache.get(key);
    if (cached) {
      bundle[path] = cached;
      transformed++;
      continue;
    }
    try {
      const t = await esbuild.transform(src, {
        loader: 'js',
        format: 'cjs',
        target: 'esnext',
      });
      bundle[path] = t.code;
      __esmTransformCache.set(key, t.code);
      transformed++;
    } catch {
      // Leave the original ESM source. The pre-compile loop will record
      // the SyntaxError into __compileFailures (Fix C) and __loadModule
      // will surface it as "pre-compile failed at facet startup: ...".
      failed++;
    }
  }
  return { transformed, failed };
}

/**
 * W2.6a: build the prefetch bundle for FacetManager.exec.
 *
 * Replaces the legacy whole-tree-with-cap walk that pre-W2.5b shipped
 * up to 500 files / 4 MiB of node_modules content (whichever ran out
 * first) with a static reachable-set walk via require-resolver.ts. The
 * shipped bundle is now bounded by what the user's require() chain
 * actually reaches PLUS a greedy oversample of every installed pkg's
 * package.json + main entry (dynamic-require survival).
 *
 * Cap is on the JSON-encoded size of the final payload, not on raw
 * content byte sum. The dynamic worker module embeds the bundle as
 * `const __MODULE_VFS_BUNDLE = ${JSON.stringify(bundle)}`, so workerd's
 * per-module text-size limit applies to the encoded form.
 *
 * W3.5: now async to allow the optional ESM→CJS pre-pass via esbuild.
 * If `esbuild` is not provided, the pass is skipped (preserves prior
 * behaviour for code paths that don't have esbuild handy).
 *
 * See audit/sections/W2.6-plan.md §3 (B1+ verdict + sub-agent review).
 */
async function buildPrefetchBundle(
  vfs: SqliteVFS,
  scriptPath: string | undefined,
  cwd: string,
  entryCode: string,
  esbuild?: EsbuildService,
): Promise<FacetVfsState> {
  // 1. Static reachable-set walk from entry.
  const prefetch = prefetchForRequire(vfs, entryCode || '', cwd, scriptPath);
  const bundle: Record<string, string> = { ...prefetch.bundle };
  let totalBytes = 0;
  let fileCount = 0;
  for (const k of Object.keys(bundle)) {
    totalBytes += bundle[k].length;
    fileCount++;
  }
  let truncated = prefetch.truncated;

  // 2. Greedy oversample — every installed pkg's pkg.json + main.
  //    Catches dynamic-require / `bindings()` / plugin-loader cases the
  //    regex prefetch misses. Bounded by VFS_BUNDLE_MAX_BYTES.
  const budgetState = { totalBytes, fileCount };
  const greedy = greedyAddMainEntries(vfs, cwd, bundle, budgetState);
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.5 W3.5 Fix B: ESM→CJS transform pass. Walks `bundle`, sniffs each
  //     .js/.mjs for top-level import/export, runs esbuild's CJS transform
  //     on the matches, and replaces the value in-place. Without this,
  //     ESM files (e.g. tldts/dist/es6/index.js, @remix-run/react/dist/esm,
  //     @tailwindcss/vite, react-remove-scroll, astro) silently fail
  //     `new Function` at facet startup and surface as the misleading
  //     "file was not pre-bundled" at request time.
  if (esbuild) {
    try {
      await transformEsmInBundle(bundle, esbuild);
      // Recount bytes after the transform — CJS rebuilds can be larger
      // OR smaller than the ESM source. We don't try to thread totalBytes
      // through the transform because the eviction loop below recomputes
      // the encoded size from scratch anyway.
    } catch {
      // Esbuild init / dispatch failure is non-fatal: the pre-compile
      // loop will swallow the SyntaxError on each ESM file (Fix C
      // surfaces it later via __compileFailures).
    }
  }

  // 3. Manifest pass — UNCHANGED from W2.5b. Decouples directory shape
  //    from content cap so fs.readdirSync remains honest even if the
  //    content for a given file was capped out.
  const manifest = buildManifest(vfs, cwd);

  // 4. JSON-encoded-size guard. Pre-check via TextEncoder.encode().length
  //    so we measure UTF-8 bytes (not UTF-16 code units), matching what
  //    workerd accounts against the per-module text-size budget. If the
  //    bundle exceeds the encoded ceiling, evict largest non-manifest
  //    files first (manifest stays — it's needed for readdirSync) and
  //    RECOMPUTE the encoded size after every eviction (sub-agent S2:
  //    naïve `encoded -= len(file) + len(key) + 6` accumulates 2-5% drift
  //    on JS-source-heavy bundles; recomputing is O(n) per eviction but
  //    bundles past the budget are rare and the count of evictions is
  //    bounded by the size of a few large files).
  const encoder = new TextEncoder();
  let encoded = encoder.encode(JSON.stringify({ bundle, manifest })).length;
  if (encoded > BUNDLE_MAX_ENCODED_BYTES) {
    truncated = true;
    const keysBySize = Object.keys(bundle).sort((a, b) => bundle[b].length - bundle[a].length);
    for (const k of keysBySize) {
      if (encoded <= BUNDLE_MAX_ENCODED_BYTES) break;
      delete bundle[k];
      fileCount--;
      encoded = encoder.encode(JSON.stringify({ bundle, manifest })).length;
    }
  }

  // Suppress lint: `greedy.added` is observed only via diagnostics.
  void greedy;

  return { bundle, manifest, reachableCount: fileCount, truncated };
}

// ── FacetManager ────────────────────────────────────────────────────────

/**
 * Optional hooks wired in by NimbusSession. Kept as callbacks so
 * FacetManager stays unaware of the session / log-store types.
 */
export interface FacetManagerHooks {
  /**
   * Fired when a process was terminated OUTSIDE the facet's own try/
   * finally (timeout via abort, explicit kill, etc.) — the facet never
   * runs its own `reportExit`, so the session side won't hear about the
   * exit unless we call it here.
   */
  onExternalExit?: (pid: number, code: number, reason: string) => void;
  /** Fired right after processTable.spawn — lets the session print a notification. */
  onSpawn?: (pid: number, command: string, longRunning: boolean) => void;
}

export class FacetManager {
  private ctx: DurableObjectState;
  private env: any;
  private processTable: ProcessTable;
  private portRegistry: PortRegistry;
  private vfs: SqliteVFS | null = null;
  /** Track whether facets API is available (detected on first use). */
  private _hasFacets: boolean | null = null;
  private _facetLogOnce = false;
  private hooks: FacetManagerHooks;
  /**
   * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
   * over the prefetch bundle. Created on first exec where vfs is set;
   * shared across subsequent execs (warm wasm).  Optional setter
   * `setEsbuildService` lets NimbusSession share its existing instance
   * to avoid double-init.
   */
  private esbuild: EsbuildService | null = null;

  constructor(
    ctx: DurableObjectState,
    env: any,
    processTable: ProcessTable,
    portRegistry: PortRegistry,
    hooks: FacetManagerHooks = {},
  ) {
    this.ctx = ctx;
    this.env = env;
    this.processTable = processTable;
    this.portRegistry = portRegistry;
    this.hooks = hooks;
  }

  setVfs(vfs: SqliteVFS) { this.vfs = vfs; }
  /**
   * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
   * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
   * for the user-shell `node` runtime; sharing avoids paying init twice.
   */
  setEsbuildService(esbuild: EsbuildService) { this.esbuild = esbuild; }

  /**
   * Execute JS code in a facet (or fallback dynamic worker).
   *
   * Strategy:
   *   1. Try LOADER.get() + ctx.facets.get() (production: warm reuse, own SQLite)
   *   2. Fallback: LOADER.load() + getEntrypoint().fetch() (local dev)
   */
  async exec(
    code: string,
    opts: {
      argv?: string[];
      env?: Record<string, string>;
      cwd?: string;
      filename?: string;
      dirname?: string;
    },
  ): Promise<FacetExecResult> {
    const command = opts.filename && opts.filename !== '<eval>'
      ? `node ${opts.filename}` : 'node -e ...';
    this.processTable.reap();
    const entry = this.processTable.spawn(command, opts.argv || [], opts.cwd || '/home/user');
    // Short foreground `node -e ...` helpers are quiet by design — only
    // notify for user-facing `node <file>` invocations, which covers the
    // real user intent (running scripts, wrangler, etc.).
    if (opts.filename && opts.filename !== '<eval>') {
      try { this.hooks.onSpawn?.(entry.pid, command, false); } catch {}
    }

    // W3.5 Fix B: thread an EsbuildService into buildPrefetchBundle so
    // ESM source files (e.g. tldts/dist/es6/index.js, @remix-run/react,
    // @tailwindcss/vite, react-remove-scroll, astro) get transformed to
    // CJS before they hit the facet's `new Function` pre-compile loop.
    // Lazy-create one if NimbusSession didn't share its own.
    if (this.vfs && !this.esbuild) {
      try { this.esbuild = new EsbuildService(this.vfs as any); } catch { this.esbuild = null; }
    }
    const vfsState: FacetVfsState = this.vfs
      ? await buildPrefetchBundle(this.vfs, opts.filename, opts.cwd || '/home/user', code, this.esbuild || undefined)
      : { bundle: {}, manifest: {}, reachableCount: 0, truncated: false };

    try {
      let result: FacetExecResult;

      // Try facets API first (production path)
      if (this._hasFacets !== false) {
        try {
          result = await this._execWithTimeout(
            this._execViaFacets(code, opts, entry, vfsState),
            entry,
          );
          this._hasFacets = true;
          this.processTable.exit(entry.pid, result.exitCode);
          // W5 Lever 5: zero-silent-OOM contract — every non-zero exit
          // must yield a ring entry.
          if (result.exitCode !== 0) {
            this._w5RecordTermination(
              entry.pid, result.exitCode, 'facet',
              result.stderr || `exit ${result.exitCode}`,
            );
          }
          this._flushVfsWrites(result);
          return result;
        } catch (facetErr: any) {
          // Detect if it's a facets-unavailable error vs a user code error
          const isFacetApiError =
            facetErr?.message?.includes('is not a function') ||
            facetErr?.message?.includes('facets') ||
            facetErr?.message?.includes('getDurableObjectClass') ||
            facetErr?.message?.includes('not available');
          if (!isFacetApiError) {
            // User code error — don't fall back. Route through the
            // external-exit hook so the supervisor's log store records
            // the exit AND the structured {type:'exit'} notification
            // fires on the terminal WS (otherwise the tabs UI shows a
            // stuck "running" dot for facets that crash before they get
            // a chance to self-report).
            this.processTable.exit(entry.pid, 1);
            this._w5RecordTermination(
              entry.pid, 1, 'facet',
              'facet error: ' + (facetErr?.message || String(facetErr)),
            );
            try {
              this.hooks.onExternalExit?.(
                entry.pid, 1,
                'facet error: ' + (facetErr?.message || String(facetErr)),
              );
            } catch {}
            this._flushVfsWrites({ exitCode: 1, stdout: '', stderr: '', vfsWrites: {} });
            return { exitCode: 1, stdout: '', stderr: facetErr?.message || String(facetErr) };
          }
          // Mark facets as unavailable and fall through
          if (this._hasFacets === null) {
            this._hasFacets = false;
            if (!this._facetLogOnce) {
              this._facetLogOnce = true;
              console.log('[nimbus] Facets API unavailable, using LOADER.load() fallback');
            }
          }
        }
      }

      // Fallback: LOADER.load() (local dev)
      result = await this._execWithTimeout(
        this._execViaLoader(code, opts, entry, vfsState),
        entry,
      );
      this.processTable.exit(entry.pid, result.exitCode);
      if (result.exitCode !== 0) {
        this._w5RecordTermination(
          entry.pid, result.exitCode, 'facet',
          result.stderr || `exit ${result.exitCode}`,
        );
      }
      this._flushVfsWrites(result);
      return result;
    } catch (err: any) {
      // If the timeout already fired, it already called onExternalExit
      // with code 124 and reason "timeout…". Don't clobber that with a
      // generic exit code 1. (_reportExternalExit's guard separately
      // prevents double-dump; this stops ProcessTable from showing a
      // different exit code than the ring buffer's footer.)
      const timedOut = !!(entry as any).__timedOut;
      const exitCode = timedOut ? 124 : 1;
      this.processTable.exit(entry.pid, exitCode);
      // W5 Lever 5: ring entry on every catch-path exit.
      this._w5RecordTermination(
        entry.pid, exitCode,
        timedOut ? 'rpc' : 'facet',
        timedOut
          ? 'timeout'
          : ('facet error: ' + (err?.message || String(err))),
      );
      // Non-timeout failure: route through external-exit so the log
      // store marks exit AND the tabs-UI structured event fires. The
      // timeout path already called onExternalExit from the timeout
      // handler; _reportExternalExit's getExit() guard dedupes.
      if (!timedOut) {
        try {
          this.hooks.onExternalExit?.(
            entry.pid, exitCode,
            'facet error: ' + (err?.message || String(err)),
          );
        } catch {}
      }
      return { exitCode, stdout: '', stderr: err?.message || String(err) };
    }
  }

  /**
   * W5 Lever 5: push a DiagFailure into the OOM ring for every facet
   * termination with a non-zero exit code. This is the supervisor side
   * of the zero-silent-OOM contract — the audit/probes/w5/e2e/
   * oom-stress probe asserts that every termination has a matching
   * ring entry.
   *
   * Classification: parse the reason/stderr for SQLITE_NOMEM, OOM,
   * clone-refused, rpc_timeout signatures (oom-classify.ts). Code 124
   * always maps to rpc_timeout regardless of message.
   */
  private _w5RecordTermination(
    pid: number,
    exitCode: number,
    phase: string,
    reason: string,
  ): void {
    try {
      let cause = classifyError(reason);
      if (exitCode === 124 && cause === 'unknown') cause = 'rpc_timeout';
      recordFailure({
        at: Date.now(),
        phase,
        cause,
        rssEstimateBytes: 0,
        heapUsedBytes: 0,
        lruBytes: 0,
        inFlightBytes: 0,
        lastRpcFrame: getLastRpcFrame(),
        lastFacetId: getLastFacetId(),
        exitCode,
        pid,
        message: reason,
      });
    } catch (e: any) {
      // Fail-soft: telemetry must never break the exit path.
      console.warn('[facet-manager/W5] recordFailure threw:', e?.message);
    }
  }

  // ── Strategy 1: Real DO Facets (production) ───────────────────────────

  private async _execViaFacets(
    code: string,
    opts: { argv?: string[]; env?: Record<string, string>; cwd?: string; filename?: string; dirname?: string },
    entry: ProcessEntry,
    vfsState: FacetVfsState,
  ): Promise<FacetExecResult> {
    const workerCode = generateFacetCode(code, vfsState);
    // Scope the LOADER cache key to this DO. Without the doId prefix,
    // two sessions that happen to execute identical code + vfs key sets
    // share a warm isolate — and the isolate's baked-in env.SUPERVISOR
    // stub was minted against whichever DO instantiated the slot FIRST.
    // Same cross-session-slot-sharing failure mode that b225db3 fixed
    // for install-time facets in facet-pool.ts; this path wasn't covered.
    // Cache key includes manifest keys so a re-install that adds packages
    // mints a fresh isolate (otherwise the warm slot's baked-in manifest
    // would still hide newly-installed packages from readdirSync).
    const codeId = `${this.ctx.id.toString()}:${hashCode(code + JSON.stringify(Object.keys(vfsState.bundle)) + JSON.stringify(Object.keys(vfsState.manifest)))}`;

    // LOADER.get(id, callback) — creates/reuses a warm dynamic worker
    // Pass SUPERVISOR binding for facet → supervisor RPC
    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: { doId: this.ctx.id.toString(), pid: entry.pid } })
      : undefined;

    const worker = this.env.LOADER.get(codeId, async () => ({
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
      mainModule: 'runner.js',
      modules: { 'runner.js': workerCode },
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    }));

    // Get the DurableObject class from the dynamic worker
    const NodeProcessClass = worker.getDurableObjectClass('NodeProcess');

    // ctx.facets.get(name, callback) — creates a child DO with its own SQLite
    const facetName = `proc-${entry.pid}`;
    const facet = (this.ctx as any).facets.get(facetName, async () => ({
      class: NodeProcessClass,
    }));

    // RPC: call the facet's run() method (vfsBundle is embedded in the module code)
    const argsJson = JSON.stringify({
      argv: opts.argv || [],
      env: opts.env || {},
      cwd: opts.cwd || '/home/user',
      filename: opts.filename || '<eval>',
      dirname: opts.dirname || '/home/user',
    });

    // Clean up the facet (free SQLite storage) regardless of outcome.
    // AUDIT.md M3 / STABILITY-AUDIT.md M-S2 / TOP-5-NEXT.md #3 (A3):
    // prior to this, facets.delete ran only on the success branch.
    // Timeouts (via _execWithTimeout) and user-code errors (throwing
    // from facet.run) both left the ctx.facets entry and its per-facet
    // SQLite storage slot orphaned until DO hibernation. Try/finally
    // ensures cleanup for every exit path.
    try {
      const resultJson = await facet.run(argsJson);
      const result: FacetExecResult = JSON.parse(resultJson);
      return result;
    } finally {
      try { (this.ctx as any).facets.delete(facetName); } catch {}
    }
  }

  // ── Strategy 2: LOADER.load() fallback (local dev) ────────────────────

  private async _execViaLoader(
    code: string,
    opts: { argv?: string[]; env?: Record<string, string>; cwd?: string; filename?: string; dirname?: string },
    entry: ProcessEntry,
    vfsState: FacetVfsState,
  ): Promise<FacetExecResult> {
    const workerCode = generateEntrypointCode(code, vfsState);

    // Pass SUPERVISOR binding for facet → supervisor RPC
    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: { doId: this.ctx.id.toString(), pid: entry.pid } })
      : undefined;

    const worker = this.env.LOADER.load({
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
      mainModule: 'runner.js',
      modules: { 'runner.js': workerCode },
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    });

    const entrypoint = worker.getEntrypoint();
    const body = JSON.stringify({
      argv: opts.argv || [],
      env: opts.env || {},
      cwd: opts.cwd || '/home/user',
      filename: opts.filename || '<eval>',
      dirname: opts.dirname || '/home/user',
    });

    const response = await entrypoint.fetch(new Request('http://facet/run', {
      method: 'POST',
      body,
    }));
    return await response.json() as FacetExecResult;
  }

  /** Flush files written by the script back to the supervisor's VFS. */
  private _flushVfsWrites(result: FacetExecResult) {
    if (!this.vfs || !result.vfsWrites) return;
    for (const [path, content] of Object.entries(result.vfsWrites)) {
      try {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (dir && !this.vfs.exists(dir)) this.vfs.mkdir(dir, { recursive: true });
        }
        this.vfs.writeFile(path, content);
      } catch (e: any) {
        console.error('[nimbus] VFS write-back failed:', path, e?.message);
      }
    }
  }

  /** Execution timeout. */
  private async _execWithTimeout(
    promise: Promise<FacetExecResult>,
    entry: ProcessEntry,
  ): Promise<FacetExecResult> {
    let timer: any;
    let timedOut = false;
    const timeout = new Promise<FacetExecResult>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // Try to abort the facet
        try { (this.ctx as any).facets?.abort(`proc-${entry.pid}`, new Error('timeout')); } catch {}
        // The facet's `reportExit` never runs — notify the session so
        // the ring buffer gets marked and any dump fires.
        try {
          this.hooks.onExternalExit?.(
            entry.pid,
            124, // conventional timeout exit code
            `timeout after ${FACET_TIMEOUT_MS / 1000}s`,
          );
        } catch {}
        reject(new Error(`Process timed out after ${FACET_TIMEOUT_MS / 1000}s`));
      }, FACET_TIMEOUT_MS);
    });
    // Always clear the timer; otherwise a successful run would still
    // trigger the timeout callback at FACET_TIMEOUT_MS, spuriously
    // marking the exit code as 124.
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
      // Expose the flag so callers (exec's outer catch) can avoid
      // overriding the exit code that onExternalExit already stamped.
      (entry as any).__timedOut = timedOut;
    }
  }

  /**
   * Run npm install in a dedicated facet.
   * All writes go through SUPERVISOR.writeFile (live VFS),
   * progress streams via SUPERVISOR.stdout.
   */
  /**
   * Spawn a vite dev server facet.
   * Returns immediately with the facet stub for HTTP routing.
   */
  spawnVite(root: string, basePath: string = '/preview'): { pid: number; facetStub: any } {
    const code = generateViteFacetCode(root, basePath);
    return this.spawn(code, 'vite (' + root + ')', root);
  }

  /**
   * Spawn a long-running facet process.
   * Returns immediately with the process entry.
   * The facet stays alive and can handle HTTP requests via its fetch() method.
   * Used for: vite dev server, node HTTP servers, etc.
   *
   * @param workerCode The dynamic worker code (must export a default fetch handler)
   * @param command Display name for process listing
   * @returns Process entry with pid and facet stub
   */
  spawn(
    workerCode: string,
    command: string,
    cwd: string,
  ): { pid: number; facetStub: any } {
    this.processTable.reap();
    const entry = this.processTable.spawn(command, [], cwd);
    // Long-running facets (vite, nimbus-wrangler, node servers) always
    // get a spawn notification — they're visible and users want to know
    // the PID for later `logs`/`kill`.
    try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}

    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: { doId: this.ctx.id.toString(), pid: entry.pid } })
      : undefined;

    const worker = this.env.LOADER.load({
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: { 'worker.js': workerCode },
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    });

    const facetStub = worker.getEntrypoint();
    return { pid: entry.pid, facetStub };
  }

  /** Kill a running process by PID. */
  kill(pid: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state !== 'running') return false;
    try { (this.ctx as any).facets?.abort(`proc-${entry.pid}`, new Error('SIGKILL')); } catch {}
    try { (this.ctx as any).facets?.delete(`proc-${entry.pid}`); } catch {}
    this.portRegistry.unregisterByPid(pid);
    const result = this.processTable.kill(pid);
    if (result) {
      try { this.hooks.onExternalExit?.(pid, 137, 'killed'); } catch {}
    }
    return result;
  }

  get stats() { return this.processTable.stats; }
}
