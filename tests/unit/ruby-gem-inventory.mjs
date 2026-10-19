#!/usr/bin/env bun
// A gem home has one inventory, as RubyGems keeps it: a gem is installed when
// its specification is in specifications/, written after everything else the
// gem installs, and Ruby's load path lists only installed gems; and a bundle's
// Gemfile.lock is that bundle's resolution (its requests and their runtime
// dependencies, at the versions it settled on), not every gem ever installed.
//
// A gem whose version RubyGems must choose (two installed, or a dependency
// that has two) is left off the load path, for require to activate it.
//
// Red before: a gem counted as installed once its lib directory existed, so
// an install interrupted after it was never finished, and its lib was on the
// load path; and Gemfile.lock listed every gem a separate ledger had
// recorded, unrelated ones and every version.

import assert from 'node:assert/strict';
import { installedGemLoadPath, installRubyBundle, installRubyGems } from '../../packages/core/src/runtime/ruby-gems.ts';
import { gemWorkspace, rubyGemsRegistry } from './lib/rubygems-registry.mjs';

const HOME = '/home/user/.gem';

const network = await rubyGemsRegistry({
  rack: { '2.0.0': [], '3.0.0': [] },
  rackup: { '2.1.0': [{ name: 'rack', requirements: '>= 3' }] },
  unrelated: { '1.0.0': [] },
});

// ── An install interrupted after its lib directory is finished on the next ──
{
  const vfs = await gemWorkspace();
  await vfs.mkdir('home/user/.gem/gems/rack-3.0.0/lib', { recursive: true });
  await vfs.writeFile('home/user/.gem/gems/rack-3.0.0/lib/rack.rb', '# rack 3.0.0\n');
  assert.deepEqual(await installedGemLoadPath(vfs, HOME), { libs: [], activates: false }, 'an interrupted install\'s lib is on the load path');
  const report = await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 3.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(report.installed, ['rack-3.0.0'], 'a gem with a lib directory and no specification counted as installed');
  assert.ok(await vfs.exists('home/user/.gem/gems/rack-3.0.0/lib/rack/version.rb'), 'the interrupted gem\'s files were not written');
  const again = await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 3.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(again.alreadyInstalled, ['rack-3.0.0']);
  assert.deepEqual(await installedGemLoadPath(vfs, HOME), { libs: ['/home/user/.gem/gems/rack-3.0.0/lib'], activates: false }, 'an installed gem\'s lib is on the load path');
  await installRubyGems(vfs, [{ name: 'unrelated', requirements: [] }, { name: 'rackup', requirements: [] }], { gemHome: HOME, network });
  assert.deepEqual(await installedGemLoadPath(vfs, HOME), { libs: ['/home/user/.gem/gems/rack-3.0.0/lib', '/home/user/.gem/gems/rackup-2.1.0/lib', '/home/user/.gem/gems/unrelated-1.0.0/lib'], activates: false }, 'with one version of each, every lib is on the load path, sorted, and RubyGems reads nothing');
  // A version RubyGems must choose is left to its activation: rack's, and
  // rackup's, whose dependency on rack chooses one; unrelated stays.
  await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 2.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(await installedGemLoadPath(vfs, HOME), { libs: ['/home/user/.gem/gems/unrelated-1.0.0/lib'], activates: true }, 'a gem with two versions, and one depending on it, are left to RubyGems');
}

// ── Gemfile.lock is the bundle's resolution ──
{
  const vfs = await gemWorkspace();
  await installRubyGems(vfs, [{ name: 'unrelated', requirements: [] }], { gemHome: HOME, network });
  await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 2.0.0'] }], { gemHome: HOME, network });
  await vfs.mkdir('home/user/app', { recursive: true });
  await vfs.writeFile('home/user/app/Gemfile', "source 'https://rubygems.org'\ngem 'rackup'\n");
  await installRubyBundle(vfs, '/home/user/app', { gemHome: HOME, network });
  const lock = new TextDecoder().decode(await vfs.readFile('home/user/app/Gemfile.lock'));
  const specs = lock.slice(lock.indexOf('specs:\n') + 7, lock.indexOf('\n\nDEPENDENCIES')).split('\n').map((line) => line.trim());
  assert.deepEqual(specs, ['rack (3.0.0)', 'rackup (2.1.0)'], `the lock is not the bundle's resolution:\n${lock}`);
  // Locked again with everything installed: the same resolution, found installed.
  await installRubyBundle(vfs, '/home/user/app', { gemHome: HOME, network });
  assert.equal(new TextDecoder().decode(await vfs.readFile('home/user/app/Gemfile.lock')), lock);
}

console.log('ruby-gem-inventory: ok');
