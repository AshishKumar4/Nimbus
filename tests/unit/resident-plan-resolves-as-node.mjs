#!/usr/bin/env bun
// A resident's data plan holds the file a package specifier its code resolves
// names as Node resolves it, through Node's own package.json `exports`
// selection (core/_shared/exports-resolver.ts): the condition map's key order
// under the resolver's conditions, not a fixed priority. A module that reads
// `createRequire(__filename).resolve('pkg/data')` synchronously reads the
// `require` target; the plan used to hold the `import` one, so the read
// missed. A package linked into node_modules (pnpm's layout) resolves to
// its real path, as Node's realpath does. Package subpaths a module spells
// as data (a bundler's include list) are hints for whatever resolves them,
// and keep naming each target: Node's import and require resolutions, and a
// bundler's `module` one.
//
// Measured on the real launch preparation (_buildProcessBundle, then
// _planResidentData) against real node's resolutions of the same tree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { createAuthority } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/app';
const exportsOf = (name, map) => JSON.stringify({ name, version: '1.0.0', exports: map });
const files = {
  'main.js': "console.log(require('reader')());\n",
  'node_modules/reader/package.json': JSON.stringify({ name: 'reader', version: '1.0.0', main: 'index.js' }),
  'node_modules/reader/index.js': [
    "const { createRequire } = require('module');",
    "const fs = require('fs');",
    'const r = createRequire(__filename);',
    "exports.include = ['esmonly/feature.js', 'cjsonly/feature.js', 'bundled/feature.js'];",
    "module.exports = () => fs.readFileSync(r.resolve('pkg/data'), 'utf8') + fs.readFileSync(r.resolve('linked/data'), 'utf8');",
    '',
  ].join('\n'),
  'node_modules/reader/oracle.mjs': [
    "import { createRequire } from 'node:module';",
    "import { fileURLToPath } from 'node:url';",
    'const r = createRequire(import.meta.url);',
    "console.log(JSON.stringify([r.resolve('pkg/data'), fileURLToPath(import.meta.resolve('esmonly/feature.js')), r.resolve('cjsonly/feature.js'), r.resolve('linked/data')]));",
    '',
  ].join('\n'),
  'node_modules/pkg/package.json': exportsOf('pkg', { './data': { require: './r.dat', import: './i.dat' } }),
  'node_modules/pkg/r.dat': 'R',
  'node_modules/pkg/i.dat': 'I',
  // Linked into node_modules from where it is stored (LINKS).
  'node_modules/.store/linked/package.json': exportsOf('linked', { './data': { require: './l.dat' } }),
  'node_modules/.store/linked/l.dat': 'L',
  'node_modules/esmonly/package.json': exportsOf('esmonly', { './feature.js': { import: './esm-feature.dat' } }),
  'node_modules/esmonly/esm-feature.dat': 'E',
  'node_modules/cjsonly/package.json': exportsOf('cjsonly', { './feature.js': { require: './cjs-feature.dat' } }),
  'node_modules/cjsonly/cjs-feature.dat': 'C',
  'node_modules/bundled/package.json': exportsOf('bundled', { './feature.js': { module: './module-feature.dat', default: './default-feature.dat' } }),
  'node_modules/bundled/module-feature.dat': 'M',
  'node_modules/bundled/default-feature.dat': 'D',
};

const LINKS = { 'node_modules/linked': 'node_modules/.store/linked' };

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'resident-plan-resolves-')));
let resolved;
try {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), body);
  }
  for (const [link, target] of Object.entries(LINKS)) symlinkSync(join(disk, target), join(disk, link));
  const run = spawnSync('node', ['main.js'], { cwd: disk, encoding: 'utf8' });
  assert.equal(run.status, 0, `node main.js: ${run.stderr}`);
  assert.equal(run.stdout, 'RL\n', "premise: node reads the require target, and the linked package's file");
  const oracle = spawnSync('node', ['node_modules/reader/oracle.mjs'], { cwd: disk, encoding: 'utf8' });
  assert.equal(oracle.status, 0, `node oracle.mjs: ${oracle.stderr}`);
  resolved = JSON.parse(oracle.stdout).map((path) => `${ROOT.slice(1)}/${relative(disk, path)}`);
} finally {
  rmSync(disk, { recursive: true, force: true });
}

// ── the session ──────────────────────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
const manager = oneShotManager('resident-plan-resolves-as-node', { host, rawVfs, loader: runnerLoader('plan-resolves') });
for (const [rel, body] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, body);
}
for (const [link, target] of Object.entries(LINKS)) kfs.symlink(`${ROOT}/${target}`, `${ROOT.slice(1)}/${link}`);
const spec = { scriptPath: `${ROOT}/main.js`, cwd: ROOT, entryCode: files['main.js'] };
const entry = host.processes.spawn('node main.js', ['node', 'main.js'], ROOT, { cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const pacer = manager._launchPacer(entry.pid);
const vfsState = await manager._buildProcessBundle(entry, spec, pacer);
const { paths } = await manager._planResidentData(entry, vfsState, ROOT, '/home/user', pacer, spec.scriptPath);
const held = new Set([...paths, ...vfsState.bundlePaths]);

const [requireTarget, importTarget, cjsTarget, linkedTarget] = resolved;
assert.equal(requireTarget, `${ROOT.slice(1)}/node_modules/pkg/r.dat`, 'premise: the require target');
assert.ok(held.has(requireTarget), `the plan holds what createRequire().resolve('pkg/data') names, as node resolves it: ${requireTarget}`);
assert.ok(!held.has(`${ROOT.slice(1)}/node_modules/pkg/i.dat`), 'and not the import target no read names');
assert.equal(linkedTarget, `${ROOT.slice(1)}/node_modules/.store/linked/l.dat`, "premise: node's realpath of a linked package");
assert.ok(held.has(linkedTarget), `a linked package's file is held at its real path, as node resolves it: ${linkedTarget}`);
assert.ok(held.has(importTarget), `a package subpath spelled as data keeps its import target: ${importTarget}`);
assert.ok(held.has(cjsTarget), `and its require target: ${cjsTarget}`);
assert.ok(held.has(`${ROOT.slice(1)}/node_modules/bundled/module-feature.dat`), "and a bundler's module target");

console.log('resident-plan-resolves-as-node: the plan holds what node resolves, and every target a spelled-out subpath names');
