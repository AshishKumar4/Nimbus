#!/usr/bin/env bun
// The guarantees a release leans on, each where it is decided:
//   - releaseDigest (scripts/ci/lib/release.mjs): staged.json is sealed with
//     it and promote.mjs refuses a manifest whose digest moved, so it must be
//     the same for the same manifest whatever its key order, and change with
//     any module, docs or asset digest in it.
//   - holdLease (scripts/ci/lib/lease.mjs): one lane at a time per
//     environment. A second holder waits, and gives up naming the first;
//     the lease is free the moment its holder's process ends, killed or not.
//   - redactCredentials (tests/behavioral/_driver.mjs): a URL or response a
//     probe prints carries no live credential.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { holdLease } from '../../scripts/ci/lib/lease.mjs';
import { releaseDigest } from '../../scripts/ci/lib/release.mjs';
import { redactCredentials } from '../behavioral/_driver.mjs';

const root = mkdtempSync(join(tmpdir(), 'ci-release-'));
try {
  {
    const release = {
      commit: 'c0ffee', job: 'j1',
      bundles: { 'apps/probe': { main: 'index.js', sha256: 'aa', file: 'apps-probe/index.js' }, 'apps/hosted-demo:staging': { main: 'index.js', sha256: 'bb', file: 'x' } },
      assets: { 'apps/hosted-demo': { manifest: { 'index.html': '11', 'docs/index.html': '22' }, docs: { sha256: 'dd', file: 'd.tar' } } },
    };
    const reordered = {
      assets: { 'apps/hosted-demo': { docs: { file: 'd.tar', sha256: 'dd' }, manifest: { 'docs/index.html': '22', 'index.html': '11' } } },
      bundles: { 'apps/hosted-demo:staging': { file: 'x', sha256: 'bb', main: 'index.js' }, 'apps/probe': { file: 'apps-probe/index.js', main: 'index.js', sha256: 'aa' } },
      job: 'j1', commit: 'c0ffee',
    };
    assert.match(releaseDigest(release), /^[0-9a-f]{64}$/);
    assert.equal(releaseDigest(reordered), releaseDigest(release), 'the same manifest, in any key order, has the same digest');
    const changed = (edit) => { const copy = structuredClone(release); edit(copy); return releaseDigest(copy); };
    assert.notEqual(changed((r) => { r.assets['apps/hosted-demo'].manifest['index.html'] = '12'; }), releaseDigest(release), 'an asset');
    assert.notEqual(changed((r) => { r.assets['apps/hosted-demo'].docs.sha256 = 'de'; }), releaseDigest(release), 'the docs');
    assert.notEqual(changed((r) => { r.bundles['apps/probe'].sha256 = 'ab'; }), releaseDigest(release), 'a module');
    assert.notEqual(changed((r) => { r.commit = 'c0ffef'; }), releaseDigest(release), 'the commit');
    assert.notEqual(changed((r) => { r.assets['apps/hosted-demo'].manifest['extra.js'] = '33'; }), releaseDigest(release), 'an added asset');
    console.log('  ok  releaseDigest: one digest per manifest, whatever its key order, and a new one for any changed module, docs or asset');
  }
  {
    const dir = join(root, 'leases');
    const lease = new URL('../../scripts/ci/lib/lease.mjs', import.meta.url).href;
    const held = join(root, 'held');
    // Another lane's process takes staging, says so, and holds it until killed.
    const holder = spawn(process.execPath, ['-e', `
      const { holdLease } = await import(${JSON.stringify(lease)});
      holdLease('staging', { what: { commit: 'aaaa', worktree: '/wt/a' }, dir: ${JSON.stringify(dir)}, log: () => {} });
      require('node:fs').writeFileSync(${JSON.stringify(held)}, '');
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    try {
      for (const deadline = Date.now() + 30_000; !existsSync(held);) {
        assert.ok(Date.now() < deadline, 'the holder took the lease');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const waits = [];
      assert.throws(() => holdLease('staging', { what: { commit: 'bbbb' }, dir, waitMs: 1000, log: (line) => waits.push(line) }),
        /staging has been held for longer than .* by pid \d+ on .*commit aaaa, worktree \/wt\/a/);
      assert.match(waits.join('\n'), /waiting for staging: pid \d+ .*commit aaaa/, 'the waiter says whom it waits for');
      const other = holdLease('production', { what: { commit: 'bbbb' }, dir, waitMs: 1000, log: () => {} });
      assert.ok(Number.isInteger(other), 'another environment is its own lease');
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.on('exit', resolve));
    }
    const fd = holdLease('staging', { what: { commit: 'bbbb' }, dir, waitMs: 5000, log: () => {} });
    assert.ok(Number.isInteger(fd), 'a killed holder\'s lease is free at once: nothing to break');
    console.log('  ok  holdLease: a second lane waits and names the first, environments are separate, and a killed holder frees it');

    // Handed down: a writer given the lease as its fd 3 holds it (holdLease
    // returns at once, rather than waiting on its own parent), and keeps it
    // after the process that took it lets go, until the writer ends.
    const take = (wait) => `
      const { holdLease } = await import(${JSON.stringify(lease)});
      try { console.log('took', holdLease('staging', { what: {}, dir: ${JSON.stringify(dir)}, waitMs: ${wait}, log: () => {} })); }
      catch (error) { console.log('refused', error.message); }`;
    const run = (code, extra = []) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', ...extra] });
    assert.match(run(take(60_000), [fd]).stdout, /^took 3$/m, 'a child handed the lease holds it without waiting');
    assert.match(run(take(500)).stdout, /^refused .*has been held/m, 'a process not handed it waits and gives up');
    const writer = spawn(process.execPath, ['-e', `${take(60_000)}; require('node:fs').writeFileSync(${JSON.stringify(join(root, 'writing'))}, ''); setInterval(() => {}, 1000);`],
      { stdio: ['ignore', 'ignore', 'ignore', fd] });
    try {
      for (const deadline = Date.now() + 30_000; !existsSync(join(root, 'writing'));) {
        assert.ok(Date.now() < deadline, 'the writer started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      closeSync(fd);
      assert.match(run(take(500)).stdout, /^refused /m, 'the taker let go, and its writer still holds the lease');
    } finally {
      writer.kill('SIGKILL');
      await new Promise((resolve) => writer.on('exit', resolve));
    }
    assert.match(run(take(5000)).stdout, /^took \d+$/m, 'once the writer ends, the lease is free');
    console.log('  ok  holdLease: a writer handed the lease holds it at once, and keeps it after its taker lets go, until it ends');
  }
  {
    const url = 'https://nimbus-staging.example.workers.dev/s/calm-fox-1234/?nimbus_token=eyJhbGciOiJIUzI1NiJ9.abc.def&tab=1#token=frag';
    const shown = redactCredentials(`landed at ${url}; Authorization: Bearer eyJ.x.y`);
    assert.doesNotMatch(shown, /eyJ/, shown);
    assert.match(shown, /\/s\/calm-fox-1234\/\?nimbus_token=…&tab=1#token=…/, 'the rest of the URL stays readable');
    assert.match(shown, /Bearer …/);
    console.log('  ok  redactCredentials: attach tokens in a URL, and bearers, are replaced; the rest stays');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ci-release OK');
