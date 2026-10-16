#!/usr/bin/env bun
// An archive that is not whole is refused by every installer that reads one,
// and nothing it installs is left looking installed (audit SHI-3, SHI-M3):
//
//   - a .gem whose data.tar.gz is corrupt (a gzip CRC failure), or whose
//     data.tar ends inside a member: `gem install` refuses both, and so does
//     installRubyGems, with no specification, cache or gem files written.
//     RubyGems 3.6 says "invalid compressed data -- crc error in data.tar.gz"
//     and "end of file reached"; the native `gem` is the oracle when present;
//   - an npm tarball whose tar ends inside a member, though its integrity is
//     the registry's: the install facet fails the package and never publishes
//     its package.json (under a wrong integrity too, the check that failed
//     with it left no unhandled rejection), and the shell's npm
//     (writeTarballStream) writes no package.json. (npm's node-tar, strict, refuses it as TAR_BAD_ARCHIVE;
//     npm itself only warns, but such a tarball fails npm's integrity check
//     unless the registry published it truncated.)
//
// Red before: the gem extractor swallowed both failures and returned the
// files that came before, which were installed under a specification; the
// tar walker ended a stream cut inside a member as if it were whole.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { installRubyGems } from '../../packages/core/src/runtime/ruby-gems.ts';
import { writeTarballStream } from '../../packages/core/src/_shared/tarball.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { decodeWave, packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'archive-truncated-'));
const haveGem = spawnSync('gem', ['--version']).status === 0;
const run = (argv, cwd) => {
  const done = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(done.status, 0, `${argv.join(' ')}: ${done.stderr}`);
};

