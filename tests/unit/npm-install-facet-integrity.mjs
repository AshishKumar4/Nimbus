#!/usr/bin/env bun
/**
 * The install facet checks a downloaded tarball against its integrity string
 * as npm's ssri does: by the entry of the strongest algorithm it names. A
 * lockfile's integrity can carry several entries ("sha1-… sha512-…"); the
 * facet used to compare the whole remainder after the first dash with one
 * digest, so such a package never installed. And a 503 from the registry is
 * tried again, by the policy the supervisor's packument fetch uses.
 */

import assert from 'node:assert/strict';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const TARBALL = packageTarball({
  'package/package.json': '{"name":"left-pad","version":"1.3.0"}',
  'package/index.js': 'export default 1;',
});
const SHA512 = await sriOf(TARBALL);
const digest = async (algo) => {
  const bytes = new Uint8Array(await crypto.subtle.digest(algo, TARBALL));
  return btoa(String.fromCharCode(...bytes));
};

const supervisor = {
  async writeBatchStream(stream) {
    const decoded = await decodeWriteBatchStream(stream);
    let paths = 0;
    for await (const record of decoded.records) {
      if (record.type === 'directory' || record.type === 'file-begin') paths++;
      if (record.type === 'file-chunk') record.retention.release();
    }
    return { ok: true, committedGroupSequence: paths, committedPathCount: paths, inodes: paths, chunks: 0 };
  },
  async getCachedTarball() { return { bytes: null, events: [] }; },
  async putCachedTarball() {},
};

let answers = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  const status = answers.shift() ?? 200;
  return new Response(status === 200 ? TARBALL.slice() : 'busy', { status });
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms ?? 0, 5), ...rest);

async function install(integrity, statuses = []) {
  answers = [...statuses];
  const result = await installPackagesInFacet({
    packages: [{
      name: 'left-pad', version: '1.3.0', tarballUrl: 'https://registry.invalid/left-pad-1.3.0.tgz', integrity,
      pkgDir: 'node_modules/left-pad', installRoot: 'node_modules', mtime: 1, chunkSize: 65_536,
    }],
    concurrency: 1,
  }, { SUPERVISOR: supervisor });
  return result.perPackage[0];
}

try {
  {
    const done = await install(`sha1-${btoa('not the sha1 digest!')} ${SHA512}`);
    assert.equal(done.errorText, undefined, 'a multi-hash integrity installs by its strongest entry');
  }
  {
    const done = await install(`${SHA512.replace(/^sha512-./, 'sha512-A')} sha1-${await digest('SHA-1')}`);
    assert.match(done.errorText ?? '', /integrity mismatch/, 'and only by it: a matching weaker entry is not enough');
  }
  {
    const done = await install(SHA512, [503, 503]);
    assert.equal(done.errorText, undefined);
    assert.deepEqual(done.warnings.filter((w) => w.startsWith('retry')).map((w) => w.replace(/after \d+ms/, 'after Nms')),
      ['retry 1/3 after Nms (HTTP 503)', 'retry 2/3 after Nms (HTTP 503)']);
  }
  {
    const done = await install('md5-abc');
    assert.equal(done.errorText, undefined);
    assert.ok(done.warnings.some((w) => /names no algorithm npm checks; skipped verification/.test(w)));
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = realSetTimeout;
}

console.log('npm-install-facet-integrity: ok');
