#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseShellInvocation } from '../../packages/worker/src/shell/shell-invocation.ts';

{
  const parsed = parseShellInvocation('sh', ['-c', 'echo ok', 'arg1']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, { kind: 'command', body: 'echo ok', args: ['arg1'], options: {} });
}

{
  const parsed = parseShellInvocation('sh', ['-c', 'echo ok', 'runner', 'alpha', 'beta']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, {
    kind: 'command',
    body: 'echo ok',
    args: ['runner', 'alpha', 'beta'],
    options: {},
  });
}

{
  const parsed = parseShellInvocation('bash', ['-lc', 'echo ok']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, { kind: 'command', body: 'echo ok', args: [], options: {} });
}

{
  const parsed = parseShellInvocation('bash', ['-euo', 'pipefail', '-c', 'echo strict']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, {
    kind: 'command',
    body: 'echo strict',
    args: [],
    options: { errexit: true, nounset: true, pipefail: true },
  });
}

{
  const parsed = parseShellInvocation('sh', ['-o', 'pipefail', './install.sh', '--flag']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, {
    kind: 'script',
    path: './install.sh',
    args: ['--flag'],
    options: { pipefail: true },
  });
}

{
  const parsed = parseShellInvocation('sh', ['-s']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, { kind: 'stdin', args: [], options: {} });
}

{
  const parsed = parseShellInvocation('sh', ['-s', '--', '--prefix', '/home/user/.local']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.invocation, {
    kind: 'stdin',
    args: ['--prefix', '/home/user/.local'],
    options: {},
  });
}

{
  const parsed = parseShellInvocation('sh', ['--']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 0);
}

{
  const parsed = parseShellInvocation('sh', ['--unknown']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 2);
}

console.log('shell-invocation: ok');
