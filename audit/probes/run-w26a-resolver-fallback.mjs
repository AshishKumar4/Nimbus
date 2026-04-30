// W2.6a — focused regression for the __resolvePkgSubpath fallback (D2).
//
// Verifies: when a package's exports/main field points at a target whose
// file isn't reachable in the bundle, the resolver falls back to
// alternative entry candidates (pkg.main probe → /index probe) instead
// of dead-ending with "Cannot find module".
//
// Strategy:
//   1. Synthesize a fixture package under node_modules/w26a-d2-fixture/:
//      - package.json with `main: "./dist/missing.js"` (intentionally NOT
//        on disk) and an `exports` map ALSO pointing at "./dist/missing.js".
//      - index.js sibling that exports a sentinel value.
//   2. require('w26a-d2-fixture') from a node script.
//   3. Assert: require returns the index.js sentinel — proving the
//      fallback fired (without it, require would throw or return undefined).
//
// Also runs a baseline regression for setprototypeof (express's transitive)
// so we know the happy path doesn't regress.
//
// Output: audit/probes/w26a-resolver-fallback.txt

import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'w26a-resolver-fallback.txt');
fs.writeFileSync(ARTIFACT, '');

const fixtureSetup = `
const fs = require('fs');
const path = require('path');
const root = '/home/user/app/node_modules/w26a-d2-fixture';
fs.mkdirSync(root, { recursive: true });
// Declared main + exports both point to a file we DELIBERATELY do not
// create. The resolver must fall back to index.js.
fs.writeFileSync(root + '/package.json', JSON.stringify({
  name: 'w26a-d2-fixture',
  version: '0.0.0',
  main: './dist/missing.js',
  exports: {
    '.': { require: './dist/missing.js', default: './dist/missing.js' },
  },
}));
// Sentinel index — what require() should return via the D2 fallback path.
fs.writeFileSync(root + '/index.js',
  "module.exports = { sentinel: 'd2-fallback-fired', n: 42 };\\n");
console.log('FIXTURE_OK');
`;

const probe = `
const fs = require('fs');
const NM = '/home/user/app/node_modules';

// 1. D2 FALLBACK CASE — fixture with missing exports/main target.
let d2 = null, d2Err = null;
try { d2 = require('w26a-d2-fixture'); } catch (e) { d2Err = e.message; }
const d2OK = !!(d2 && d2.sentinel === 'd2-fallback-fired' && d2.n === 42);

// 2. BASELINE — setprototypeof (express transitive). main exists, no
//    exports field. Should still resolve correctly via the unchanged
//    happy path.
let pjOk = false, setProtoType = 'undefined', setProtoCallOk = false, setProtoErr = null;
try {
  const pj = JSON.parse(fs.readFileSync(NM + '/setprototypeof/package.json','utf8'));
  pjOk = !!pj.name;
  const setProto = require('setprototypeof');
  setProtoType = typeof setProto;
  const o = {};
  const p = { foo: 1 };
  const r = setProto(o, p);
  setProtoCallOk = (r === o && Object.getPrototypeOf(r) === p);
} catch (e) { setProtoErr = e.message; }

const result = {
  d2: { ok: d2OK, value: d2, err: d2Err },
  setproto: { pjOk, type: setProtoType, callOk: setProtoCallOk, err: setProtoErr },
};
console.log('---W26A-D2-RESULT---' + JSON.stringify(result) + '---END-W26A-D2-RESULT---');
`;

// Wrap nodeEvalBase64 output to cd into ~/app before the node script runs.
// Without this, node's cwd is /tmp and require('w26a-d2-fixture') walks up
// from /tmp instead of /home/user/app, so it never finds node_modules/.
function appCd(jsSource) {
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  return `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd /home/user/app && node .${id}.js`;
}

await runProbe('w26a-resolver-fallback', [
  // Install setprototypeof + express so we have a real-world transitive present.
  { kind: 'cmd', cmd: 'cd app && npm install setprototypeof express',
    timeoutMs: 90_000, waitFor: /added \d+ package|npm error/ },
  // Synthesize the D2-fallback fixture INSIDE the VFS (writes flow back via
  // facet vfsWrites → supervisor writeBatch).
  { kind: 'cmd', cmd: appCd(fixtureSetup), timeoutMs: 30_000, waitFor: /FIXTURE_OK/ },
  // Now exercise both paths from ~/app so the require chain walks the
  // right node_modules tree.
  { kind: 'cmd', cmd: appCd(probe), timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });

// Suppress unused-import warning (kept for parity with other probes).
void nodeEvalBase64;

const tail = fs.readFileSync(ARTIFACT, 'utf8').slice(-4000);
const m = tail.match(/---W26A-D2-RESULT---(\{.*?\})---END-W26A-D2-RESULT---/);
if (!m) {
  console.error('FAIL: could not parse result map; see ' + ARTIFACT);
  process.exit(2);
}
const r = JSON.parse(m[1]);
const ok = r.d2.ok && r.setproto.callOk;
console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(r, null, 2));
process.exit(ok ? 0 : 1);
