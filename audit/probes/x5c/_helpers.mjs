// X.5-C probe helpers — Node-side integration harness.
//
// Same approach as W3.5 _local/integration-shim-eval.mjs (when miniflare
// blocked the WS-driver suite, that pivot validated the fix end-to-end
// against a synthetic VFS). We extend the pattern with two harnesses:
//
//   1. `prefetchHarness` — exercises src/require-resolver.ts against a
//      synthetic VFS-shaped object (in-memory Map). No facets, no shims;
//      pure Node + the supervisor-side prefetcher. Runs ~5ms per case.
//
//   2. `facetHarness` — same shape as W3.5's makeFacet: materialises the
//      generated SHIMS string in `new Function` scope with a fixture
//      bundle and verifies the runtime require chain resolves correctly.
//
// Why no WS driver: per W3.5-retro §S1 + W3.5-progress.md Phase D, the
// miniflare loopback WS-upgrade bug (`SyntaxError: Unexpected end of JSON
// input` in handlePrettyErrorRequest) blocks every WS-driven probe in
// this environment. Documented and repeated across W3.5 + every X.5
// follow-up. Worktree-pinned wrangler version in this branch is the
// same one that exhibits the bug; no point retrying.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const X5C_OUT_DIR = path.join(HERE, '_results');
fs.mkdirSync(X5C_OUT_DIR, { recursive: true });

// ─── In-memory VFS shim that satisfies the SqliteVFS surface used by
//     src/require-resolver.ts (read-only). The real SqliteVFS exposes
//     ~50 methods; the prefetcher only needs `exists`, `isDirectory`,
//     `readFileString`. We track readdir support too because the greedy
//     oversample in facet-manager uses it (Fix #2). ────────────────────

export function makeVfs(files /* { path: content }, paths NO leading slash */) {
  // Build dir set + per-dir entries automatically.
  const fileMap = new Map(); // path → string
  const dirSet = new Set();
  const dirEntries = new Map(); // path → [{ name, type }]

  function addDir(p) {
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p) return;
    if (dirSet.has(p)) return;
    dirSet.add(p);
    if (!dirEntries.has(p)) dirEntries.set(p, []);
    // Recurse to parent
    const slash = p.lastIndexOf('/');
    if (slash > 0) {
      const parent = p.substring(0, slash);
      addDir(parent);
      const last = p.substring(slash + 1);
      const e = dirEntries.get(parent);
      if (!e.find(x => x.name === last)) e.push({ name: last, type: 'directory' });
    }
  }

  for (const [p, content] of Object.entries(files)) {
    const cleanP = p.replace(/^\/+/, '');
    fileMap.set(cleanP, content);
    const slash = cleanP.lastIndexOf('/');
    if (slash > 0) {
      const dir = cleanP.substring(0, slash);
      addDir(dir);
      const name = cleanP.substring(slash + 1);
      const e = dirEntries.get(dir);
      if (!e.find(x => x.name === name)) e.push({ name, type: 'file' });
    }
  }

  return {
    exists(p) {
      const k = p.replace(/^\/+/, '');
      return fileMap.has(k) || dirSet.has(k);
    },
    isDirectory(p) {
      const k = p.replace(/^\/+/, '');
      return dirSet.has(k);
    },
    readFile(p) {
      const k = p.replace(/^\/+/, '');
      const c = fileMap.get(k);
      if (c == null) throw new Error('ENOENT: ' + k);
      return new TextEncoder().encode(c);
    },
    readFileString(p) {
      const k = p.replace(/^\/+/, '');
      const c = fileMap.get(k);
      if (c == null) throw new Error('ENOENT: ' + k);
      return c;
    },
    readdir(p) {
      const k = p.replace(/^\/+/, '');
      const e = dirEntries.get(k);
      if (!e) throw new Error('ENOTDIR: ' + k);
      return e.slice();
    },
    // Used by greedyAddMainEntries' addOne which also reads:
    writeFile() { throw new Error('read-only fixture VFS'); },
    mkdir() { throw new Error('read-only fixture VFS'); },
  };
}

// Convenience: assert / report.
let _passed = 0;
let _failed = 0;
const _failures = [];

export function check(label, cond, detail) {
  if (cond) { _passed++; console.log(`  ✓ ${label}`); }
  else {
    _failed++;
    _failures.push({ label, detail });
    console.log(`  ✗ ${label}` + (detail ? `\n      ${String(detail).split('\n').join('\n      ')}` : ''));
  }
}

