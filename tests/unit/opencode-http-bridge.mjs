/**
 * opencode-http-bridge.mjs — the builtin bridges an opencode facet's module
 * map carries, per mode.
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
 * Every mode shadows node:http/fs/os/sqlite with the shim. node:process is
 * shadowed where the shim process is the global (the resident modes), and
 * node:console only for the attached TUI, which needs the shim's Console.
 */
import assert from 'node:assert/strict';
import { opencodeBuiltinBridgeModules } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

/** Evaluate a bridge module's ESM text and return what it exports. */
function evaluateBridge(js) {
  const body = js
    .replace(/export default __m;/, 'out.default = __m;')
    .replace(/export const (\w+) = /g, 'out.$1 = ');
  const out = {};
  new Function('out', body)(out);
  return out;
}

const SHIMMED_EVERYWHERE = ['node:http', 'node:fs', 'node:fs/promises', 'node:os', 'node:sqlite'];

for (const mode of ['oneshot', 'server', 'attached']) {
  const mods = opencodeBuiltinBridgeModules(mode);
  for (const spec of SHIMMED_EVERYWHERE) assert.ok(mods[spec], `${spec} bridge missing (${mode})`);
  assert.equal('node:process' in mods, mode !== 'oneshot', `node:process bridge (${mode})`);
  assert.equal('node:console' in mods, mode === 'attached', `node:console bridge (${mode})`);

  // The http bridge re-exports the SHIM server surface by identity, named and default.
  const fakeCreateServer = () => 'shim-server';
  globalThis.__nimbusOpencodeBuiltins = { http: { createServer: fakeCreateServer } };
  try {
    const http = evaluateBridge(mods['node:http'].js);
    assert.equal(http.createServer, fakeCreateServer, `bridge must re-export the shim createServer (${mode})`);
    assert.equal(http.default.createServer, fakeCreateServer, `default export must be the shim http object (${mode})`);
  } finally {
    delete globalThis.__nimbusOpencodeBuiltins;
  }

  // A resident mode's node:process is whatever the boot block made the global.
  if (mode !== 'oneshot') {
    const proc = evaluateBridge(mods['node:process'].js);
    assert.equal(proc.default, globalThis.process, `node:process bridge must be the global process (${mode})`);
    assert.equal(proc.cwd, globalThis.process.cwd, `node:process named exports read the global (${mode})`);
  }
}

console.log('opencode-http-bridge: ok');
