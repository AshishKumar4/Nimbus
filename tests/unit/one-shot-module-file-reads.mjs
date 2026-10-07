#!/usr/bin/env bun
// A program that reads a module file gets the file, as Node's fs gives it,
// even when its launch also runs that file as a module: the module map's code
// is the launch's CommonJS rendering of an ES module, the file is the
// program's. The store used to adopt that rendering as the file, so a script
// patching an installed ES module read esbuild's CommonJS, wrote it back, and
// the next launch ran it as a CommonJS cell ("Identifier '__dirname' has
// already been declared" for Vite 8's node.js chunk).
//
// One fixture tree, on disk for real node and in the session's filesystem for
// one-shot `node` runs through the real launch path (module-map walk, ESM→CJS
// transform, the store's read-back, the data plan). Each script prints what
// it read; the outputs must be Node's. An installed module that only runs is
// carried as its emit and not as the file, so a read by a path no code spells
// out is an honest miss on the first run (EAGAIN, never the CommonJS), and the
// file from the next run on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/reads';
// An ES module whose CommonJS rendering differs from it at once: it declares
// its own `__dirname`, which the lowered cell keeps in its block scope.
const MODULE = "import { join } from 'node:path';\nconst __dirname = join('/a', 'b');\nexport const where = __dirname;\n";
const PKG = 'node_modules/esm-pkg';
const files = {
  'package.json': JSON.stringify({ name: 'reads', private: true }),
  [`${PKG}/package.json`]: JSON.stringify({ name: 'esm-pkg', version: '1.0.0', type: 'module', exports: './index.js' }),
  [`${PKG}/index.js`]: MODULE,
  // Run, and read by a path its code spells out (the data plan's static rule).
  'lib/read-pkg.cjs': "const fs = require('fs');\nconst path = require('path');\nmodule.exports = () => fs.readFileSync(path.join(__dirname, '../node_modules/esm-pkg/index.js'), 'utf8');\n",
  'static.cjs': "require('esm-pkg');\nconsole.log(JSON.stringify({ text: require('./lib/read-pkg.cjs')() }));\n",
  // Run, and read by a path only the run knows.
  'computed.cjs': "const fs = require('fs');\nrequire('esm-pkg');\nlet out;\ntry { out = { text: fs.readFileSync(process.env.TARGET, 'utf8') }; } catch (e) { out = { code: e.code }; }\nconsole.log(JSON.stringify(out));\n",
  // A project module, run and read.
  'local.mjs': MODULE,
  'project.cjs': "const fs = require('fs');\nrequire('./local.mjs');\nconsole.log(JSON.stringify({ text: fs.readFileSync(process.env.TARGET, 'utf8') }));\n",
  // Read, modify, write back; then a launch loads what was written.
  'patch.cjs': "const fs = require('fs');\nconst read = require('./lib/read-pkg.cjs');\nfs.writeFileSync(require('path').join(__dirname, 'node_modules/esm-pkg/index.js'), read() + '// patched\\n');\nconsole.log(JSON.stringify({ patched: true }));\n",
  'load.cjs': "console.log(JSON.stringify({ where: require('esm-pkg').where }));\n",
};
const RUNS = [
  ['static.cjs'],
  ['computed.cjs', `${ROOT}/${PKG}/index.js`],
  ['project.cjs', `${ROOT}/local.mjs`],
  ['patch.cjs'],
  ['load.cjs'],
  ['static.cjs'],
];

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'module-file-reads-')));
const expected = [];
try {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), text);
  }
  for (const [script, target] of RUNS) {
    const env = { ...process.env, ...(target ? { TARGET: target.replace(ROOT, disk) } : {}) };
    const node = spawnSync('node', ['--no-warnings', script], { cwd: disk, env, encoding: 'utf8' });
    assert.equal(node.status, 0, `node ${script}: ${node.stderr}`);
    expected.push(JSON.parse(node.stdout.trim().split('\n').at(-1)));
  }
  assert.equal(readFileSync(join(disk, PKG, 'index.js'), 'utf8'), `${MODULE}// patched\n`, 'premise: node patched the file');
} finally {
  rmSync(disk, { recursive: true, force: true });
}
assert.deepEqual(expected[0], { text: MODULE }, 'premise: node reads the module file');
assert.deepEqual(expected[4], { where: '/a/b' }, 'premise: node runs the patched module');

// ── one-shot node in the session ─────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (text) => { out += text; });
const manager = oneShotManager('one-shot-module-file-reads', { host, rawVfs, loader: runnerLoader('module-file-reads') });
const { oxcEngine } = await import('./lib/oxc-engine.mjs');
manager.setEsbuildService(new EsbuildService(undefined, { engine: async () => oxcEngine }));
for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
async function run(script, target) {
  out = '';
  let result;
  try {
    result = await manager.exec(files[script], {
      filename: `${ROOT}/${script}`, dirname: ROOT, cwd: ROOT, captureOutput: true, ...(target ? { env: { TARGET: target } } : {}),
    });
  } finally { Object.assign(globalThis, real); }
  const printed = (out + result.stdout).trim().split('\n').at(-1) ?? '';
  assert.ok(printed.startsWith('{'), `node ${script} printed no report (exit ${result.exitCode}): ${result.stderr}${out}`);
  return { result, printed: JSON.parse(printed) };
}

for (let i = 0; i < RUNS.length; i++) {
  const [script, target] = RUNS[i];
  let { result, printed } = await run(script, target);
  if (script === 'computed.cjs') {
    // Its first run cannot have the file it never named: an honest miss.
    assert.ok(printed.code === 'EAGAIN' || printed.text === MODULE,
      `the first run reads the file or misses it, never the launch's CommonJS: ${JSON.stringify(printed).slice(0, 300)}`);
    if (printed.code === 'EAGAIN') ({ result, printed } = await run(script, target));
  }
  assert.equal(result.exitCode, 0, `node ${script}: ${result.stderr}${out}`);
  assert.deepEqual(printed, expected[i], `node ${script} reads what node reads`);
}

console.log(`one-shot-module-file-reads: ${RUNS.length} runs read and load module files as node does`);
