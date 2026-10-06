#!/usr/bin/env bun
/**
 * npx chooses and validates the bin it runs as bin-links does for a linked
 * bin (npxPackageBin), and pruning unlinks what bin-links says a package
 * declares (declaredPackageBins):
 *   - a target named without its extension runs its `.js` file;
 *   - a target that is not there runs nothing;
 *   - a `bin` map with a non-string entry still links its string entries,
 *     as npm-normalize-package-bin keeps them;
 *   - `npx --package=<pkg> <command>` runs the bin named <command> and no
 *     other: a missing or broken one runs nothing;
 *   - `npx <pkg>` runs the bin libnpmexec's getBinFromManifest chooses (one
 *     target, else the bin named after the package, else none), checked
 *     against npm's own module on the same manifests;
 *   - a staged-artifact sentinel passes through, not resolved on the VFS.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { declaredPackageBins, npxPackageBin } from '../../packages/worker/src/npm/bin-links.ts';
import { resolveNpxBinary } from '../../packages/worker/src/npm/npx-install.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const pkg = (name, bin) => JSON.stringify({ name, version: '1.0.0', bin });
const vfs = new FakeVfs({
  'nm/probe/package.json': pkg('probe', { probe: 'cli' }),
  'nm/probe/cli.js': '',
  'nm/missing/package.json': pkg('missing', { missing: 'gone.js' }),
  'nm/mixed/package.json': pkg('mixed', { a: 'a.js', b: null, c: 'c.js' }),
  'nm/mixed/a.js': '',
  'nm/mixed/c.js': '',
  'nm/single/package.json': pkg('single', 'bin.js'),
  'nm/single/bin.js': '',
  'nm/staged/package.json': pkg('staged', { staged: 'nimbus-staged:opencode' }),
  'nm/p/package.json': pkg('p', { tool: 'missing.js', other: 'other.js' }),
  'nm/p/other.js': '',
});

const target = async (dir, name) => (await npxPackageBin(vfs, dir, name))?.targetPath ?? null;
assert.equal(await target('nm/probe', 'probe'), 'nm/probe/cli.js', 'an extensionless target runs its .js file');
assert.equal(await target('nm/missing', 'missing'), null, 'a target that is not there runs nothing');
assert.equal(await target('nm/mixed', 'c'), 'nm/mixed/c.js', 'a non-string entry does not hide the rest');
assert.equal(await target('nm/mixed', 'other'), null, '--package: a command the package has no bin for runs nothing');
assert.equal(await target('nm/p', 'tool'), null, '--package: a requested bin whose target is missing runs nothing, not another bin');
assert.equal(await target('nm/p', 'other'), 'nm/p/other.js');
assert.equal(await target('nm/single', 'single'), 'nm/single/bin.js');
assert.equal(await target('nm/single', 'other'), null, 'a string bin runs only under the package name');
assert.equal(await target('nm/staged', 'staged'), 'nimbus-staged:opencode', 'a staged sentinel passes through');
assert.equal(await target('nm/absent', 'absent'), null);

// `npx <pkg>`: the bin is libnpmexec's choice from the package's manifest.
{
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const npmModules = join(npmRoot, 'npm', 'node_modules');
  assert.ok(existsSync(join(npmModules, 'libnpmexec')), `libnpmexec under ${npmModules}`);
  const npmRequire = createRequire(join(npmModules, 'libnpmexec', 'package.json'));
  const getBinFromManifest = npmRequire('./lib/get-bin-from-manifest.js');
  const normalizeBin = npmRequire('npm-normalize-package-bin');
  const MANIFESTS = {
    'a string bin': { name: 'one', bin: 'cli.js' },
    'a scoped string bin': { name: '@scope/tool', bin: 'cli.js' },
    'one bin of another name': { name: 'pkg', bin: { other: 'cli.js' } },
    'several, one named after the package': { name: 'pkg', bin: { aux: 'aux.js', pkg: 'cli.js' } },
    'several, the scoped package name unscoped': { name: '@scope/pkg', bin: { aux: 'aux.js', pkg: 'cli.js' } },
    'several, none named after the package': { name: 'pkg', bin: { a: 'a.js', b: 'b.js' } },
    'aliases of one target, the first not the name': { name: 'pkg', bin: { alias: 'cli.js', pkg: './cli.js' } },
    'an empty map': { name: 'pkg', bin: {} },
    'no bin': { name: 'pkg' },
    'a non-string entry beside one': { name: 'pkg', bin: { a: 'a.js', b: null } },
  };
  for (const [label, manifest] of Object.entries(MANIFESTS)) {
    let npm;
    try {
      npm = getBinFromManifest(normalizeBin(structuredClone(manifest)));
    } catch (e) {
      assert.match(e.message, /could not determine executable to run/);
      npm = null;
    }
    const dir = `npx/${label.replace(/\W+/g, '-')}`;
    const files = { [`${dir}/package.json`]: JSON.stringify({ version: '1.0.0', ...manifest }) };
    for (const file of ['cli.js', 'aux.js', 'a.js', 'b.js']) files[`${dir}/${file}`] = '';
    const mine = await npxPackageBin(new FakeVfs(files), dir, null);
    assert.equal(mine?.name ?? null, npm, `${label}: the bin libnpmexec runs`);
  }
  // The chosen bin is the only one checked: a missing target runs nothing.
  const broken = new FakeVfs({ 'nm/pkg/package.json': pkg('pkg', { aux: 'aux.js', pkg: 'gone.js' }), 'nm/pkg/aux.js': '' });
  assert.equal(await npxPackageBin(broken, 'nm/pkg', null), null);
}

assert.deepEqual(await declaredPackageBins(vfs, 'nm/mixed'), ['a', 'c']);
assert.deepEqual(await declaredPackageBins(vfs, 'nm/missing'), ['missing'], 'declared whether or not the target exists');
assert.deepEqual(await declaredPackageBins(vfs, 'nm/absent'), []);

// Through npx itself: a project-local install it finds without installing.
{
  const project = new FakeVfs({
    'home/user/app/node_modules/probe/package.json': pkg('probe', { probe: 'cli' }),
    'home/user/app/node_modules/probe/cli.js': '',
  });
  const noInstaller = new Proxy({}, { get() { throw new Error('npx installed a package it had'); } });
  const found = await resolveNpxBinary(noInstaller, project, { uid: 1000, gid: 1000 }, '/home/user/app', ['probe', '--flag'], () => {}, 1);
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.binPath, '/home/user/app/node_modules/probe/cli.js', 'npx runs the .js file an extensionless bin names');
  assert.deepEqual(found.binArgs, ['--flag']);
}

console.log('npx-package-bin: ok');
