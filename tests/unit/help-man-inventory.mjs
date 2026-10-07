#!/usr/bin/env bun
// help lists what the shell has: its builtins, each category's commands the
// registry holds (lazily registered ones too), and registered commands no
// category names, which a host adds. It printed a fixed list instead, with
// `lifo`, which nothing registers. man documents npm and npx, not the `pkg`
// command nothing provides.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createHelpCommand } from '../../packages/core/src/substrate/lifo/commands/system/help.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  ws.registry.register('frobnicate', async () => 0);
  let out = '';
  await createHelpCommand(ws.registry, () => ws.shell.builtinNames())({ args: [], stdout: { write: (s) => { out += s; } } });
  const section = (name) => {
    const at = out.indexOf(`${name}:\n`);
    return at === -1 ? null : out.slice(at).split('\n\n')[0].split(/\s+/).slice(name.split(' ').length);
  };
  for (const builtin of ['cd', 'export', 'history', 'wait']) assert.ok(section('Shell builtins')?.includes(builtin), builtin);
  assert.ok(section('Text processing').includes('sed'), 'a lazily registered command is listed');
  assert.ok(section('Other commands').includes('frobnicate'), 'a host-registered command is listed');
  assert.ok(!out.includes('lifo '), 'an unregistered command is not listed');

  assert.match((await ws.exec('man npm')).stdout, /^NAME\n    npm - /);
  assert.equal((await ws.exec('man pkg')).exitCode, 1);
} finally {
  await ws.close();
}
console.log('help-man-inventory: ok');
