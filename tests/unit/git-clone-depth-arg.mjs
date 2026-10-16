#!/usr/bin/env bun
// An explicit `--depth` is read as git reads it (audit GIT-4), against host
// git with the same argument: positive by atoi, or "fatal: depth <n> is not
// a positive number" (builtin/clone.c, fetch.c); whole by strtol in base 0,
// or "fatal: transport: invalid depth option '<n>'" (transport.c); and that
// strtol's value is the depth ('010' is 8, ' 2' and '+3' are 2 and 3). For
// `git clone` and for `git fetch` alike, each as an int. Omitted, a clone
// is still depth 1, as Nimbus has always cloned.
//
// Red before: a clone took 0 and 'abc' as depth 1 and '2junk' as 2, and
// cloned; fetch said "--depth 0 is not a positive number" and took '010' as
// 10 and ' 2' as no number.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostGitEnv } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-clone-depth-arg-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
/** Host git, as it ends: its exit code and its stderr. */
const hostTry = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, env: hostGitEnv(work), encoding: 'utf8' });
  return { code: result.status, stderr: result.stderr };
};
// The staged cf-git bundle, which a fetch runs; a clone is Nimbus's own either way.
const session = await createFacetSession(work, { realGit: true });
// Read into an int as glibc reads it: 2147483648 and 03000000000 are not positive, 4294967297 is 1, and
// 040000000000 (octal 2^32) is 0, which asks for no shallow boundary at all.
const DEPTHS = ['0', '-1', 'abc', '2junk', '', '0x2', '08', ' 2', '+3', '010', '1',
  '2147483648', '03000000000', '4294967297', '040000000000', '99999999999999999999'];

try {
  // Twelve commits, so that 8 and 10 are different depths.
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let commit = 0; commit < 12; commit++) {
    writeFileSync(join(source, 'file.txt'), `version ${commit}\n`);
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  const remote = 'file://' + join(served, 'repo.git');
  const server = startGitHttpServer(served);
  const failed = [];
  const compare = (label, ours, host) => {
    try { assert.deepEqual(ours, host); } catch (error) { failed.push(`${label}:\n${error.message}`); }
  };
  try {
    for (const [i, depth] of [...DEPTHS.entries(), [DEPTHS.length, undefined]]) {
      const args = depth === undefined ? [] : ['--depth', depth];
      const host = join(work, `host-${i}`);
      const theirs = hostTry(work, ['clone', '-q', ...args, remote, host]);
      const ours = await session.git('/home/user', ['clone', '-q', ...args, server.url + '/repo.git', `clone-${i}`]);
      const commits = (dir) => Number(hostGit(dir, ['rev-list', '--count', 'HEAD']).trim());
      const outcome = { code: ours.code, stderr: ours.stderr, commits: ours.code === 0 ? commits(session.materialize(`home/user/clone-${i}`, join(work, `ours-${i}`))) : null };
      // Omitted, host git clones all of it; Nimbus clones depth 1.
      const expected = { ...theirs, commits: depth === undefined ? 1 : theirs.code === 0 ? commits(host) : null };
      compare(`clone ${depth === undefined ? '(no --depth)' : `--depth ${JSON.stringify(depth)}`}`, outcome, expected);
    }
    // git fetch --depth, in a clone of each.
    hostGit(work, ['clone', '-q', '--depth', '1', remote, join(work, 'host-fetch')]);
    assert.equal((await session.git('/home/user', ['clone', '-q', '--depth', '1', server.url + '/repo.git', 'fetching'])).code, 0);
    for (const depth of DEPTHS) {
      const theirs = hostTry(join(work, 'host-fetch'), ['fetch', '-q', '--depth', depth]);
      const ours = await session.git('/home/user/fetching', ['fetch', '-q', '--depth', depth]);
      compare(`fetch --depth ${JSON.stringify(depth)}`, { code: ours.code, stderr: ours.stderr }, theirs);
    }
  } finally {
    server.stop();
  }
  assert.deepEqual(failed, [], `Nimbus's git reads --depth unlike host git:\n${failed.join('\n')}`);
  console.log(`ok - git-clone-depth-arg (${DEPTHS.length} --depth arguments, clone and fetch, as host git reads them)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