try {
  // ── RubyGems ──────────────────────────────────────────────────────────
  // One gem, its data.tar.gz whole, corrupt, or a valid gzip of a tar cut inside its second member.
  mkdirSync(join(dir, 'gem/data/lib'), { recursive: true });
  writeFileSync(join(dir, 'gem/data/lib/shidemo.rb'), 'module Shidemo; end\n');
  writeFileSync(join(dir, 'gem/data/lib/big.txt'), 'x'.repeat(4000));
  if (haveGem) {
    // RubyGems' own metadata, from `gem build`, so its install reads the archive and nothing else differs.
    writeFileSync(join(dir, 'gem/data/demo.gemspec'), "Gem::Specification.new { |s| s.name = 'shidemo'; s.version = '0.1.0'; s.summary = 'demo'; s.authors = ['x']; s.files = ['lib/shidemo.rb', 'lib/big.txt']; s.license = 'MIT' }\n");
    run(['gem', 'build', 'demo.gemspec'], join(dir, 'gem/data'));
    run(['tar', '-xf', 'data/shidemo-0.1.0.gem', 'metadata.gz'], join(dir, 'gem'));
  } else {
    writeFileSync(join(dir, 'gem/metadata.gz'), gzipSync('--- !ruby/object:Gem::Specification\nname: shidemo\n'));
  }
  run(['tar', '--format=ustar', '-cf', '../data.tar', 'lib/shidemo.rb', 'lib/big.txt'], join(dir, 'gem/data'));
  const dataTar = readFileSync(join(dir, 'gem/data.tar'));
  const whole = gzipSync(dataTar);
  const corrupt = Buffer.from(whole);
  corrupt[corrupt.length >> 1] ^= 0xff;
  corrupt[(corrupt.length >> 1) + 1] ^= 0xff;
  const truncated = gzipSync(dataTar.subarray(0, 512 + 512 + 512 + 700));
  const gems = {};
  for (const [kind, data] of Object.entries({ whole, corrupt, truncated })) {
    writeFileSync(join(dir, 'gem/data.tar.gz'), data);
    run(['tar', '-cf', `../${kind}.gem`, 'metadata.gz', 'data.tar.gz'], join(dir, 'gem'));
    gems[kind] = readFileSync(join(dir, `${kind}.gem`));
  }

  // The oracle, where RubyGems is installed: the whole gem installs, neither damaged one does.
  if (haveGem) {
    for (const [kind, expected] of [['whole', 0], ['corrupt', 1], ['truncated', 1]]) {
      const home = join(dir, `gem-home-${kind}`);
      const native = spawnSync('gem', ['install', '--local', '--no-document', '--ignore-dependencies', join(dir, `${kind}.gem`)], { env: { ...process.env, GEM_HOME: home }, encoding: 'utf8' });
      assert.equal(native.status, expected, `native gem install ${kind}: ${native.stderr}`);
      assert.equal(existsSync(join(home, 'specifications')) && readdirSync(join(home, 'specifications')).length > 0, expected === 0, `native ${kind}: installed`);
    }
  }

  for (const kind of ['whole', 'corrupt', 'truncated']) {
    const harness = createSqliteVfsTestHarness(new Database(':memory:'));
    const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
    const vfs = ws.filesystem.view({ pid: 900, cred: CRED_KERNEL });
    const responses = new Map([
      ['https://rubygems.org/api/v2/rubygems/shidemo/versions/0.1.0.json', () => Response.json({ name: 'shidemo', version: '0.1.0', platform: 'ruby', gem_uri: 'https://rubygems.org/gems/shidemo-0.1.0.gem', dependencies: { runtime: [] } })],
      ['https://rubygems.org/gems/shidemo-0.1.0.gem', () => new Response(gems[kind])],
    ]);
    const network = { ...ISOLATE_NETWORK, fetch: async (url) => (responses.get(String(url)) ?? (() => new Response(null, { status: 404 })))() };
    const install = installRubyGems(vfs, [{ name: 'shidemo', requirements: ['= 0.1.0'] }], { gemHome: '/home/user/.gem', network });
    if (kind === 'whole') {
      assert.deepEqual((await install).installed, ['shidemo-0.1.0'], 'the whole gem installs');
      assert.equal(new TextDecoder().decode(await vfs.readFile('home/user/.gem/gems/shidemo-0.1.0/lib/shidemo.rb')), 'module Shidemo; end\n');
    } else {
      await assert.rejects(install, kind === 'truncated' ? /Unexpected EOF in archive: lib\/big\.txt ends after 700 of its 4000 bytes/ : /./, `the ${kind} gem is refused`);
      for (const path of ['home/user/.gem/specifications/shidemo-0.1.0.gemspec', 'home/user/.gem/cache/shidemo-0.1.0.gem', 'home/user/.gem/gems/shidemo-0.1.0']) {
        assert.equal(await vfs.exists(path), false, `the ${kind} gem left ${path}`);
      }
    }
    await ws.close();
  }

  // ── npm ───────────────────────────────────────────────────────────────
  // A package cut inside its third member, its package.json whole before it, in a valid gzip with the
  // registry's integrity for exactly those bytes.
  const pkgTar = gunzipSync(packageTarball({
    'package/package.json': '{"name":"cut","version":"1.0.0"}',
    'package/index.js': 'module.exports = 1;\n',
    'package/lib/big.js': `// ${'y'.repeat(3000)}\n`,
  }));
  const cut = gzipSync(pkgTar.subarray(0, 512 * 5 + 900));
  const integrity = await sriOf(cut);

  // The install facet: the package fails, its package.json never published; under another tarball's integrity too, and
  // the check that failed with it is no unhandled rejection.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(cut.slice());
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const [what, sri] of [['its own integrity', integrity], ['the whole tarball\'s integrity', await sriOf(gzipSync(pkgTar))]]) {
      const waves = [];
      const result = await installPackagesInFacet({ packages: [{
        name: 'cut', version: '1.0.0', tarballUrl: 'https://registry.invalid/cut.tgz', integrity: sri,
        pkgDir: 'node_modules/cut', installRoot: 'node_modules', mtime: 1,
      }], concurrency: 1 }, { SUPERVISOR: {
        async writeBatchStream(stream) {
          const decoded = await decodeWave(stream);
          waves.push(...decoded.paths);
          return { ok: true, committedGroupSequence: decoded.paths.length, committedPathCount: decoded.paths.length, inodes: decoded.paths.length, chunks: decoded.chunks };
        },
      } });
      assert.match(result.perPackage[0].errorText ?? '', /Unexpected EOF in archive: package\/lib\/big\.js ends after 900/, `${what}: the facet fails the truncated package`);
      assert.ok(!waves.includes('node_modules/cut/package.json'), `${what}: and never publishes its package.json`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled.map(String), [], 'no rejection was left unhandled');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.fetch = realFetch;
  }

  // The shell's npm: writeTarballStream refuses it, and writes no package.json.
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const vfs = ws.filesystem.view({ pid: 900, cred: CRED_KERNEL });
  await assert.rejects(writeTarballStream(new Response(cut).body, 'home/user/node_modules/cut', vfs), /Unexpected EOF in archive/);
  assert.equal(await vfs.exists('home/user/node_modules/cut/package.json'), false, 'no package.json was written');
  await ws.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`ok - archive-truncated-refused (gems: corrupt and truncated data refused, nothing installed, RubyGems' ${haveGem ? 'refusals matched' : 'oracle absent'}; npm: a truncated tarball fails, its package.json never written)`);
