#!/usr/bin/env bun
// Every identity change asks the host (Kinu ask 61): a process made under a
// credential other than its parent's (sudo, su, any command's ctx.runAs, a
// raw spawn with a parent and a cred) is made only if the workspace's
// `mayChangeIdentity(from, to, command)` allows it; a refusal is EPERM and no
// process. Before, sudo and su gave the session user uid 0 with nothing asked.
// The last block keeps it one choke point: a process is made, and its
// credential chosen, only where the policy is asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const asked = [];
let allowed = false;
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  mayChangeIdentity: (from, to, command) => {
    asked.push([from.uid, to.uid, command]);
    return allowed;
  },
});
ws.registry.register('elevate', async (ctx) => (await ctx.runAs(CRED_KERNEL, ['whoami'])).status);
const run = async (line) => {
  asked.length = 0;
  const result = await ws.exec(line);
  return { out: [result.stdout, result.stderr, result.exitCode], asked: [...asked] };
};
try {
  // Refused: the session user (uid 1000) becomes root by no path.
  assert.deepEqual(await run('sudo whoami'), {
    out: ['', 'sudo: EPERM: operation not permitted, uid 1000 may not become uid 0 (whoami)\n', 1],
    asked: [[1000, 0, 'whoami']],
  }, 'sudo, refused');
  assert.deepEqual(await run('su -c "whoami"'), {
    out: ['', 'su: EPERM: operation not permitted, uid 1000 may not become uid 0 (sh -c whoami)\n', 1],
    asked: [[1000, 0, 'sh -c whoami']],
  }, 'su, refused');
  const elevate = await run('elevate');
  assert.equal(elevate.out[0], '', 'a command\'s ctx.runAs, refused: nothing ran as root');
  assert.notEqual(elevate.out[2], 0);
  assert.match(elevate.out[1], /EPERM: operation not permitted, uid 1000 may not become uid 0 \(whoami\)/);
  assert.deepEqual(elevate.asked, [[1000, 0, 'whoami']]);

  // The same identity is no change: not asked.
  assert.deepEqual(await run('sudo -u user whoami'), { out: ['user\n', '', 0], asked: [] }, 'sudo to oneself');

  // A raw spawn with a parent and another cred is refused; a parentless one is the host's own choice.
  asked.length = 0;
  const parent = ws.processes.spawn('host', ['host'], '/');
  assert.throws(() => ws.processes.spawn('id', ['id'], '/', { parentPid: parent.pid, cred: CRED_KERNEL }), { code: 'EPERM' });
  assert.deepEqual(asked, [[1000, 0, 'id']]);
  const root = ws.processes.spawn('root', ['root'], '/', { cred: CRED_KERNEL });
  assert.equal(ws.processes.cred(root.pid).uid, 0);
  assert.deepEqual(asked, [[1000, 0, 'id']], 'a parentless spawn is not asked');
  ws.processes.exit(parent.pid, 0);
  ws.processes.exit(root.pid, 0);

  // Allowed: as before, and root's own change is asked too.
  allowed = true;
  assert.deepEqual(await run('sudo whoami'), { out: ['root\n', '', 0], asked: [[1000, 0, 'whoami']] }, 'sudo, allowed');
  assert.deepEqual(await run('sudo sh -c "sudo -u user whoami"'), {
    out: ['user\n', '', 0],
    asked: [[1000, 0, 'sh -c sudo -u user whoami'], [0, 1000, 'whoami']],
  }, 'root becoming the user');
} finally {
  await ws.close();
}

// No policy: allowed, as today.
{
  const plain = await NimbusWorkspace.create({ sql: createSqliteVfsTestHarness().sql, transactions: createSqliteVfsTestHarness().ctx });
  try {
    const result = await plain.exec('sudo whoami');
    assert.deepEqual([result.stdout, result.exitCode], ['root\n', 0]);
  } finally {
    await plain.close();
  }
}

// One choke point: the process table is made and spawned only inside the supervisor's spawn, which asks.
{
  const sources = [];
  for (const root of ['packages/core/src', 'packages/worker/src']) {
    for (const path of new Bun.Glob('**/*.ts').scanSync({ cwd: new URL(`../../${root}/`, import.meta.url).pathname })) {
      if (path.endsWith('.d.ts') || path.includes('.generated.')) continue;
      sources.push([`${root}/${path}`, readFileSync(new URL(`../../${root}/${path}`, import.meta.url), 'utf8')]);
    }
  }
  const where = (pattern) => sources.flatMap(([path, text]) => [...text.matchAll(pattern)].map(() => path));
  const supervisor = 'packages/core/src/runtime/session-process-supervisor.ts';
  assert.deepEqual(where(/new ProcessTable\(/g), [supervisor], 'the one process table is the supervisor\'s');
  assert.deepEqual(where(/\btable\.spawn\(/g), [supervisor], 'and only its spawn makes a process');
  const spawn = readFileSync(new URL(`../../${supervisor}`, import.meta.url), 'utf8').match(/\n {2}spawn\([^]*?\n {2}\}\n/)?.[0] ?? '';
  assert.ok(/mayChangeIdentity|identityChange/.test(spawn.slice(0, spawn.indexOf('table.spawn('))), 'asking the policy before it does');
}

console.log('identity-change-policy: every identity change asks the host');
