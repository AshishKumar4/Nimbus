#!/usr/bin/env bun
// A portable node program's ES module loader decides as Node 22's does
// before anything resolves (audit RTM-7, RTM-8, RTM-M1, RTM-M2, through
// runtime/esm-loader-policy.ts, which the hosted loader shares): import()'s
// arguments refused as V8 refuses them, and nothing loaded or run for them;
// a data: URL module's format by its MIME type and its source the body's
// bytes as UTF-8; node:module Node's Module class, constructible, the same
// by require and import, its syncBuiltinESMExports reaching import's
// namespaces. Host Node running the same program is the oracle. And a
// provided package (esbuild) imports with the names require gives it, while
// node:esbuild is no module.
//
// Red before: options of 1 and { with: null } were taken as none, so the
// module loaded; a Symbol specifier loaded 'Symbol(s)'; base64 JSON read its
// bytes as Latin-1 ("â\u009c\u0093" for "✓"); application/javascript was an
// unknown format and text/javascriptx a module; new Module() threw; and
// `import { version } from 'esbuild'` failed to link.
// Run by bun, the test checks the source under Bun, then runs itself under
// node against the built package (packages/core/dist: rebuild first).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { PROGRAM, hostReport, report } from './lib/esm-loader-policy-program.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

const host = mkdtempSync(join(tmpdir(), 'esm-loader-policy-'));
let expected;
try {
  writeFileSync(join(host, 'policy.mjs'), PROGRAM);
  expected = hostReport(host);
} finally {
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison is not vacuous.
assert.deepEqual(expected.args.one, ['TypeError', 'The second argument to import() must be an object', null]);
assert.equal(expected.args.sideRanBefore, 0);
assert.deepEqual(expected.data.jsonBase64, ['ok', '✓']);
assert.deepEqual(expected.data.applicationJavascript, ['ok', 2]);
assert.equal(expected.data.suffix[2], 'ERR_UNKNOWN_MODULE_FORMAT');
assert.deepEqual(expected.module.constructs, ['ok', 'object']);
assert.equal(expected.module.synced, 'patched');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  await ws.fs.writeFile('/home/user/policy.mjs', PROGRAM);
  const ran = await ws.exec('node policy.mjs lifo', { cwd: '/home/user', signal: AbortSignal.timeout(60_000) });
  assert.equal(ran.exitCode, 0, ran.stderr);
  const { esbuild, ...ours } = report(ran.stdout);
  assert.deepEqual(ours, expected, 'the portable loader decides as host Node does');
  assert.deepEqual(esbuild, ['string', true, true, true], "esbuild imports with the names require('esbuild') has");
} finally {
  await ws.close();
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - esm-loader-policy-parity (import() arguments, data: modules, node:module and a provided package as Node 22 has them; under Bun and Node)');
} else {
  console.log('ok - under node');
}
