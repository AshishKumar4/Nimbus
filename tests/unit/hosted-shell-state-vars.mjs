#!/usr/bin/env bun
/**
 * hosted-shell-state-vars — a hosted terminal's shell state keeps its
 * variables' attributes and arrays with their values (ticket
 * lifo-command-environment-exports): a command's environment is the
 * exported variables, so a terminal restored after an eviction must know
 * which those are. A state saved before them restores as a shell starts
 * over its variables, each exported, as each reached its programs then.
 */

import assert from 'node:assert/strict';
import { loadShellState, persistShellState } from '../../packages/worker/src/session/state-store.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ctx = { storage: { sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync } };
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const shell = ws.shell;
  await shell.execute('export TOKEN=t; private=p; list=(a b); readonly frozen=1');
  persistShellState(ctx, { cwd: shell.getCwd(), env: shell.getEnv(), vars: shell.getVariableAttributes() });
  const saved = loadShellState(ctx);
  assert.deepEqual(saved.vars.arrays.list, [[0, 'a'], [1, 'b']]);
  assert.equal(saved.vars.exported.includes('TOKEN'), true);
  assert.equal(saved.vars.exported.includes('private'), false);

  // A fresh shell over the same storage, as a terminal rehydrates: values, then their marks.
  const next = await NimbusWorkspace.create({ sql: createSqliteVfsTestHarness().sql, transactions: harness.ctx });
  try {
    Object.assign(next.shell.getEnv(), saved.env);
    next.shell.restoreVariableAttributes(saved.vars ?? undefined, Object.keys(saved.env));
    const env = await next.shell.execute("env | grep -E '^(TOKEN|private)='; declare -p list frozen");
    assert.equal(env.stdout, 'TOKEN=t\ndeclare -a list=([0]="a" [1]="b")\ndeclare -r frozen="1"\n');
  } finally {
    await next.close();
  }

  // A state saved before its attributes: every saved variable exported, as each reached its programs then.
  persistShellState(ctx, { cwd: '/tmp', env: { OLDSAVE: 'v', HOME: '/home/user' }, vars: null });
  const old = loadShellState(ctx);
  assert.equal(old.vars, null);
  const older = await NimbusWorkspace.create({ sql: createSqliteVfsTestHarness().sql, transactions: harness.ctx });
  try {
    Object.assign(older.shell.getEnv(), old.env);
    older.shell.restoreVariableAttributes(old.vars ?? undefined, Object.keys(old.env));
    assert.equal((await older.shell.execute("env | grep '^OLDSAVE='")).stdout, 'OLDSAVE=v\n');
  } finally {
    await older.close();
  }

  // A per-call env reaches the command, in a named shell too, for the call alone.
  for (const shellId of [undefined, 'named']) {
    const ran = await ws.exec("env | grep '^CALLVAR='", { env: { CALLVAR: 'c' }, ...(shellId === undefined ? {} : { shellId }) });
    assert.equal(ran.stdout, 'CALLVAR=c\n', `a call's env reaches its command (${shellId ?? 'own shell'})`);
  }
  assert.equal((await ws.exec("env | grep -c '^CALLVAR='", { shellId: 'named' })).stdout, '0\n', 'and is gone after the call');

  // A named shell that unset OLDPWD keeps it unset.
  await ws.exec('unset OLDPWD', { shellId: 'unset-old' });
  const declared = await ws.exec('declare -p OLDPWD', { shellId: 'unset-old' });
  assert.equal(declared.exitCode, 1, 'OLDPWD stays unset across calls');
} finally {
  await ws.close();
  harness.db.close();
}
console.log('hosted-shell-state-vars: ok');
