#!/usr/bin/env bun
// Ordinary `git push` (the built-in, over smart HTTP) against host git
// pushing the same change to a repository of its own on the same server
// (git http-backend):
//   - a pack larger than git's http.postBuffer (1 MiB): both exit 0, the
//     server's main is each one's commit (fsck clean), the remote-tracking
//     ref follows it, and the pack goes as git sends it, streamed (chunked,
//     no Content-Length);
//   - a push the server's pre-receive hook declines: both exit 1, and
//     neither the server's main nor the remote-tracking ref moves;
//   - a push that is not a fast-forward of the server's main: both exit 1,
//     the server's main as it was.
//
// Red before: the built-in push sent its pack through cf-git's own
// receive-pack client, which collects the whole request and sends it with
// a Content-Length.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostGitEnv } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-push-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args).trim();

/** Host git talking to the server, which answers from this process's loop: not spawnSync. */
async function realGit(cwd, args) {
  const child = spawn('git', args, {
    cwd,
    env: { ...hostGitEnv(work), GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr };
}

// Two served repositories with the same first commit: host git pushes to one, ours to the other.
const served = join(work, 'served');
mkdirSync(served);
const seed = join(work, 'seed');
hostGit(work, ['init', '-q', '-b', 'main', seed]);
writeFileSync(join(seed, 'a.txt'), 'a\n');
hostGit(seed, ['add', 'a.txt']);
hostGit(seed, ['commit', '-q', '-m', 'seed']);
for (const name of ['theirs', 'ours']) {
  const bare = join(served, `${name}.git`);
  hostGit(work, ['clone', '-q', '--bare', seed, bare]);
  hostGit(bare, ['config', 'http.receivepack', 'true']);
}
const server = startGitHttpServer(served);
const session = await createFacetSession(work, { realGit: true });
const ident = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
const host = join(work, 'host');
const ours = '/home/user/ours';

/** The same change committed on both sides: `name` holding `bytes`. */
async function commitBoth(name, bytes) {
  writeFileSync(join(host, name), bytes);
  hostGit(host, ['add', name]);
  hostGit(host, ['commit', '-q', '-m', name]);
  session.kernel.writeFile(`${ours.slice(1)}/${name}`, bytes);
  for (const args of [['add', name], ['commit', '-q', '-m', name]]) {
    const step = await session.git(ours, args, ident);
    assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
  }
}

/** `git push -q` on both sides: each one's exit, and our stderr. */
async function pushBoth(label) {
  const theirs = await realGit(host, ['push', '-q']);
  const pushed = await session.git(ours, ['push', '-q'], ident);
  assert.equal(pushed.code, theirs.code, `${label}: push exits as git's (git's: ${theirs.stderr}; ours: ${pushed.stderr})`);
  return pushed;
}

const servedMain = (name) => hostGit(join(served, `${name}.git`), ['rev-parse', 'main']);
const ourHead = async (ref) => {
  const said = await session.git(ours, ['rev-parse', ref]);
  assert.equal(said.code, 0, `rev-parse ${ref}: ${said.stderr}`);
  return said.stdout.trim();
};

try {
  const cloned = await realGit(work, ['clone', '-q', `${server.url}/theirs.git`, host]);
  assert.equal(cloned.code, 0, cloned.stderr);
  const ourClone = await session.git('/home/user', ['clone', '-q', `${server.url}/ours.git`, ours]);
  assert.equal(ourClone.code, 0, ourClone.stderr);

  // A pack past git's 1 MiB post buffer, not deltified away: random bytes.
  const big = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
  await commitBoth('big.bin', big);
  server.requests.length = 0;
  const pushed = await pushBoth('a large pack');
  assert.equal(pushed.code, 0, `a large pack: ${pushed.stderr}`);
  assert.equal(servedMain('theirs'), hostGit(host, ['rev-parse', 'HEAD']), 'host git: the server\'s main is its commit');
  assert.equal(servedMain('ours'), await ourHead('HEAD'), 'a large pack: the server\'s main is our commit');
  for (const name of ['theirs', 'ours']) hostGit(join(served, `${name}.git`), ['fsck', '--full', '--no-dangling']);
  assert.equal(hostGit(host, ['rev-parse', 'origin/main']), hostGit(host, ['rev-parse', 'HEAD']), 'host git: origin/main follows the push');
  assert.equal(await ourHead('origin/main'), await ourHead('HEAD'), 'a large pack: origin/main follows the push');
  // The request that carried each pack: the last to receive-pack (git probes first with a small one).
  const pack = (name) => server.requests.filter(({ method, path }) => method === 'POST' && path === `/${name}.git/git-receive-pack`).at(-1);
  assert.equal(pack('theirs')?.length, null, 'host git streams a pack past its post buffer');
  assert.equal(pack('ours')?.length, pack('theirs')?.length, 'a large pack: streamed as git streams it, no Content-Length');
  console.log('  ok  a large pack: pushed and streamed as git pushes it; origin/main follows');

  // The server's pre-receive hook declines.
  for (const name of ['theirs', 'ours']) {
    const hook = join(served, `${name}.git`, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
  }
  const before = { theirs: servedMain('theirs'), ours: servedMain('ours'), tracking: await ourHead('origin/main') };
  await commitBoth('declined.txt', 'declined\n');
  const declined = await pushBoth('a declined push');
  assert.equal(declined.code, 1, `a declined push: ${declined.stderr}`);
  assert.match(declined.stderr, /pre-receive hook declined/, 'a declined push: the remote\'s reason');
  assert.deepEqual([servedMain('theirs'), servedMain('ours')], [before.theirs, before.ours], 'a declined push: the servers\' main as it was');
  assert.equal(await ourHead('origin/main'), before.tracking, 'a declined push: origin/main as it was');
  for (const name of ['theirs', 'ours']) rmSync(join(served, `${name}.git`, 'hooks', 'pre-receive'));
  console.log('  ok  a push the pre-receive hook declines: exit 1, nothing moves');

  // Another pushes to each server first: ours is no fast-forward.
  for (const name of ['theirs', 'ours']) {
    const other = join(work, `other-${name}`);
    hostGit(work, ['clone', '-q', join(served, `${name}.git`), other]);
    hostGit(other, ['commit', '-q', '--allow-empty', '-m', 'elsewhere']);
    hostGit(other, ['push', '-q', 'origin', 'main']);
  }
  const moved = { theirs: servedMain('theirs'), ours: servedMain('ours') };
  const behind = await pushBoth('a push that is no fast-forward');
  assert.equal(behind.code, 1, `a push that is no fast-forward: ${behind.stderr}`);
  assert.deepEqual([servedMain('theirs'), servedMain('ours')], [moved.theirs, moved.ours], 'a push that is no fast-forward: the servers\' main as it was');
  console.log('  ok  a push that is no fast-forward: exit 1, the server\'s main as it was');
} finally {
  server.stop();
}

console.log('git-push-matches-git: ok');
