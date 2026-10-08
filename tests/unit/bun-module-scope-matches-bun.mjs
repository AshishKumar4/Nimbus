#!/usr/bin/env bun
// Bun binds `require`, `__filename` and `__dirname` in an ES module
// (bun.sh/docs/runtime/modules), where Node binds none of CommonJS's names
// (module-format-matches-node). The module scope is the runtime's
// (module-format.ts ModuleScope): `bun` lowers an ES module, the entry's
// and each one it loads, keeping CommonJS's names. With Node's scope applied
// to Bun too, each of these threw "require is not defined".
//
// One fixture tree, on disk for real Bun (this test's own runtime) and in the
// session's filesystem for `bun` through the runtime handler and a one-shot
// launch: each run prints one JSON line, which must be Bun's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { runBunScript } from '../../packages/worker/src/runtime/bun-runner.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

assert.ok(process.versions.bun, 'premise: this test runs on Bun, the runtime it compares');

const ROOT = '/home/user/bunscope';
const line = (...parts) => `console.log(JSON.stringify([${parts.join(', ')}]));\n`;
const files = {
  'package.json': JSON.stringify({ name: 'bunscope', private: true }),
  // An entry with module syntax, by its extension and by its package's "type".
  'esm.mjs': `import { sep } from 'node:path';\n${line("'esm'", 'typeof require', 'typeof __filename', 'typeof __dirname', "require('node:path').sep === sep", "__filename.endsWith('/esm.mjs')", "__dirname.endsWith('/bunscope')")}`,
  'typed/package.json': JSON.stringify({ name: 'typed', type: 'module' }),
  'typed/esm.js': `import { sep } from 'node:path';\n${line("'typed'", 'typeof require', 'typeof __dirname', 'sep')}`,
  // An installed ES module the entry imports: a cell of the launch's module map.
  'node_modules/esmdep/package.json': JSON.stringify({ name: 'esmdep', version: '1.0.0', type: 'module', main: 'index.js' }),
  'node_modules/esmdep/index.js': "export const kind = typeof require;\nexport const sep = require('node:path').sep;\nexport const file = __filename.endsWith('/esmdep/index.js');\n",
  'dep.mjs': `import { kind, sep, file } from 'esmdep';\n${line("'dep'", 'kind', 'sep', 'file')}`,
};
const RUNS = [
  ['esm.mjs'],
  ['typed/esm.js'],
  ['dep.mjs'],
  ['-e', `import { sep } from 'node:path';\n${line("'eval'", 'typeof require', 'typeof __filename', 'sep')}`],
];

// ── real bun ─────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'bun-scope-')));
const tree = join(disk, 'bunscope');
const expected = [];
try {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    writeFileSync(join(tree, rel), text);
  }
  for (const run of RUNS) {
    const bun = spawnSync(process.execPath, run, { cwd: tree, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(bun.status, 0, `bun ${run.join(' ')}: ${bun.stderr}`);
    expected.push(JSON.parse(bun.stdout.trim().split('\n').at(-1)));
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
}

// ── bun in the session ───────────────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (text) => { out += text; });
const manager = oneShotManager('bun-module-scope-matches-bun', { host, rawVfs, loader: runnerLoader('bun-module-scope') });
const { oxcEngine } = await import('./lib/oxc-engine.mjs');
const esbuild = new EsbuildService(undefined, { engine: async () => oxcEngine });
manager.setEsbuildService(esbuild);
for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}
const handler = buildRuntimeHandler({
  name: 'bun',
  version: '1.1.42',
  helpText: 'help',
  supportsBinSpawn: true,
  moduleScope: 'bun',
  run: (code, opts) => runBunScript(manager, code, { ...opts, captureOutput: true }),
}, { getEsbuild: () => esbuild, registry: { resolve: () => undefined } });

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
for (let i = 0; i < RUNS.length; i++) {
  out = '';
  let stdout = '';
  let stderr = '';
  let exitCode;
  try {
    exitCode = await handler({
      vfs: kfs,
      args: RUNS[i],
      cwd: ROOT,
      env: { HOME: '/home/user', PATH: '/usr/local/bin:/usr/bin:/bin' },
      cred: CRED_SESSION_USER,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    });
  } finally { Object.assign(globalThis, real); }
  const label = `bun ${RUNS[i].join(' ').slice(0, 60)}`;
  const printed = (out + stdout).trim().split('\n').at(-1) ?? '';
  assert.ok(printed.startsWith('['), `${label} printed no report (exit ${exitCode}): ${stderr}${out}`);
  assert.equal(exitCode, 0, `${label}: ${stderr}${out}`);
  assert.deepEqual(JSON.parse(printed), expected[i], `${label} runs as bun runs it`);
}

console.log(`bun-module-scope-matches-bun: ${RUNS.length} ES modules run in Bun's scope, as bun ${process.versions.bun} runs them`);
