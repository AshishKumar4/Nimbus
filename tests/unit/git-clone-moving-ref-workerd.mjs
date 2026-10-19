#!/usr/bin/env bun
// @tier slow — drives a local workerd
/**
 * git-clone-moving-ref-workerd: a clone of a branch that moves while it is
 * being cloned. Smart HTTP is two requests, the ref advertisement (GET
 * info/refs) and the fetch (POST git-upload-pack); a push between them moves
 * the branch. Real git fetches the sha the advertisement named. The server
 * accepts that want while the sha is still reachable from a ref (stateless
 * RPC; GitHub also allows reachable wants), so the clone succeeds with that
 * commit checked out. Once a force-push makes the sha unreachable, protocol
 * v0's server refuses it (v2's fetch does not check), and the clone fails.
 *
 * A staging run of git-clone.mjs cloned github.com/AshishKumar4/Nimbus while
 * main was being pushed and got 0 top-level entries. Here host git's
 * http-backend serves a branch that a push moves at the first fetch. Host git
 * clones it in protocol v0, the session's, and so does a session on local
 * workerd (apps/probe), in each case: a fast-forward and a force-push. The
 * session must do what real git does: the advertised commit checked out
 * after a fast-forward; after a force-push, git's outcome, a failed clone
 * rather than an empty one where git refuses.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { startGitHttpServer } from './lib/git-http-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'git-clone-moving-'));
const env = {
  ...process.env, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

// ── the fixture: main at `advertised`, a fast-forward `ahead`, an unrelated `forced` ──
const src = join(work, 'src');
mkdirSync(join(src, 'lib'), { recursive: true });
git(work, 'init', '-q', '-b', 'main', src);
writeFileSync(join(src, 'README.md'), '# advertised\n');
writeFileSync(join(src, 'lib/a.js'), 'export const a = 1;\n');
writeFileSync(join(src, 'old.txt'), 'only in the advertised commit\n');
git(src, 'add', '-A');
git(src, 'commit', '-q', '-m', 'first');
writeFileSync(join(src, 'lib/a.js'), 'export const a = 2;\n');
git(src, 'commit', '-q', '-am', 'second');
const advertised = git(src, 'rev-parse', 'HEAD');
writeFileSync(join(src, 'README.md'), '# ahead\n');
git(src, 'rm', '-q', 'old.txt');
writeFileSync(join(src, 'new.txt'), 'pushed during the clone\n');
git(src, 'add', '-A');
git(src, 'commit', '-q', '-m', 'pushed during the clone');
const ahead = git(src, 'rev-parse', 'HEAD');
git(src, 'checkout', '-q', '--orphan', 'other');
git(src, 'rm', '-q', '-rf', '.');
writeFileSync(join(src, 'forced.txt'), 'force-pushed\n');
git(src, 'add', '-A');
git(src, 'commit', '-q', '-m', 'force-pushed');
const forced = git(src, 'rev-parse', 'HEAD');
const bare = join(work, 'served/moving.git');
git(work, 'clone', '-q', '--mirror', src, bare);
// The server allows what GitHub's does: filters, and wants of a tip or of any reachable commit, not of any sha.
git(bare, 'config', 'uploadpack.allowFilter', 'true');
git(bare, 'config', 'uploadpack.allowTipSHA1InWant', 'true');
git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
// The objects of the force-pushed commit stay in the repository, unreachable from main once it moves back.

/**
 * main at `advertised`, and at `next` from the first fetch on: a push between
 * the ref listing (v0's info/refs, v2's ls-refs) and the fetch (a request that
 * wants objects).
 */
let move = null;
const arm = (next) => {
  git(bare, 'update-ref', 'refs/heads/main', advertised);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  // Only main is advertised: the other branches would keep the force-pushed commit reachable.
  for (const ref of git(bare, 'for-each-ref', '--format=%(refname)').split('\n')) {
    if (ref !== '' && ref !== 'refs/heads/main') git(bare, 'update-ref', '-d', ref);
  }
  move = next;
};
const server = startGitHttpServer(join(work, 'served'), {
  plain: true,
  env,
  forward: ['git-protocol', 'content-encoding'],
  refuse: (path, body) => {
    if (move !== null && path.endsWith('/git-upload-pack') && new TextDecoder().decode(body).includes('want ')) {
      git(bare, 'update-ref', 'refs/heads/main', move);
      move = null;
    }
    return false;
  },
});
const url = `${server.url}/moving.git`;

/** Host git's clone of `url` into `dir`: its exit code and output. */
const hostClone = (dir) => new Promise((resolve) => {
  // Asynchronously: the server answering it runs on this event loop.
  // In protocol v0, as the session's clone speaks it (v2's fetch takes an unreachable want).
  const child = spawn('git', ['-c', 'protocol.version=0', 'clone', url, dir], { cwd: work, env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => resolve({ code, output }));
});

try {
// ── host git: what a clone of a moving branch does ──────────────────────────
const host = {};
for (const [name, next] of [['fast-forward', ahead], ['force-push', forced]]) {
  arm(next);
  const dir = join(work, `host-${name}`);
  const result = await hostClone(dir);
  host[name] = result.code === 0
    ? { cloned: true, head: git(dir, 'rev-parse', 'HEAD'), entries: readdirSync(dir).filter((entry) => entry !== '.git').sort(), readme: readFileSync(join(dir, 'README.md'), 'utf8') }
    : { cloned: false, output: result.output };
}
// The oracle as it stands here: what the session must match. (A force-push's refusal is pinned by host git, whichever it is.)
assert.deepEqual(host['fast-forward'], { cloned: true, head: advertised, entries: ['README.md', 'lib', 'old.txt'], readme: '# advertised\n' },
  `host git clones the advertised commit: ${JSON.stringify(host['fast-forward'])}`);
console.log(`git-clone-moving-ref-workerd: host git (v0) after a force-push: ${host['force-push'].cloned ? 'cloned' : 'refused'}`);

// ── the session's clone ────────────────────────────────────────────────────
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe);
  try {
    for (const name of ['fast-forward', 'force-push']) {
      arm(name === 'fast-forward' ? ahead : forced);
      const dir = `c-${name}`;
      const cloned = await terminal.run(`git clone ${url} ${dir}`, 300_000);
      console.log(`git-clone-moving-ref-workerd: ${name}: clone exited ${cloned.status}`);
      if (host[name].cloned) {
        assert.equal(cloned.status, 0, `${name}: the session's clone succeeds, as git's does:\n${cloned.stdout}`);
        const head = (await terminal.run(`git -C ${dir} rev-parse HEAD`, 60_000)).stdout.trim();
        const entries = (await terminal.run(`ls -A1 ${dir} | grep -vx .git`, 60_000)).stdout.trim().split('\n').map((line) => line.trim()).sort();
        const readme = (await terminal.run(`cat ${dir}/README.md`, 60_000)).stdout;
        assert.deepEqual({ cloned: true, head, entries, readme }, host[name], `${name}: the session checks out what git does`);
      } else {
        assert.notEqual(cloned.status, 0, `${name}: the session's clone fails, as git's does, not succeeds empty:\n${cloned.stdout}`);
      }
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
} finally {
  server.stop();
  rmSync(work, { recursive: true, force: true });
}

console.log('git-clone-moving-ref-workerd: a clone of a moving branch does what git does');
process.exit(0);
