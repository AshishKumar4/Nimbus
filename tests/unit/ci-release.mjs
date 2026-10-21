#!/usr/bin/env bun
// The guarantees a release leans on, each where it is decided:
//   - releaseDigest (scripts/ci/lib/release.mjs): staged.json is sealed with
//     it and promote.mjs refuses a manifest whose digest moved, so it must be
//     the same for the same manifest whatever its key order, and change with
//     any module, docs or asset digest in it.
//   - deployedDigest (the same file): remote-probes skips the paired perf
//     probes when the baseline's deployment and the candidate's have one
//     digest, so it must change with the module, the app's config or the
//     worker's public assets, and with nothing else in the tree.
//   - holdLease (scripts/ci/lib/lease.mjs): one lane at a time per
//     environment. A second holder waits, and gives up naming the first;
//     the lease is free the moment its holder's process ends, killed or not.
//   - redactCredentials (tests/behavioral/_driver.mjs): a URL or response a
//     probe prints carries no live credential.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { holdLease } from '../../scripts/ci/lib/lease.mjs';
import { deployedDigest, releaseDigest } from '../../scripts/ci/lib/release.mjs';
import { redactCredentials } from '../behavioral/_driver.mjs';

const root = mkdtempSync(join(tmpdir(), 'ci-release-'));
try {
  {
    const paths = ['scripts/ci/lib/state-dir.mjs', 'scripts/ci/lib/release.mjs', 'scripts/ci/lib/lease.mjs', 'tests/behavioral/_deploy-target.mjs'];
    for (const xdg of [null, join(root, 'xdg-state')]) {
      const env = { ...process.env };
      if (xdg) env.XDG_STATE_HOME = xdg;
      else delete env.XDG_STATE_HOME;
      const queried = spawnSync(process.execPath, ['-e', `
        const [state,release,lease,target]=await Promise.all(${JSON.stringify(paths.map(path => new URL('../../' + path, import.meta.url).href))}.map(path=>import(path)));
        console.log(JSON.stringify([state.NIMBUS_STATE,release.RELEASES,lease.LEASES,target.MACHINE_STATE_DIR]));
      `], { encoding: 'utf8', env });
      assert.equal(queried.status, 0, queried.stderr);
      const base = join(xdg || join(homedir(), '.local', 'state'), 'nimbus');
      assert.deepEqual(JSON.parse(queried.stdout), [base, join(base, 'releases'), join(base, 'leases'), base]);
    }
  }
  {
    // Run the real release entrypoint. Only its external upload/build/lease
    // seams, and the binding demand it reads from the npm registry, are
    // replaced: no staging credentials or network are involved, so a
    // publish upstream cannot turn this red.
    const entry = new URL('../../scripts/ci/release.mjs', import.meta.url).href;
    const demand = new URL('../../scripts/ci/lib/binding-demand.mjs', import.meta.url).href;
    const installed = new URL('../../scripts/ci/lib/installed.mjs', import.meta.url).href;
    const bundles = new URL('../../scripts/ci/lib/release.mjs', import.meta.url).href;
    const lease = new URL('../../scripts/ci/lib/lease.mjs', import.meta.url).href;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const exit of [2, 1]) {
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\n[ "$1" = tests/behavioral/_staging-target.mjs ] && [ "$2" = up ] || exit 99\necho 'upload readiness returned ${exit}' >&2\nexit ${exit}\n`);
      chmodSync(join(bin, 'bun'), 0o700);
      const check = spawnSync(process.execPath, ['-e', `
        import { mock } from 'bun:test';
        mock.module(${JSON.stringify(installed)}, () => ({ assertInstalled() {} }));
        mock.module(${JSON.stringify(demand)}, () => ({ missingBindings: async () => ({ missing: [], demanded: [] }) }));
        mock.module(${JSON.stringify(bundles)}, () => ({ fetchRelease: async () => ({ dir: '/fixture/bundle', release: {} }), packNpmRelease: async () => [], productionCommit: () => 'c0ffee', releaseDigest() { throw new Error('an ungraded upload must not be sealed'); } }));
        mock.module(${JSON.stringify(lease)}, () => ({ holdLease: () => require('node:fs').openSync('/dev/null', 'r') }));
        process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture-account';
        process.argv = ['bun', 'release.mjs', 'staging'];
        await import(${JSON.stringify(entry)});
      `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(check.status, exit, `release propagates upload status ${exit}: ${check.stdout}\n${check.stderr}`);
      if (exit === 2) assert.match(check.stderr, /NOT GRADED/, 'ungraded readiness remains ungraded at the release boundary');
      else assert.match(check.stdout, /upload to staging failed/, 'a real upload failure remains red');
    }
    console.log('  ok  release: ungraded upload readiness stays exit 2; a failed upload stays exit 1');
  }
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
    const repo = join(root, 'deployed');
    mkdirSync(repo);
    const git = (...args) => {
      const done = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(done.status, 0, done.stderr);
      return done.stdout.trim();
    };
    /** A commit whose tree holds `files` ({ path: text }) over the last one's. */
    const commit = (files) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    const base = commit({ 'apps/probe/wrangler.jsonc': '{ "name": "probe" }\n', 'packages/worker/public/index.html': '<p>shell</p>\n', 'tests/unit/a.mjs': '1\n' });
    const testsOnly = commit({ 'tests/unit/a.mjs': '2\n', 'scripts/ci/remote-probes.mjs': '3\n' });
    const asset = commit({ 'packages/worker/public/index.html': '<p>shell 2</p>\n' });
    const config = commit({ 'apps/probe/wrangler.jsonc': '{ "name": "probe", "vars": { "A": "1" } }\n' });
    /** The digest of a release of `sha` whose apps/probe module is `module`. */
    const digest = (sha, module, target = 'apps/probe') => {
      const dir = join(root, `release-${sha.slice(0, 12)}-${module}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'release.json'), JSON.stringify({ commit: sha, job: 'j', bundles: { 'apps/probe': { main: 'index.js', sha256: module, file: 'apps-probe/index.js' } }, assets: {} }));
      return deployedDigest(repo, dir, target);
    };
    assert.match(digest(base, 'aa'), /^[0-9a-f]{64}$/);
    assert.equal(digest(testsOnly, 'aa'), digest(base, 'aa'), 'tests and scripts deploy nothing: the same module is the same deployment');
    assert.notEqual(digest(testsOnly, 'ab'), digest(base, 'aa'), 'a module');
    assert.notEqual(digest(asset, 'aa'), digest(testsOnly, 'aa'), "the worker's public assets");
    assert.notEqual(digest(config, 'aa'), digest(asset, 'aa'), "the app's wrangler config");
    assert.throws(() => digest(base, 'aa', 'apps/hosted-demo:staging'), /has no apps\/hosted-demo:staging/, 'a target the release does not hold');
    console.log('  ok  deployedDigest: the same module, config and public assets are one deployment; a change to any is another, and a test or script change is none');
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
