#!/usr/bin/env bun
/**
 * git-remote-helper-differential — the remote helper real git starts for an
 * http(s) remote (worker git/remote-helper.ts) against git's own transport.
 *
 * Host git 2.53 runs the helper as git-remote-nimbus (lib/git-remote-nimbus.mjs,
 * over an engine that does with host git what the network engine does), and
 * every step is done twice from identical starting points: once through the
 * helper (nimbus::<origin>), once through git's file:// transport. What each
 * leaves (every ref of the local repository and of the origin, HEAD, the
 * worktree, FETCH_HEAD, the exit status) must be the same: clone, fetch
 * --prune --tags, pull --ff-only, push, a rejected non-fast-forward push,
 * --force-with-lease stale and current, push --delete, push --atomic.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'git-remote-helper-'));
const bin = path.join(root, 'bin');
mkdirSync(bin);
symlinkSync(path.join(here, 'lib', 'git-remote-nimbus.mjs'), path.join(bin, 'git-remote-nimbus'));

let tick = 1_700_000_000;
const env = () => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${tick} +0000`, GIT_COMMITTER_DATE: `${tick} +0000`,
});
const git = (cwd, args, { ok = true } = {}) => {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...args], { cwd, env: env() });
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const commit = (cwd, file, text, message) => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message]);
  tick += 60;
};

/** What a repository holds that a transport decides: its refs, HEAD, and for a worktree its status. */
const state = (dir, bare = false) => ({
  refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']).stdout,
  head: git(dir, ['symbolic-ref', '-q', 'HEAD'], { ok: false }).stdout,
  ...(bare ? {} : { status: git(dir, ['status', '--porcelain']).stdout }),
});

// The origin: two branches, an annotated tag, a lightweight tag.
const seed = path.join(root, 'seed');
git(root, ['init', '-q', seed]);
commit(seed, 'a.txt', 'one\n', 'first');
git(seed, ['tag', '-a', '-m', 'v1', 'v1']);
commit(seed, 'a.txt', 'two\n', 'second');
git(seed, ['branch', 'feature']);
git(seed, ['tag', 'light']);
commit(seed, 'b.txt', 'b\n', 'third');
const origin = { helper: path.join(root, 'origin-helper.git'), file: path.join(root, 'origin-file.git') };
git(root, ['clone', '-q', '--bare', seed, origin.helper]);
cpSync(origin.helper, origin.file, { recursive: true });
const url = { helper: `nimbus::${origin.helper}`, file: `file://${origin.file}` };
const local = { helper: path.join(root, 'helper'), file: path.join(root, 'file') };
const sides = ['helper', 'file'];
let checks = 0;

/** Run `step` on both sides from the same tick; their statuses and what they leave must agree. */
const both = (what, step) => {
  const start = tick;
  const results = {};
  let end = tick;
  for (const side of sides) {
    tick = start;
    results[side] = step(side);
    end = Math.max(end, tick);
  }
  tick = end;
  assert.equal(results.helper.status, results.file.status, `${what}: exit status (${results.helper.stderr} | ${results.file.stderr})`);
  assert.deepEqual(state(local.helper), state(local.file), `${what}: the local repository`);
  assert.deepEqual(state(origin.helper, true), state(origin.file, true), `${what}: the origin`);
  checks++;
  return results;
};
/** The same change made to both origins, as another client's push would. */
const advanceOrigins = (change) => {
  const start = tick;
  for (const side of sides) {
    tick = start;
    const work = path.join(root, `work-${side}`);
    rmSync(work, { recursive: true, force: true });
    git(root, ['clone', '-q', origin[side], work]);
    change(work);
    git(work, ['push', '-q', 'origin', '--all']);
    git(work, ['push', '-q', 'origin', '--tags']);
  }
};

both('clone', (side) => git(root, ['clone', '-q', url[side], local[side]], { ok: false }));

advanceOrigins((work) => {
  commit(work, 'c.txt', 'c\n', 'fourth');
  git(work, ['tag', '-a', '-m', 'v2', 'v2']);
  git(work, ['checkout', '-q', '-b', 'next']);
  commit(work, 'n.txt', 'n\n', 'next');
});
for (const side of sides) git(origin[side], ['branch', '-D', 'feature']);
const fetched = both('fetch --prune --tags', (side) => git(local[side], ['fetch', '-q', '--prune', '--tags'], { ok: false }));
void fetched;
const fetchHead = (side) => git(local[side], ['rev-parse', '--git-path', 'FETCH_HEAD']).stdout.trim();
const { readFileSync } = await import('node:fs');
const fetchHeadOf = (side) => readFileSync(path.join(local[side], fetchHead(side)), 'utf8').replaceAll(url[side].replace(/\/$/, ''), 'URL').replaceAll(`'${origin[side]}'`, "'URL'");
assert.equal(fetchHeadOf('helper').split('\n').map((l) => l.split('\t').slice(0, 2).join('\t')).join('\n'),
  fetchHeadOf('file').split('\n').map((l) => l.split('\t').slice(0, 2).join('\t')).join('\n'), 'FETCH_HEAD names the same objects, merge marks and order');
checks++;

both('pull --ff-only', (side) => git(local[side], ['pull', '-q', '--ff-only'], { ok: false }));

both('push', (side) => {
  commit(local[side], 'd.txt', 'd\n', 'fifth');
  return git(local[side], ['push', '-q', 'origin', 'main'], { ok: false });
});

advanceOrigins((work) => commit(work, 'e.txt', 'e\n', 'someone else'));
both('push of a non-fast-forward, refused', (side) => {
  commit(local[side], 'f.txt', 'f\n', 'mine');
  return git(local[side], ['push', '-q', 'origin', 'main'], { ok: false });
});
both('push --force-with-lease, stale', (side) => git(local[side], ['push', '-q', '--force-with-lease=main', 'origin', 'main'], { ok: false }));
both('fetch, then push --force-with-lease, current', (side) => {
  git(local[side], ['fetch', '-q']);
  return git(local[side], ['push', '-q', '--force-with-lease=main', 'origin', 'main'], { ok: false });
});
both('push --delete', (side) => git(local[side], ['push', '-q', 'origin', '--delete', 'next'], { ok: false }));
both('push --atomic, one refused', (side) => {
  git(local[side], ['branch', '-f', 'side', 'main~1']);
  git(local[side], ['tag', '-f', 'v1', 'main']);
  return git(local[side], ['push', '-q', '--atomic', 'origin', 'side', 'refs/tags/v1'], { ok: false });
});

rmSync(root, { recursive: true, force: true });
console.log(`git-remote-helper-differential: ${checks} checks passed`);
