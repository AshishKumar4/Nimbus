#!/usr/bin/env bun
/**
 * npx chooses and validates the bin it runs as bin-links does for a linked
 * bin (npxPackageBin), and pruning unlinks what bin-links says a package
 * declares (declaredPackageBins):
 *   - a target named without its extension runs its `.js` file;
 *   - a target that is not there runs nothing;
 *   - a `bin` map with a non-string entry still links its string entries,
 *     as npm-normalize-package-bin keeps them;
 *   - a map without the requested name runs its first entry, a string `bin`
 *     only under the package's own name;
 *   - a staged-artifact sentinel passes through, not resolved on the VFS.
 */

import assert from 'node:assert/strict';
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
});

const target = async (dir, name) => (await npxPackageBin(vfs, dir, name))?.targetPath ?? null;
assert.equal(await target('nm/probe', 'probe'), 'nm/probe/cli.js', 'an extensionless target runs its .js file');
assert.equal(await target('nm/missing', 'missing'), null, 'a target that is not there runs nothing');
assert.equal(await target('nm/mixed', 'c'), 'nm/mixed/c.js', 'a non-string entry does not hide the rest');
assert.equal(await target('nm/mixed', 'other'), 'nm/mixed/a.js', 'a bin map runs its first entry for another name');
assert.equal(await target('nm/single', 'single'), 'nm/single/bin.js');
assert.equal(await target('nm/single', 'other'), null, 'a string bin runs only under the package name');
assert.equal(await target('nm/staged', 'staged'), 'nimbus-staged:opencode', 'a staged sentinel passes through');
assert.equal(await target('nm/absent', 'absent'), null);

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
