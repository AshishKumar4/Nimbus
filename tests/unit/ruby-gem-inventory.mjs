#!/usr/bin/env bun
// A gem home has one inventory, as RubyGems keeps it: a gem is installed when
// its specification is in specifications/, written after everything else the
// gem installs, and Ruby's load path lists only installed gems; and a bundle's
// Gemfile.lock is that bundle's resolution (its requests and their runtime
// dependencies, at the versions it settled on), not every gem ever installed.
//
// Red before: a gem counted as installed once its lib directory existed, so
// an install interrupted after it was never finished, and its lib was on the
// load path; and Gemfile.lock listed every gem a separate ledger had
// recorded, unrelated ones and every version.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { installedGemLibRoots, installRubyBundle, installRubyGems } from '../../packages/core/src/runtime/ruby-gems.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const HOME = '/home/user/.gem';

/** A .gem archive holding `files` (path → text) as its data. */
async function gemArchive(name, version, files) {
  const dir = await mkdtemp(join(tmpdir(), 'nimbus-gem-inventory-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, 'data', path, '..'), { recursive: true });
      await writeFile(join(dir, 'data', path), text);
    }
    for (const argv of [['tar', '-czf', 'data.tar.gz', '-C', 'data', 'lib'], ['tar', '-cf', 'out.gem', 'data.tar.gz']]) {
      assert.equal(Bun.spawnSync(argv, { cwd: dir }).exitCode, 0, argv.join(' '));
    }
    return await readFile(join(dir, 'out.gem'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** RubyGems' API for `gems` (name → version → runtime dependencies), each gem's archive a lib file. */
async function registry(gems) {
  const responses = new Map();
  for (const [name, versions] of Object.entries(gems)) {
    responses.set(`https://rubygems.org/api/v1/versions/${name}.json`, () => Response.json(Object.keys(versions).map((number) => ({ number, platform: 'ruby', prerelease: false }))));
    for (const [version, runtime] of Object.entries(versions)) {
      const gem = await gemArchive(name, version, { [`lib/${name}.rb`]: `# ${name} ${version}\n`, [`lib/${name}/version.rb`]: `V = "${version}"\n` });
      responses.set(`https://rubygems.org/api/v2/rubygems/${name}/versions/${version}.json`, () => Response.json({ name, version, platform: 'ruby', gem_uri: `https://rubygems.org/gems/${name}-${version}.gem`, dependencies: { runtime } }));
      responses.set(`https://rubygems.org/gems/${name}-${version}.gem`, () => new Response(gem));
    }
  }
  return { ...ISOLATE_NETWORK, fetch: async (url) => (responses.get(String(url)) ?? (() => new Response(null, { status: 404 })))() };
}

async function home() {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  return ws.filesystem.view({ pid: 900, cred: CRED_KERNEL });
}

const network = await registry({
  rack: { '2.0.0': [], '3.0.0': [] },
  rackup: { '2.1.0': [{ name: 'rack', requirements: '>= 3' }] },
  unrelated: { '1.0.0': [] },
});

// ── An install interrupted after its lib directory is finished on the next ──
{
  const vfs = await home();
  await vfs.mkdir('home/user/.gem/gems/rack-3.0.0/lib', { recursive: true });
  await vfs.writeFile('home/user/.gem/gems/rack-3.0.0/lib/rack.rb', '# rack 3.0.0\n');
  assert.deepEqual(await installedGemLibRoots(vfs, HOME), [], 'an interrupted install\'s lib is on the load path');
  const report = await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 3.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(report.installed, ['rack-3.0.0'], 'a gem with a lib directory and no specification counted as installed');
  assert.ok(await vfs.exists('home/user/.gem/gems/rack-3.0.0/lib/rack/version.rb'), 'the interrupted gem\'s files were not written');
  const again = await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 3.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(again.alreadyInstalled, ['rack-3.0.0']);
  await installRubyGems(vfs, [{ name: 'rack', requirements: ['= 2.0.0'] }], { gemHome: HOME, network });
  assert.deepEqual(await installedGemLibRoots(vfs, HOME), ['/home/user/.gem/gems/rack-2.0.0/lib', '/home/user/.gem/gems/rack-3.0.0/lib'], 'every installed version\'s lib is on the load path, sorted');
}

// ── Gemfile.lock is the bundle's resolution ──
{
  const vfs = await home();
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
