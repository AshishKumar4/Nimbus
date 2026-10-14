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

  // A job a root line started is root's: a later line of the same shell, as the
  // session's user, neither probes nor ends it, by its jobspec or its pid (kill(2)).
  const rootJob = await box.shell.execute('rm -f /tmp/go; while [ ! -e /tmp/go ]; do sleep 0.05; done & echo $!', { commandContext });
  const jobPid = Number(rootJob.stdout.trim());
  for (const operand of ['%1', String(jobPid)]) {
    for (const flag of ['-0', '-TERM']) {
      const refused = await box.shell.execute(`kill ${flag} ${operand}; echo "status=$?"`);
      assert.deepEqual({ stdout: refused.stdout, stderr: refused.stderr }, { stdout: 'status=1\n', stderr: `kill: (${jobPid}) - Operation not permitted\n` }, `kill ${flag} ${operand} as the user`);
    }
  }
  assert.equal(processes.get(jobPid)?.state, 'running', 'the root job runs on');
  assert.equal((await box.shell.execute('kill -0 %1; echo "status=$?"', { commandContext })).stdout, 'status=0\n', 'root probes its own job');
  await box.fs.writeFile('/tmp/go', '');
  await processes.whenEnded(jobPid);
} finally {
  box.destroy();
}

console.log('shell credential context: ok');
