#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();

try {
  const observed = [];
  box.commands.registry.register('credprobe', async (ctx) => {
    observed.push({ pid: ctx.pid, cred: ctx.cred });
    return 0;
  });
  registerShellEntrypointCommands(
    box.commands.registry,
    { execute: (command, options) => box.shell.execute(command, options) },
  );

  const processes = box.workspace.processes;
  const pid = processes.spawn('host', ['host'], '/', { cred: CRED_KERNEL }).pid;
  const commandContext = { pid, cred: CRED_KERNEL };
  // A background job is a process of its own, a child of the one the line runs as, with its credential.
  const cases = [
    ['direct command', 'credprobe', (seen) => seen === pid],
    ['pipeline stage', 'credprobe | cat', (seen) => seen === pid],
    ['subshell', '(credprobe)', (seen) => seen === pid],
    ['background job', 'credprobe & wait', (seen) => seen !== pid && processes.get(seen)?.parentPid === pid],
    ['nested shell', "sh -c 'credprobe'", (seen) => seen === pid],
  ];

  for (const [name, command, runsAs] of cases) {
    observed.length = 0;
    const result = await box.shell.execute(command, { commandContext });
    assert.equal(result.exitCode, 0, `${name}: exit code`);
    assert.equal(observed.length, 1, `${name}: command invoked once`);
    assert.ok(runsAs(observed[0].pid), `${name}: runs as pid ${observed[0].pid}`);
    assert.deepEqual(observed[0].cred, CRED_KERNEL, `${name}: credential is preserved`);
  }
} finally {
  box.destroy();
}

console.log('shell credential context: ok');
