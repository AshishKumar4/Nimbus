#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

const box = await Sandbox.create({ persist: false });

try {
  const observed = [];
  box.commands.registry.register('credprobe', async (ctx) => {
    observed.push({ pid: ctx.pid, cred: ctx.cred });
    return 0;
  });
  registerShellEntrypointCommands(
    box.commands.registry,
    { execute: (command, options) => box.shell.execute(command, options) },
    box.kernel.vfs,
  );

  const commandContext = { pid: 41, cred: CRED_KERNEL };
  const cases = [
    ['direct command', 'credprobe'],
    ['pipeline stage', 'credprobe | cat'],
    ['subshell', '(credprobe)'],
    ['background job', 'credprobe & wait'],
    ['nested shell', "sh -c 'credprobe'"],
  ];

  for (const [name, command] of cases) {
    observed.length = 0;
    const result = await box.shell.execute(command, { commandContext });
    assert.equal(result.exitCode, 0, `${name}: exit code`);
    assert.equal(observed.length, 1, `${name}: command invoked once`);
    assert.equal(observed[0].pid, 41, `${name}: pid is preserved`);
    assert.deepEqual(observed[0].cred, CRED_KERNEL, `${name}: credential is preserved`);
  }
} finally {
  box.destroy();
}

console.log('shell credential context: ok');
