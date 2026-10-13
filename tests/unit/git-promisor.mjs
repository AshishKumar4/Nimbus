#!/usr/bin/env bun
// A partial clone's missing objects, fetched on demand, against host git
// doing the same over the same server (git http-backend).
//
// The clone and every fetch run through execGitNetwork and the real
// assembled facet (in-process, as the LOADER would run it), writing to the
// session's SQLite VFS; the commands run through runGitCommand.
//
//   - git clone --filter=blob:none --depth 2: the same objects as host git's;
//   - git diff <parent> --stat: the same output, in one promisor request,
//     and afterwards the same objects as host git holds after its own diff;
//   - git checkout <parent>: the same worktree and objects, in one request
//     for the commit's blobs (none if the diff already brought them);
//   - fetchMissingObjects for a blob nobody holds yet: that object only,
//     in a promisor pack;
//   - a repository with no promisor remote never fetches: a missing object
//     is missing, as git reports it;
//   - a promisor remote that refuses the request for the pack (a POST), its
//     body echoing the credentials sent: git's "RPC failed", then "could not
//     fetch <id> from promisor remote", exit 128; the body never shown.

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchMissingObjects } from '../../packages/worker/src/git/promisor.ts';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-promisor-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const { kernel, git, requests, doCtx, doEnv, sessionObjects } = await createFacetSession(work);

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let commit = 0; commit < 3; commit++) {
    mkdirSync(join(source, 'src/deep'), { recursive: true });
    for (let f = 0; f < 6; f++) writeFileSync(join(source, `src/f${f}.txt`), `file ${f}\n`.repeat(20 + f) + (f % 2 === 0 ? `rev ${commit}\n` : ''));
    writeFileSync(join(source, 'src/deep/d.txt'), `deep ${commit}\n`);
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  // While `refusing`, a request for a pack is answered 403 with a body echoing what it was sent.
  let refusing = false;
  const server = startGitHttpServer(served, {
    refuse: (path, body, request) => refusing && request.method === 'POST' && new Response(
      `denied for ${request.headers.get('authorization')}; try https://u:hunter2@127.0.0.1/r.git\n`,
      { status: 403, headers: { 'content-type': 'text/plain' } },
    ),
  });
  const url = server.url + '/repo.git';
  const [parent] = hostGit(source, ['rev-parse', 'HEAD~1']).trim().split('\n');
  const host = join(work, 'host');
  hostGit(work, ['clone', '-q', '--depth', '2', '--filter=blob:none', 'file://' + join(served, 'repo.git'), host]);

  try {
    const cloned = await git('/home/user', ['clone', '--depth', '2', '--filter=blob:none', url, 'repo']);
    assert.equal(cloned.code, 0, cloned.stderr);
    assert.deepEqual(sessionObjects('home/user/repo').objects, hostObjects(host), 'clone: the objects host git holds');
    assert.equal(requests.fetchObjects, 0);

    // git diff <parent>: the parent's changed blobs in one request.
    const diff = await git('/home/user/repo', ['diff', parent, '--stat']);
    assert.equal(diff.code, 0, diff.stderr);
    assert.equal(diff.stdout, hostGit(host, ['diff', parent, '--stat']));
    assert.equal(requests.fetchObjects, 1, 'one promisor request for the diff');
    assert.deepEqual(sessionObjects('home/user/repo').objects, hostObjects(host), 'after diff: the objects host git holds');

    // git checkout <parent> in a fresh clone: the commit's blobs it lacks, in one request.
    const second = await git('/home/user', ['clone', '--depth', '2', '--filter=blob:none', url, 'repo2']);
    assert.equal(second.code, 0, second.stderr);
    const host2 = join(work, 'host2');
    hostGit(work, ['clone', '-q', '--depth', '2', '--filter=blob:none', 'file://' + join(served, 'repo.git'), host2]);
    const checkout = await git('/home/user/repo2', ['checkout', parent]);
    assert.equal(checkout.code, 0, checkout.stderr);
    hostGit(host2, ['checkout', '-q', parent]);
    assert.equal(requests.fetchObjects, 2, 'one promisor request for the checkout');
    for (const path of hostGit(host2, ['ls-files']).trim().split('\n')) {
      assert.deepEqual(Buffer.from(kernel.readFile('home/user/repo2/' + path)), readFileSync(join(host2, path)), path);
    }
    const afterCheckout = sessionObjects('home/user/repo2');
    assert.deepEqual(afterCheckout.objects, hostObjects(host2), 'after checkout: the objects host git holds');
    const promisorPacks = readdirSync(join(afterCheckout.dir, '.git/objects/pack'));
    for (const pack of promisorPacks.filter((name) => name.endsWith('.pack'))) {
      assert.ok(promisorPacks.includes(pack.replace(/pack$/, 'promisor')), pack + ' is a promisor pack');
    }
    hostGit(afterCheckout.dir, ['fsck', '--no-dangling', '--connectivity-only']);

    // In the first clone the diff already brought the parent's blobs: its checkout fetches nothing,
    // nor does a merge whose sides and base it holds.
    assert.equal((await git('/home/user/repo', ['checkout', parent])).code, 0);
    const merge = await git('/home/user/repo', ['merge', 'main']);
    assert.equal(merge.code, 0, merge.stderr);
    assert.equal(kernel.readFileString('home/user/repo/src/f0.txt'), readFileSync(join(source, 'src/f0.txt'), 'utf8'));
    assert.equal(requests.fetchObjects, 2);

    // fetchMissingObjects: exactly what was asked for.
    const lacking = hostGit(source, ['rev-parse', 'HEAD~2:src/f0.txt']).trim();
    const before = new Set(sessionObjects('home/user/repo').objects);
    const fetched = await fetchMissingObjects(doCtx, doEnv, { pid: 7, dir: '/home/user/repo', remote: 'origin', url, oids: [lacking] }, ISOLATE_NETWORK);
    assert.equal(fetched.fetched, 1);
    const added = sessionObjects('home/user/repo').objects.filter((line) => !before.has(line));
    assert.deepEqual(added, [lacking + ' blob']);

    // No promisor remote: nothing is fetched, and the object is missing.
    const plain = await git('/home/user', ['init', 'plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const missing = await git('/home/user/plain', ['checkout', lacking, '--', 'src/f0.txt']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, new RegExp(lacking));
    assert.equal(requests.fetchObjects, 3, 'no request without a promisor remote');

    // Edits staged in a partial clone are loose objects: a command that needs
    // them reads them here, and asks the promisor only for what it lacks.
    assert.equal((await git('/home/user', ['clone', '--depth', '1', '--filter=blob:none', url, 'repo3'])).code, 0);
    const host3 = join(work, 'host3');
    hostGit(work, ['clone', '-q', '--depth', '1', '--filter=blob:none', 'file://' + join(served, 'repo.git'), host3]);
    for (const [path, text] of [['src/f1.txt', 'edited\n'], ['src/new.txt', 'new\n']]) {
      kernel.writeFile('home/user/repo3/' + path, text);
      writeFileSync(join(host3, path), text);
    }
    const staged = await git('/home/user/repo3', ['add', 'src/f1.txt', 'src/new.txt']);
    assert.equal(staged.code, 0, staged.stderr);
    hostGit(host3, ['add', 'src/f1.txt', 'src/new.txt']);
    const cached = await git('/home/user/repo3', ['diff', '--cached']);
    assert.equal(cached.code, 0, cached.stderr);
    assert.equal(cached.stdout, hostGit(host3, ['diff', '--cached']));
    // The checkout brought HEAD's blobs; the staged ones are loose: nothing to ask for.
    assert.equal(requests.fetchObjects, 3, 'the staged blobs are local: no request');
    kernel.writeFile('home/user/repo3/src/f1.txt', 'dirty\n');
    const restored = await git('/home/user/repo3', ['checkout', '--', 'src/f1.txt']);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(kernel.readFileString('home/user/repo3/src/f1.txt'), 'edited\n', 'checkout restored the staged blob');
    assert.equal(requests.fetchObjects, 3, 'the staged blob is local: no request');

    // A promisor remote that refuses the request for the pack: git's words, the body not shown.
    {
      const credentialed = url.replace('http://', 'http://u:TOKEN-9@');
      // Host git over the same server: not spawnSync, which would stop the loop the server answers from.
      const hostAsync = (cwd, args) => new Promise((resolve) => {
        const child = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: work, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stderr }));
      });
      const host4 = join(work, 'host4');
      assert.equal((await hostAsync(work, ['clone', '-q', '--depth', '2', '--filter=blob:none', credentialed, host4])).code, 0);
      const cloned4 = await git('/home/user', ['clone', '--depth', '2', '--filter=blob:none', credentialed, 'repo4']);
      assert.equal(cloned4.code, 0, cloned4.stderr);
      refusing = true;
      const args = ['checkout', parent, '--', 'src/f0.txt'];
      const host = await hostAsync(host4, args);
      const ours = await git('/home/user/repo4', args);
      const said = (stderr) => stderr.split('\n').filter((line) => /^(error|fatal|remote): /.test(line));
      assert.deepEqual([ours.code, said(ours.stderr)], [host.code, said(host.stderr)], `git's: ${host.stderr}; ours: ${ours.stderr}`);
      assert.equal(said(ours.stderr).at(-1), `fatal: could not fetch ${hostGit(source, ['rev-parse', `${parent}:src/f0.txt`]).trim()} from promisor remote`);
      assert.doesNotMatch(ours.stderr, /denied|hunter2|TOKEN-9|dTpUT0tFTi05/, `nothing of the body, no credential: ${ours.stderr}`);
      refusing = false;
      console.log('  ok  a promisor remote refusing the request for the pack: git\'s words, nothing of its body');
    }
  } finally {
    server.stop();
  }
  console.log('git-promisor: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
