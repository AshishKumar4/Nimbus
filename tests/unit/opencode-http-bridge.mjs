/**
 * opencode-http-bridge.mjs — pins the node:http builtin bridge for opencode
 * facets.
 *
 * Root cause this guards against (live-diagnosed 2026-07-16): the opencode
 * bundle's server stack (`import { createServer } from "node:http"` in the
 * srvx/hono serve chunk) is ESM, so it resolves through the facet MODULE MAP —
 * not the shims' CJS require. Without a `node:http` bridge entry the import
 * fell through to workerd's nodejs_compat http, whose Server binds invisibly:
 * "listening" printed, but the shim __portRegistry stayed empty, so the /doc
 * readiness gate (and every routed request) got the empty-registry 502 and the
 * serve facet was killed at the 20s readiness timeout — the TUI never
 * launched.
 *
 * The bridge must (a) exist in the module map for every opencode mode, and
 * (b) re-export the SHIM http surface (server-capable, registry-registering),
 * not nodejs_compat's.
 */
import assert from 'node:assert/strict';
import { opencodeBuiltinBridgeModules } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

// 1. node:http bridge present in both modes.
for (const attached of [false, true]) {
  const mods = opencodeBuiltinBridgeModules(attached);
  assert.ok(mods['node:http'], `node:http bridge missing (attached=${attached})`);
  const js = mods['node:http'].js;
  // Re-exports from the parked shim builtins global, not a nodejs_compat import.
  assert.match(js, /__nimbusOpencodeBuiltins/, 'bridge must read the shim builtins global');
  assert.doesNotMatch(js, /from\s*["']node:http["']/, 'bridge must not re-import nodejs_compat http');
  // The server surface the serve chunk needs.
  for (const name of ['createServer', 'Server', 'IncomingMessage', 'ServerResponse']) {
    assert.match(js, new RegExp(`export const ${name} `), `bridge must export ${name}`);
  }
  // Default export for esbuild interop (`import http from "node:http"`).
  assert.match(js, /export default __m/, 'bridge must have a default export');
}

// 2. The fs/os/sqlite bridges that were already load-bearing stay present.
{
  const mods = opencodeBuiltinBridgeModules(false);
  for (const spec of ['node:fs', 'node:fs/promises', 'node:os', 'node:sqlite', 'node:process']) {
    assert.ok(mods[spec], `${spec} bridge missing`);
  }
}

// 3. Executable check: evaluating the bridge against a stub builtins global
// yields the shim's functions by identity.
{
  const mods = opencodeBuiltinBridgeModules(false);
  const js = mods['node:http'].js;
  const fakeCreateServer = () => 'shim-server';
  globalThis.__nimbusOpencodeBuiltins = { http: { createServer: fakeCreateServer } };
  // Convert the ESM bridge text to an evaluable CJS-ish harness: capture the
  // exported consts by rewriting `export const X = expr;` → `out.X = expr;`.
  const body = js
    .replace(/export default __m;/, 'out.default = __m;')
    .replace(/export const (\w+) = /g, 'out.$1 = ');
  const out = {};
  new Function('out', body)(out);
  assert.equal(out.createServer, fakeCreateServer, 'bridge must re-export the shim createServer by identity');
  assert.equal(out.default.createServer, fakeCreateServer, 'default export must be the shim http object');
  delete globalThis.__nimbusOpencodeBuiltins;
}

console.log('opencode-http-bridge: ok');
