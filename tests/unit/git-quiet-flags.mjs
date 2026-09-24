#!/usr/bin/env bun
// -q silences what git silences: init, commit, checkout print nothing, and
// fetch, pull and push neither announce themselves nor let the facet stream
// progress. Errors still reach stderr. commit parses its short options the
// way git bundles them, so `-qm seed` is -q plus the message "seed" (it used
// to commit with the message "commit" and print the summary).

import assert from 'node:assert/strict';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);

async function git(cwd, args, { onVfs = vfs, doCtx, doEnv } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 7,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    env: { USER: 'a' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
  }, onVfs, doCtx, doEnv);
  return { code, stdout, stderr };
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

{
  const loud = await git('/home/user', ['init', 'loud']);
  assert.deepEqual(loud, { code: 0, stdout: 'Initialized empty Git repository in /home/user/loud/.git/\n', stderr: '' });
  assert.deepEqual(await git('/home/user', ['init', '-q', 'repo']), { code: 0, stdout: '', stderr: '' });

  user.writeFile('home/user/repo/a.txt', 'a\n');
  assert.equal((await git('/home/user/repo', ['add', 'a.txt'])).code, 0);
  assert.deepEqual(await git('/home/user/repo', ['commit', '-qm', 'seed']), { code: 0, stdout: '', stderr: '' });
  assert.match(strip((await git('/home/user/repo', ['log', '--oneline'])).stdout), /^[0-9a-f]{7} seed\n$/);

  // Each -m is a paragraph; --message and the attached -m<msg> spell the same.
  user.writeFile('home/user/repo/b.txt', 'b\n');
  await git('/home/user/repo', ['add', 'b.txt']);
  const two = await git('/home/user/repo', ['commit', '-m', 'subject', '--message=body', '-q']);
  assert.deepEqual(two, { code: 0, stdout: '', stderr: '' });
  assert.match(strip((await git('/home/user/repo', ['log', '-n', '1'])).stdout), /\n {4}subject\n\nbody\n/);

  // -a stages tracked changes and leaves untracked files alone.
  user.writeFile('home/user/repo/a.txt', 'a2\n');
  user.writeFile('home/user/repo/untracked.txt', 'u\n');
  const all = await git('/home/user/repo', ['commit', '-am', 'edit']);
  assert.equal(all.code, 0);
  assert.match(all.stdout, /^\[[0-9a-f]{7}\] edit\n$/);
  assert.equal(strip((await git('/home/user/repo', ['status'])).stdout), '?? untracked.txt\n');

  assert.deepEqual(await git('/home/user/repo', ['checkout', '-q', '-b', 'topic']), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await git('/home/user/repo', ['checkout', '--quiet', 'master']), { code: 0, stdout: '', stderr: '' });
  assert.equal((await git('/home/user/repo', ['checkout', 'topic'])).stdout, "Switched to branch 'topic'\n");
}

{
  // The network ops hand -q to the facet and print nothing of their own.
  adoptCtxExports({ SupervisorRPC() { return { async stdout() {}, [Symbol.dispose]() {} }; } });
  const bodies = [];
  const doEnv = {
    LOADER: {
      load() {
        return {
          getEntrypoint() {
            return {
              async fetch(request) {
                bodies.push(await request.json());
                return Response.json({ success: false, error: 'capture-only' });
              },
            };
          },
        };
      },
    },
  };
  const doCtx = { id: { toString: () => 'do-quiet-test' }, waitUntil() {} };
  for (const args of [['fetch', '-q'], ['pull', '--quiet', 'origin', 'main'], ['push', 'origin', 'main', '-q']]) {
    bodies.length = 0;
    const result = await git('/home/user/repo', args, { doCtx, doEnv });
    assert.equal(result.code, 1, `${args[0]}: the capture-only facet fails the op`);
    assert.equal(result.stdout, '', `${args[0]} -q printed ${JSON.stringify(result.stdout)}`);
    assert.match(result.stderr, new RegExp(`${args[0]} failed: capture-only`));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].quiet, true, `${args[0]} did not pass -q to the facet`);
    assert.equal(bodies[0].remote, 'origin');
    if (args[0] !== 'fetch') assert.equal(bodies[0].ref, 'main');
  }
  const loud = await git('/home/user/repo', ['fetch', 'origin'], { doCtx, doEnv });
  assert.equal(loud.stdout, 'Fetching from origin...\n');
  assert.equal(bodies.at(-1).quiet, false);
  adoptCtxExports(undefined);
}

console.log('git-quiet-flags: ok');
