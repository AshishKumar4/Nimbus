#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { createLocalGit } from '../../packages/worker/src/git/local-git.ts';

const work = mkdtempSync(join(tmpdir(), 'git-local-adapter-'));
const env = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b',
  NIMBUS_GIT_WASI: '1', GIT_TOKEN: 'inherited-credential',
};
const git = (cwd, args, input) => execFileSync('git', args, { cwd, env, input });
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('git-remote-http', [], work);
const children = new Map();
const spawned = [];
let fail = false;
const manager = new FacetProcessManager({
  processes,
  vfsForProcess: () => ({ exists: async () => true }),
  facetMgr: { kill(pid) { children.get(pid)?.kill('SIGTERM'); return true; } },
  commandRegistry: {
    async resolve() { return { kind: 'pure-builtin' }; },
    async runPureBuiltin(pid, name, args, inherited, cwd, stdin, hooks) {
      assert.equal(name, 'git');
      assert.equal(cwd, work);
      assert.equal(inherited.GIT_TOKEN, env.GIT_TOKEN);
      assert.equal(inherited.NIMBUS_GIT_WASI, '1');
      assert.deepEqual(processes.cred(pid), processes.cred(parent.pid));
      spawned.push({ pid, args, inherited });
      if (fail) {
        await hooks.onStdout(new TextEncoder().encode('partial\n'));
        await hooks.onStderr(new Uint8Array(384 * 1024).fill(120));
        return 7;
      }
      const child = spawn(name, args, { cwd, env: inherited, stdio: ['pipe', 'pipe', 'pipe'] });
      children.set(pid, child);
      processes.setTerminator(pid, () => child.kill('SIGTERM'));
      const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
      });
      const feed = async () => {
        for (let bytes = await stdin.readBytes(65536); bytes !== null; bytes = await stdin.readBytes(65536)) {
          if (!child.stdin.write(bytes)) await new Promise((resolve) => child.stdin.once('drain', resolve));
        }
        child.stdin.end();
      };
      const drain = async (stream, write) => { for await (const bytes of stream) await write(new Uint8Array(bytes)); };
      try {
        await Promise.all([feed(), drain(child.stdout, hooks.onStdout), drain(child.stderr, hooks.onStderr)]);
        return await exit;
      } finally {
        child.kill();
        await exit;
        children.delete(pid);
      }
    },
  },
});

try {
  const repo = join(work, 'repo');
  git(work, ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(repo, 'binary.dat'), randomBytes(768 * 1024));
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'binary']);
  const head = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  git(repo, ['pack-refs', '--all']);
  const linked = join(work, 'linked');
  git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked]);
  const gitDir = git(linked, ['rev-parse', '--absolute-git-dir']).toString().trim();
  const missing = 'f'.repeat(40);
  const stop = new AbortController();
  const local = createLocalGit(manager, { pid: parent.pid, env, cwd: work, signal: stop.signal });
  assert.deepEqual(await local.has(gitDir, [head, missing, base]), new Set([head, base]));
  assert.equal(await local.resolve(gitDir, 'HEAD'), head, 'symbolic HEAD in a linked gitdir');
  assert.equal(await local.resolve(gitDir, 'refs/heads/main'), head, 'packed common ref');
  assert.equal(await local.resolve(gitDir, 'does-not-exist'), null);

  const receiver = join(work, 'receiver');
  git(work, ['init', '-q', receiver]);
  git(receiver, ['fetch', '-q', repo, base]);
  const pack = await new Response(local.packObjects({ gitDir, include: [head], exclude: [base, missing] })).arrayBuffer();
  assert.ok(pack.byteLength > 512 * 1024, 'the pack traversed bounded child pipes');
  git(receiver, ['index-pack', '--stdin', '--fix-thin'], Buffer.from(pack));
  assert.equal(git(receiver, ['cat-file', '-p', head + ':binary.dat']).length, 768 * 1024);
  assert.ok(spawned.every(({ inherited }) => inherited.GIT_DIR === gitDir));

  fail = true;
  await assert.rejects(local.has(gitDir, [head]), /7/, 'cat-file nonzero exit is surfaced despite stdout');
  await assert.rejects(new Response(local.packObjects({ gitDir, include: [head], exclude: [] })).arrayBuffer(), /7/, 'a failed pack is not success');
  fail = false;

  const cancelled = local.packObjects({ gitDir, include: [head], exclude: [] }).getReader();
  assert.equal((await cancelled.read()).done, false);
  await cancelled.cancel();
  for (const { pid } of spawned) assert.equal(manager.isRunning(pid), false, 'cancel released child ' + pid);
  const aborted = local.packObjects({ gitDir, include: [head], exclude: [] }).getReader();
  assert.equal((await aborted.read()).done, false);
  stop.abort();
  await assert.rejects(aborted.read(), /abort|cancel/i);
  for (const { pid } of spawned) assert.equal(manager.isRunning(pid), false, 'abort released child ' + pid);
  console.log('git-local-adapter: real ref resolution, presence, streamed pack, inherited identity, exit errors and cancellation passed');
} finally {
  for (const child of children.values()) child.kill();
  rmSync(work, { recursive: true, force: true });
}
