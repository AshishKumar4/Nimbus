#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { HeadlessTerminal } from '../../packages/core/src/substrate/lifo/sandbox/HeadlessTerminal.ts';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', USER.uid, USER.gid);
root.writeFile('home/user/root-owned', 'original', { mode: 0o644 });

const box = await testBox({ harness, vfs: rawVfs });
let invocations = 0;

try {
  box.commands.registry.register('mustnotrun', async () => {
    invocations++;
    return 0;
  });

  await assertRun(
    'a denied append fails only its command and preserves semicolon sequencing',
    'echo x >> /home/user/root-owned; echo AFTER=$?',
    {
      stdout: 'AFTER=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(root.readFileString('home/user/root-owned'), 'original');

  await assertRun(
    'a denied append drives the OR branch',
    'echo x >> /home/user/root-owned || echo OR=$?',
    {
      stdout: 'OR=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );

  invocations = 0;
  await assertRun(
    'a command body does not run when its redirect cannot open',
    'mustnotrun >> /home/user/root-owned; echo done',
    {
      stdout: 'done\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(invocations, 0);

  await assertRun(
    'compound-command redirect failures also remain in the AND-OR chain',
    '{ mustnotrun; } > /home/user/root-owned || echo OR=$?',
    {
      stdout: 'OR=1\n',
      stderr: 'sh: /home/user/root-owned: Permission denied\n',
      exitCode: 0,
    },
  );
  assert.equal(invocations, 0);
} finally {
  box.destroy();
}

// ── a descriptor `exec` keeps open is closed when it is repointed or closed ──
// `exec 3>file` survives the command that opened it, so its bridge handle is
// not the per-command flush's to close; repointing or closing fd 3 must.
{
  root.mkdir('work', { mode: 0o777 });
  root.chown('work', USER.uid, USER.gid);
  const authority = new ProcessFiles(rawVfs);
  const opens = [];
  const closes = [];
  const counted = (view) => new Proxy(view, {
    get(target, key) {
      // No synchronous capability: redirections take the bridge handle path.
      if (key === 'synchronous') return undefined;
      const member = target[key];
      if (typeof member !== 'function') return member;
      return async (...args) => {
        const result = await member.apply(target, args);
        if (key === 'open') opens.push(result.id);
        if (key === 'close') closes.push(args[0]);
        return result;
      };
    },
  });
  const remote = {
    namespace: authority.namespace,
    bind: (binding) => counted(authority.bind(binding)),
    openHost(cred, options) {
      const lease = authority.openHost(cred, options);
      return { fs: counted(lease.fs), dispose: () => lease.dispose() };
    },
    releaseProcess: (pid) => authority.releaseProcess(pid),
  };
  const asyncBox = await testBox({ harness, vfs: rawVfs });
  const shell = new Shell(
    new HeadlessTerminal(), remote, asyncBox.commands.registry,
    { HOME: '/work', PATH: '/bin', USER: 'user' }, asyncBox.shell.getProcessRegistry(),
    { pid: 91, cred: USER, setUmask() {}, runAs: async () => 126 },
  );
  try {
    const result = await shell.execute(
      'exec 3>/work/a; echo first >&3; exec 3>/work/b; echo second >&3; exec 3>&-',
    );
    assert.equal(result.exitCode, 0, `persistent fd script: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(opens.length, 2, 'each exec redirection opens one descriptor');
    assert.deepEqual(closes.sort(), opens.sort(),
      'the repointed and the closed descriptor each release their handle');
    // Writes through fd 3 landed in the file each exec pointed it at.
    assert.equal(root.readFileString('/work/a'), 'first\n');
    assert.equal(root.readFileString('/work/b'), 'second\n');

    // A handle two descriptors share outlives the first of them: closing fd 3
    // must not pull the file out from under fd 4.
    const shared = await shell.execute(
      'exec 3>/work/c; exec 4>&3; exec 3>&-; echo via4 >&4; exec 4>&-',
    );
    assert.equal(shared.exitCode, 0, `shared fd script: ${shared.stderr}`);
    assert.equal(shared.stderr, '');
    assert.equal(root.readFileString('/work/c'), 'via4\n');
    assert.equal(opens.length, 3, 'a dup opens no second descriptor');
    assert.deepEqual(closes.sort(), opens.sort(), 'the shared handle closes once, with the last descriptor');

    // A subshell's descriptors are its own, as fork(2) dups them: repointing
    // fd 3 in it leaves the parent's fd 3 open, and what it opened closes when
    // it ends.
    const forked = await shell.execute(
      'exec 3>/work/d; ( exec 3>/work/e; echo child >&3 ); echo parent >&3; exec 3>&-',
    );
    assert.equal(forked.exitCode, 0, `subshell fd script: ${forked.stderr}`);
    assert.equal(forked.stderr, '');
    assert.equal(root.readFileString('/work/d'), 'parent\n');
    assert.equal(root.readFileString('/work/e'), 'child\n');
    assert.equal(opens.length, 5);
    assert.deepEqual(closes.sort(), opens.sort(), 'the subshell closed its file, the parent closed its own');

    // A background child keeps the file open after the parent closes its fd.
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    asyncBox.commands.registry.register('gate', async () => { await gate; return 0; });
    asyncBox.commands.registry.register('release', async () => { release(); return 0; });
    const background = await shell.execute(
      'exec 3>/work/f; { gate; echo late >&3; } & exec 3>&-; release; wait',
    );
    assert.equal(background.exitCode, 0, `background fd script: ${background.stderr}`);
    assert.equal(background.stderr, '');
    assert.equal(root.readFileString('/work/f'), 'late\n', 'the child wrote after the parent closed fd 3');
    assert.equal(opens.length, 6);
    assert.deepEqual(closes.sort(), opens.sort(), 'and the file closed with the child');
    await authority.releaseProcess(91);
  } finally {
    asyncBox.destroy();
  }
}

console.log('lifo shell redirection permissions: ok');

async function assertRun(name, command, expected) {
  const result = await box.shell.execute(command, {
    commandContext: { pid: 71, cred: USER },
  });
  assert.equal(result.exitCode, expected.exitCode, `${name}: exitCode`);
  assert.equal(result.stdout, expected.stdout, `${name}: stdout`);
  assert.equal(result.stderr, expected.stderr, `${name}: stderr`);
}
