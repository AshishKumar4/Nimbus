#!/usr/bin/env bun
// A gem request installs only a version that holds every requirement it
// names and is a pure-Ruby build, however the request is spelled. An exact
// requirement (`= 1.0.0`) names the version to fetch; the rest still apply,
// and a version whose only build is native is refused as a range request
// refuses it.
//
// Red before: an exact requirement took a path of its own that read no
// other requirement and no platform: `gem "p", "= 1.0.0", "< 1.0.0"`
// installed p 1.0.0, and an exact version built only for x86_64-linux
// installed too.

import assert from 'node:assert/strict';
import { installRubyBundle, installRubyGems } from '../../packages/core/src/runtime/ruby-gems.ts';
import { gemWorkspace, rubyGemsRegistry } from './lib/rubygems-registry.mjs';

const HOME = '/home/user/.gem';
const network = await rubyGemsRegistry(
  { p: { '0.9.0': [], '1.0.0': [] }, native: { '2.0.0': [] } },
  { 'native-2.0.0': 'x86_64-linux' },
);
const installed = async (vfs, key) => vfs.exists(`home/user/.gem/specifications/${key}.gemspec`);

// ── gem install with contradictory requirements ──
{
  const vfs = await gemWorkspace();
  await assert.rejects(installRubyGems(vfs, [{ name: 'p', requirements: ['= 1.0.0', '< 1.0.0'] }], { gemHome: HOME, network }));
  assert.equal(await installed(vfs, 'p-1.0.0'), false, 'p 1.0.0 is not below 1.0.0');
  console.log('  ✓ = 1.0.0 with < 1.0.0 installs nothing');
}

// ── the same request in a Gemfile ──
{
  const vfs = await gemWorkspace();
  await vfs.mkdir('home/user/app', { recursive: true });
  await vfs.writeFile('home/user/app/Gemfile', "source 'https://rubygems.org'\ngem 'p', '= 1.0.0', '< 1.0.0'\n");
  await assert.rejects(installRubyBundle(vfs, '/home/user/app', { gemHome: HOME, network }));
  assert.equal(await installed(vfs, 'p-1.0.0'), false, 'the Gemfile\'s every requirement holds');
  assert.equal(await vfs.exists('home/user/app/Gemfile.lock'), false, 'and no lock is written for it');
  console.log('  ✓ a Gemfile with = 1.0.0 and < 1.0.0 installs nothing');
}

// ── an exact version with no pure-Ruby build ──
{
  const vfs = await gemWorkspace();
  await assert.rejects(installRubyGems(vfs, [{ name: 'native', requirements: ['= 2.0.0'] }], { gemHome: HOME, network }));
  assert.equal(await installed(vfs, 'native-2.0.0'), false, 'an x86_64-linux build is not installed');
  await assert.rejects(installRubyGems(vfs, [{ name: 'native', requirements: ['>= 2.0.0'] }], { gemHome: HOME, network }));
  assert.equal(await installed(vfs, 'native-2.0.0'), false, 'nor through a range');
  console.log('  ✓ an exact version built only for another platform installs nothing, as through a range');
}

// ── requirements that hold still install, exact or not ──
{
  const vfs = await gemWorkspace();
  const exact = await installRubyGems(vfs, [{ name: 'p', requirements: ['= 1.0.0', '>= 0.9.0'] }], { gemHome: HOME, network });
  assert.deepEqual(exact.installed, ['p-1.0.0']);
  const ranged = await installRubyGems(vfs, [{ name: 'p', requirements: ['< 1.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(ranged.installed, ['p-0.9.0']);
  console.log('  ✓ = 1.0.0 with >= 0.9.0 installs 1.0.0; < 1.0.0 installs 0.9.0');
}

console.log('ruby-gem-requirements: ok');
