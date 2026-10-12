#!/usr/bin/env bun
// @tier slow — drives a local workerd with installed git and a git-http-backend fixture

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const work = mkdtempSync(join(tmpdir(), 'git-remote-workerd-'));
const identity = {
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};
const env = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const host = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
let probe;
let server;
let terminal;
try {
  const source = join(work, 'source');
  host(work, 'init', '-q', '-b', 'main', source);
  writeFileSync(join(source, 'base.txt'), 'base\n');
  host(source, 'add', '-A');
  host(source, 'commit', '-q', '-m', 'base');
  const base = host(source, 'rev-parse', 'HEAD');
  const served = join(work, 'served');
  mkdirSync(served);
  const bare = join(served, 'repo.git');
  host(work, 'clone', '-q', '--bare', source, bare);
  host(bare, 'config', 'http.receivepack', 'true');
  server = startGitHttpServer(served, {
    refuse: (path) => path.startsWith('/denied.git/') && new Response('denied URL-SECRET ENV-SECRET', {
      status: 401, headers: { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="git"' },
    }),
  });
  const url = server.url + '/repo.git';
  probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
  terminal = await localTerminal(probe, { install: ['bash', 'git'] });
  const run = async (command) => {
    const result = await terminal.run(command, 300_000);
    console.log(`git-remote-workerd: ${command.split(' ')[0]} -> ${result.status} ${JSON.stringify(result.stdout.slice(-600))}`);
    assert.equal(result.status, 0, result.stdout);
    return result.stdout.trim();
  };
  await run('export ' + Object.entries(identity).map(([key, value]) => `${key}='${value}'`).join(' '));

  // Explicit helper selection is Git's own transport syntax. It makes both
  // helper names reachable through real git against the same HTTP fixture.
  for (const remote of [url, 'https::' + url]) {
    const listed = await run(`git ls-remote '${remote}'`);
    assert.equal(listed, `${base}\tHEAD\n${base}\trefs/heads/main`);
  }
  await run(`git clone -q '${url}' repo`);
  await run("printf 'local\\n' > repo/local.txt && git -C repo add local.txt && git -C repo commit -q -m local");

  const oracle = join(work, 'oracle');
  host(work, 'clone', '-q', source, oracle);
  writeFileSync(join(oracle, 'local.txt'), 'local\n');
  host(oracle, 'add', '-A');
  host(oracle, 'commit', '-q', '-m', 'local');
  writeFileSync(join(source, 'remote.txt'), 'remote\n');
  host(source, 'add', '-A');
  host(source, 'commit', '-q', '-m', 'remote');
  const remote = host(source, 'rev-parse', 'HEAD');
  host(source, 'push', '-q', bare, 'main');
  host(oracle, 'pull', '-q', '--rebase');
  await run('git -C repo pull --rebase');
  assert.equal(await run('git -C repo rev-parse HEAD'), host(oracle, 'rev-parse', 'HEAD'), 'divergent pull rebased the local commit');
  assert.equal(await run('cat repo/remote.txt repo/local.txt'), 'remote\nlocal');
  assert.match(await run('cat repo/.git/FETCH_HEAD'), new RegExp('^' + remote), 'real git owns FETCH_HEAD');

  // A byte pack past the broker's pipe capacity exercises streamed stdout
  // while stderr is drained, rather than a second JavaScript pack builder.
  const binary = randomBytes(768 * 1024);
  await terminal.writeFile('/home/user/repo/binary.dat', binary);
  await run('git -C repo add binary.dat && git -C repo commit -q -m binary');
  const pushed = await run('git -C repo rev-parse HEAD');
  await run('NIMBUS_GIT_WASI=1 git -C repo push origin main');
  assert.equal(host(bare, 'rev-parse', 'main'), pushed, 'receive-pack applied the streamed push');
  host(bare, 'fsck', '--full', '--no-dangling');
  assert.equal(Number(host(bare, 'cat-file', '-s', 'main:binary.dat')), binary.length);

  await run('NIMBUS_GIT_WASI=1 git -C repo worktree add -q -b linked ../linked');
  writeFileSync(join(source, 'after.txt'), 'after\n');
  host(source, 'add', '-A');
  host(source, 'commit', '-q', '-m', 'after');
  const after = host(source, 'rev-parse', 'HEAD');
  host(source, 'push', '-q', bare, 'HEAD:refs/heads/after');
  await run('NIMBUS_GIT_WASI=1 git -C linked fetch origin after');
  assert.equal(await run('NIMBUS_GIT_WASI=1 git -C linked rev-parse FETCH_HEAD'), after, 'a linked worktree fetched into common objects');
  assert.equal(await run(`NIMBUS_GIT_WASI=1 git -C repo cat-file -t ${after}`), 'commit', 'the common repository sees fetched objects');

  const denied = await terminal.run(`GIT_TOKEN=ENV-SECRET git ls-remote 'http://user:URL-SECRET@127.0.0.1:${new URL(url).port}/denied.git'`, 300_000);
  assert.notEqual(denied.status, 0);
  assert.ok(!denied.stdout.includes('URL-SECRET') && !denied.stdout.includes('ENV-SECRET') && !denied.stdout.includes('user:'), denied.stdout);
  assert.equal(server.requests.find(({ path }) => path.startsWith('/denied.git/'))?.authorization,
    'Basic ' + Buffer.from('user:URL-SECRET').toString('base64'), 'URL credentials passed through the session engine');
  assert.ok(server.requests.some(({ path }) => path.endsWith('/git-upload-pack')), 'fetch used the session network engine');
  assert.ok(server.requests.some(({ path }) => path.endsWith('/git-receive-pack')), 'push used the session network engine');
  console.log('git-remote-workerd: both helpers, ls-remote, divergent pull --rebase, streamed push, linked fetch and redacted refusal passed');
} finally {
  if (terminal) await terminal.close();
  if (probe) await probe.stop();
  if (server) server.stop();
  rmSync(work, { recursive: true, force: true });
}