export function summary() {
  console.log('');
  console.log(`  ────  ${_passed} pass / ${_failed} fail`);
  if (_failed > 0) {
    console.log(`  failures:`);
    for (const f of _failures) console.log(`    - ${f.label}: ${f.detail}`);
  }
  return _failed === 0;
}

export function reset() {
  _passed = 0;
  _failed = 0;
  _failures.length = 0;
}

export function results() { return { passed: _passed, failed: _failed }; }

// ─── Facet harness: materialise SHIMS in `new Function` scope and let
//     a fixture bundle run through the runtime require chain. Mirrors
//     W3.5-_local/integration-shim-eval.mjs makeFacet — copied + minimised. ─

export function makeFacet({ bundle, dirs, writes = {}, generateShimsCode }) {
  // Pre-compile the bundle the way facet-manager.ts:206-208 does.
  const __compiledModules = new Map();
  const __compileFailures = new Map();
  for (const [p, c] of Object.entries(bundle)) {
    if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
      try {
        __compiledModules.set(p, new Function('exports', 'require', 'module', '__filename', '__dirname', c));
      } catch (e) {
        __compileFailures.set(p, e && e.message ? e.message : String(e));
      }
    }
  }

  function makeStub() {
    return new Proxy(function () {}, {
      get: () => makeStub(),
      apply: () => makeStub(),
    });
  }
  const stub = makeStub();
  const code = generateShimsCode();

  const harness = `
    const __real_fs = arguments[0]; const __real_path = arguments[1];
    const __real_os = arguments[2]; const __real_url = arguments[3];
    const __real_util = arguments[4]; const __real_stream = arguments[5];
    const __real_buffer = arguments[6]; const __real_events = arguments[7];
    const __real_querystring = arguments[8]; const __real_string_decoder = arguments[9];
    const __real_assert = arguments[10]; const __real_zlib = arguments[11];
    const __real_crypto = arguments[12]; const __real_async_hooks = arguments[13];
    const __real_diagnostics_channel = arguments[14]; const __real_repl = arguments[15];
    const __real_tls = arguments[16]; const __real_http = arguments[17];
    const __real_https = arguments[18]; const __real_http2 = arguments[19];
    const __real_dns = arguments[20]; const __real_perf_hooks = arguments[21];
    const __real_timers = arguments[22]; const __real_timersPromises = arguments[23];
    const __real_module = arguments[24]; const __real_vm = arguments[25];
    const __real_dgram = arguments[26]; const __real_v8 = arguments[27];
    const __real_console = arguments[28]; const __real_process = arguments[29];

    const argv = []; const env = {};
    const cwd = '/home/user/app'; let dirname = '/home/user/app';
    const __vfsBundle = arguments[30]; const __vfsWrites = arguments[31];
    const __vfsDirs = arguments[32];
    const __vfsManifest = {}; const __MODULE_VFS_MANIFEST = {};
    const __compiledModules = arguments[33];
    const __compileFailures = arguments[34];
    const __supervisor = null;
    let stdout = ''; let stderr = ''; let exitCode = 0;
    const __pendingIO = []; let __rpcDrops = 0;
    let __rpcDropBytes = 0; let __rpcLastError = '';
    const __onRpcDrop = () => {};
    const __failedWrites = {};

    ${code}

    return { __require, __resolveFile, __pathIsFile, __fileExists, __compileFailures, __resolveFrom, __requireFrom };
  `;
  const fn = new Function(harness);
  return fn(
    stub /*fs*/, stub /*path*/, stub /*os*/, stub /*url*/, stub /*util*/,
    stub /*stream*/, { Buffer } /*buffer*/, stub /*events*/, stub /*querystring*/,
    stub /*string_decoder*/, stub /*assert*/, stub /*zlib*/, stub /*crypto*/,
    stub /*async_hooks*/, stub /*diagnostics_channel*/, stub /*repl*/,
    stub /*tls*/, stub /*http*/, stub /*https*/, stub /*http2*/,
    stub /*dns*/, stub /*perf_hooks*/, stub /*timers*/, stub /*timers/promises*/,
    stub /*module*/, stub /*vm*/, stub /*dgram*/, stub /*v8*/,
    console, process,
    bundle, writes, dirs, __compiledModules, __compileFailures,
  );
}
