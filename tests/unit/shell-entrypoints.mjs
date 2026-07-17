#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';

function makeOutput() {
  let text = '';
  return {
    stream: { write: (chunk) => { text += String(chunk); } },
    get text() { return text; },
  };
}

function makeVfs(files = {}) {
  return {
    exists(path) {
      return Object.hasOwn(files, path);
    },
    isDirectory() {
      return false;
    },
    readFileString(path) {
      if (!Object.hasOwn(files, path)) throw new Error(`missing ${path}`);
      return files[path];
    },
  };
}

function makeHarness(files = {}) {
  const commands = new Map();
  const calls = [];
  const vfs = makeVfs(files);
  const identity = {
    pid: 1,
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    vfs,
    setUmask() {},
    async runAs() { return 0; },
  };
  registerShellEntrypointCommands(
    { register: (name, handler) => commands.set(name, (ctx) => handler({ ...identity, ...ctx })) },
    {
      async execute(body, options) {
        calls.push({ body, options });
        options.onStdout?.('executor stdout\n');
        return { exitCode: 7, stdout: 'executor stdout\n' };
      },
    },
    vfs,
  );
  return { commands, calls };
}

{
  const { commands, calls } = makeHarness();
  const stdout = makeOutput();
  const stderr = makeOutput();
  const exitCode = await commands.get('sh')({
    args: ['-c', 'echo "$0|$1|$2|$#|$@"', 'runner', 'alpha', 'beta'],
    cwd: '/home/user',
    env: { '#': 'stale', '@': 'stale', '0': 'stale', '1': 'stale', KEEP: 'yes' },
    stdin: '',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'echo "$0|$1|$2|$#|$@"');
  assert.deepEqual(positionalEnv(calls[0].options.env), {
    '0': 'runner',
    '1': 'alpha',
    '2': 'beta',
    '#': '2',
    '@': 'alpha beta',
  });
  assert.equal(calls[0].options.env.KEEP, 'yes');
  assert.equal(stdout.text, 'executor stdout\n');
  assert.equal(stderr.text, '');
}

{
  const { commands, calls } = makeHarness();
  const stdout = makeOutput();
  const stderr = makeOutput();
  const exitCode = await commands.get('sh')({
    args: ['-eu', '-o', 'pipefail', '-c', 'false | true'],
    cwd: '/home/user',
    env: {},
    stdin: '',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'false | true');
  assert.deepEqual(calls[0].options.shellOptions, {
    errexit: true,
    nounset: true,
    pipefail: true,
  });
  assert.equal(calls[0].options.isolateShellState, true);
  assert.equal(stderr.text, '');
}

{
  const { commands, calls } = makeHarness({
    'home/user/install.sh': 'echo "$0|$1|$#|$@"',
  });
  const stdout = makeOutput();
  const stderr = makeOutput();
  const exitCode = await commands.get('/usr/bin/sh')({
    args: ['install.sh', '--prefix', '/home/user/.local'],
    cwd: '/home/user',
    env: {},
    stdin: '',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'echo "$0|$1|$#|$@"');
  assert.deepEqual(positionalEnv(calls[0].options.env), {
    '0': 'install.sh',
    '1': '--prefix',
    '2': '/home/user/.local',
    '#': '2',
    '@': '--prefix /home/user/.local',
  });
  assert.equal(stderr.text, '');
}

{
  const { commands, calls } = makeHarness();
  const stdout = makeOutput();
  const stderr = makeOutput();
  const exitCode = await commands.get('sh')({
    args: [],
    cwd: '/home/user',
    env: {},
    stdin: { readAll: async () => 'echo "$0|$1|$#|$@"' },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'echo "$0|$1|$#|$@"');
  assert.deepEqual(positionalEnv(calls[0].options.env), {
    '0': 'sh',
    '#': '0',
    '@': '',
  });
  assert.equal(stderr.text, '');
}

{
  const { commands, calls } = makeHarness();
  const stdout = makeOutput();
  const stderr = makeOutput();
  const exitCode = await commands.get('sh')({
    args: ['--unknown'],
    cwd: '/home/user',
    env: {},
    stdin: { readAll: async () => 'echo SHOULD_NOT_RUN' },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 2);
  assert.equal(calls.length, 0);
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /unsupported option: --unknown/);
}

console.log('shell-entrypoints: ok');

function positionalEnv(env) {
  const out = {};
  for (const key of ['0', '1', '2', '#', '@']) {
    if (Object.hasOwn(env, key)) out[key] = env[key];
  }
  return out;
}
