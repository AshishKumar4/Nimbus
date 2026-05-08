// W3.5 local integration test — exercises the generated SHIMS code
// against a fixture VFS, simulating the facet's pre-compile + require()
// flow. Bypasses wrangler dev / miniflare / WS entirely so the W3.5
// fixes can be verified in this environment (where miniflare's loopback
// WS upgrade is broken — see audit/sessions/W3.5-progress.md Phase D).
//
// What this covers:
//   - Fix A (directory-as-index): `__resolveFile` correctly falls
//     through to /index.js when base is a directory.
//   - Fix B (ESM transform): a fixture .mjs source with top-level
//     import/export gets transformed via esbuild, then loads via
//     `require()` and exposes the expected named/default exports.
//   - Fix C (silent compile surface): a syntactically broken file
//     produces a "pre-compile failed at facet startup" error instead
//     of "file was not pre-bundled".
//
// What this does NOT cover (deferred to prod):
//   - Full npm install pipeline (jsdom, fastify, redis).
//   - Real workerd CSP eval rejection at request time.
//   - Manifest / bundle-cap eviction interaction with the ESM transform.
//
// Run: bun audit/probes/w3.5/_local/integration-shim-eval.mjs

import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';

const code = generateShimsCode();

// Build a synthetic facet: emulate facet-manager.ts's preamble that wraps
// the SHIMS in a function with __vfsBundle, __vfsWrites, __vfsDirs,
// __compiledModules, __compileFailures, plus the "real-node-imports"
// minimum (process, console, Buffer, etc.).
//
// We don't need every shim to work — just the require path. So we strip
// the SHIMS' references to forward-only modules (workerd-only).
function makeFacet(bundle, dirs, writes = {}) {
  // Pre-compile the bundle the way facet-manager.ts:206-208 does (with
  // Fix C: failures recorded into __compileFailures).
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

  // Materialize the SHIMS in a Function scope. Provide stubs for the
  // forward-only modules that workerd would expose (we don't actually
  // call them from this harness's flow).
  const stub = new Proxy({}, { get: () => () => {} });
  // Some forward shims read .promises / .constants — provide a dummy
  // object that returns more proxies on access.
  function makeStub() {
    return new Proxy(function () {}, {
      get: () => makeStub(),
      apply: () => makeStub(),
    });
  }

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

    return { __require, __resolveFile, __pathIsFile, __fileExists, __compileFailures };
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

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS', label); pass++; }
  else { console.log('FAIL', label, detail || ''); fail++; }
}

// ── Test 1: Fix A — directory-as-index for fastify-style require ────────
{
  const bundle = {
    'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),
    'home/user/app/script.js':
      "const m = require('./ret/dist/types');\n" +
      "module.exports = { type: typeof m, val: m && m.kind };\n",
    'home/user/app/ret/dist/types/index.js':
      "module.exports = { kind: 'directory-fallback' };\n",
    'home/user/app/ret/package.json': JSON.stringify({ name: 'ret', version: '1.0.0' }),
  };
  const dirs = {
    'home/user/app': true,
    'home/user/app/ret': true,
    'home/user/app/ret/dist': true,
    'home/user/app/ret/dist/types': true,
  };
  try {
    const facet = makeFacet(bundle, dirs);
    // The require traversal will use __require with cwd as dirname.
    const result = facet.__require('./script');
    check('directory-as-index resolves to /index.js',
      result && result.type === 'object' && result.val === 'directory-fallback',
      JSON.stringify(result));
  } catch (e) {
    check('directory-as-index resolves to /index.js', false, e && e.message);
  }
}

// ── Test 2: Fix B — ESM transformed pre-bundle loads via require ────────
// Simulates buildPrefetchBundle's transform pass: we invoke esbuild ourselves
// (since the harness doesn't run buildPrefetchBundle), pass the transformed
// code into the bundle, and verify __compiledModules picks it up.
{
  const esbuildWasm = await import('esbuild-wasm');
  // esbuild-wasm Node API is sync via initialize-once.
  if (!globalThis.__esbInit) {
    await esbuildWasm.initialize({});
    globalThis.__esbInit = true;
  }
  const esmSource =
    'export const greeting = "hi";\n' +
    'export function up(s) { return s.toUpperCase(); }\n' +
    'export default { kind: "esm-default" };\n';
  const t = await esbuildWasm.transform(esmSource, { loader: 'js', format: 'cjs', target: 'esnext' });

  const bundle = {
    'home/user/app/package.json': JSON.stringify({ name: 'app' }),
    'home/user/app/script.js':
      "const m = require('./esm-mod.mjs');\n" +
      "module.exports = { type: typeof m, greeting: m && m.greeting, up: m && typeof m.up === 'function' ? m.up('ok') : null, defKind: m && m.default && m.default.kind };\n",
    'home/user/app/esm-mod.mjs': t.code,
  };
  const dirs = { 'home/user/app': true };
  try {
    const facet = makeFacet(bundle, dirs);
    const result = facet.__require('./script');
    check('ESM-transformed module exports named symbols',
      result && result.greeting === 'hi' && result.up === 'OK' && result.defKind === 'esm-default',
      JSON.stringify(result));
  } catch (e) {
    check('ESM-transformed module exports named symbols', false, e && e.message);
  }
}

// ── Test 3: Fix C — broken syntax surfaces compile error ────────────────
{
  const bundle = {
    'home/user/app/package.json': JSON.stringify({ name: 'app' }),
    'home/user/app/script.js':
      "let err;\n" +
      "try { require('./broken'); } catch (e) { err = e && e.message; }\n" +
      "module.exports = { msg: err };\n",
    'home/user/app/broken.js': 'let x =\n', // SyntaxError-shaped
  };
  const dirs = { 'home/user/app': true };
  try {
    const facet = makeFacet(bundle, dirs);
    const result = facet.__require('./script');
    const msg = result && result.msg;
    const right = typeof msg === 'string'
      && /pre-compile failed at facet startup|SyntaxError|Unexpected/.test(msg)
      && !/file was not pre-bundled/.test(msg);
    check('broken-syntax module surfaces real reason', right, msg);
  } catch (e) {
    check('broken-syntax module surfaces real reason', false, e && e.message);
  }
}

console.log('');
console.log(`========== integration: ${pass} pass / ${fail} fail ==========`);
process.exit(fail > 0 ? 1 : 0);
