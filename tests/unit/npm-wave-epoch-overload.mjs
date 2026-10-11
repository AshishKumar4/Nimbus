#!/usr/bin/env bun
// A writer epoch whose open the session shed ("Durable Object is
// overloaded") is opened again under a wave's lost-call policy, and nothing
// is failed for it: neither the open nor its writes are lost to one shed.
//
// Red before (BusyVicuna, aa306976f; armada nimbus-20261011015417-ce6b3433):
// WaveWriter cached the rejected open, and sendWaveAttempts asked for the
// writer outside its retry, so every package in the shard failed without one
// write attempt (opens=1, writes=0, 6 of 6 failed; create-next-app lost 31 of
// 42 under load). (A process's filesystem client: process-fs-client.mjs.)

import assert from 'node:assert/strict';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { decodeWave, packageTarball } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const OVERLOADED = 'Durable Object is overloaded. Requests queued for too long.';

// ── npm's install facet, through WaveWriter ──────────────────────────────────
{
  const packages = Array.from({ length: 6 }, (_, index) => ({
    name: `fixture-${index}`, version: '1.0.0', integrity: '',
    tarballUrl: `https://unused.invalid/${index}`,
    pkgDir: `node_modules/fixture-${index}`, installRoot: 'node_modules', mtime: 1,
  }));
  const tarball = packageTarball({
    'package/package.json': '{"name":"fixture","version":"1.0.0"}',
    'package/index.js': 'module.exports = 1;',
  });
  for (const shed of [1, 2]) {
    let opens = 0;
    let writes = 0;
    const result = await installPackagesInFacet({ packages, concurrency: 3 }, {
      SUPERVISOR: {
        async getCachedTarball() { return { bytes: tarball.slice(), events: [] }; },
        async openWaveWriter() {
          opens++;
          if (opens <= shed) throw new Error(OVERLOADED);
          return 'accepted-writer';
        },
        async writeBatchStream(stream) {
          writes++;
          const wave = await decodeWave(stream);
          return { ok: true, committedGroupSequence: 1, committedPathCount: wave.paths.length, inodes: wave.paths.length, chunks: wave.chunks };
        },
      },
    });
    const failed = result.perPackage.filter((entry) => entry.errorText);
    assert.deepEqual(failed.map((entry) => entry.errorText), [], `${shed} shed open(s): no package fails`);
    assert.equal(opens, shed + 1, 'the open is made again until the session answers it');
    assert.ok(writes > 0, 'and the waves are written under it');
    assert.ok(result.perPackage.every((entry) => entry.fileCount === 2), 'every package publishes its files');
  }
  // An open the session refused for a reason of its own is its verdict: not made again.
  let opens = 0;
  const refused = await installPackagesInFacet({ packages: packages.slice(0, 1), concurrency: 1 }, {
    SUPERVISOR: {
      async getCachedTarball() { return { bytes: tarball.slice(), events: [] }; },
      async openWaveWriter() { opens++; throw Object.assign(new Error('EPERM: no writer for this process'), { code: 'EPERM' }); },
      async writeBatchStream() { throw new Error('never sent'); },
    },
  });
  assert.equal(opens, 1, 'a refused open is not made again');
  assert.match(refused.perPackage[0].errorText ?? '', /EPERM/, 'and fails what it was for, with its reason');
  console.log('  an install whose epoch open is shed opens it again and publishes every package');
}

console.log('npm-wave-epoch-overload: ok');
