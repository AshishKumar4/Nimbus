#!/usr/bin/env bun

import assert from 'node:assert/strict';

import {
  defaultShellPath,
  makeChshCommand,
  readDefaultShell,
} from '../../packages/core/src/substrate/lifo/shell/default-shell.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/VFS.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';

function output() {
  let text = '';
  return {
    stream: { write: (chunk) => { text += String(chunk); } },
    get text() { return text; },
  };
}

function commandContext(vfs, args = []) {
  const stdout = output();
  const stderr = output();
  return {
    pid: 1,
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    args,
    env: { HOME: '/home/user' },
    cwd: '/home/user',
    vfs,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdoutOutput: stdout,
    stderrOutput: stderr,
    signal: new AbortController().signal,
    setUmask() {},
    async runAs() { return 0; },
  };
}

{
  const vfs = new VFS();
  vfs.mkdir('/home', { recursive: true });
  vfs.mkdir('/home/user', { recursive: true });
  vfs.mkdir('/home/user/.config', { recursive: true });
  assert.equal(defaultShellPath('/home/user'), '/home/user/.config/nimbus/shell');
  assert.equal(vfs.exists('/home/user/.config/nimbus'), false);
  assert.equal(readDefaultShell(vfs, '/home/user'), 'lifo');

  const chsh = makeChshCommand({ isBashInstalled: () => false });
  const missing = commandContext(vfs, ['-s', 'bash']);
  assert.equal(await chsh(missing), 1);
  assert.match(missing.stderrOutput.text, /nimbus install bash/);
  assert.equal(readDefaultShell(vfs, '/home/user'), 'lifo');

  const installedChsh = makeChshCommand({ isBashInstalled: () => true });
  const setBash = commandContext(vfs, ['-s', 'bash']);
  assert.equal(await installedChsh(setBash), 0);
  assert.equal(vfs.exists('/home/user/.config/nimbus'), true);
  assert.equal(readDefaultShell(vfs, '/home/user'), 'bash');
  assert.equal(vfs.readFileString(defaultShellPath('/home/user')), 'bash\n');

  const current = commandContext(vfs);
  assert.equal(await installedChsh(current), 0);
  assert.equal(current.stdoutOutput.text, 'bash\n');

  const setSh = commandContext(vfs, ['-s', 'sh']);
  assert.equal(await installedChsh(setSh), 0);
  assert.equal(readDefaultShell(vfs, '/home/user'), 'lifo');
  assert.equal(vfs.readFileString(defaultShellPath('/home/user')), 'lifo\n');

  vfs.writeFile(defaultShellPath('/home/user'), 'invalid\n');
  assert.equal(readDefaultShell(vfs, '/home/user'), 'lifo');
}

async function startShell(defaultShell) {
  const vfs = new VFS();
  vfs.mkdir('/home', { recursive: true });
  vfs.mkdir('/home/user', { recursive: true });
  if (defaultShell) {
    const path = defaultShellPath('/home/user');
    vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    vfs.writeFile(path, `${defaultShell}\n`);
  }

  const registry = createDefaultRegistry();
  const invocations = [];
  registry.register('bash', async (ctx) => {
    invocations.push([...ctx.args]);
    return 0;
  });

  let terminalOutput = '';
  const shell = new Shell(
    {
      write(data) { terminalOutput += data; },
      writeln(data) { terminalOutput += `${data}\n`; },
      onData() {},
      cols: 80,
      rows: 24,
      focus() {},
      clear() {},
    },
    vfs,
    registry,
    { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' },
    new ProcessRegistry(),
  );
  // `start()` settles once the rc files are applied and, for the built-in
  // shell, the prompt is written — a host with input waiting for the shell
  // relies on that ordering, so the lifo case gets no timer. The bash
  // launch is deliberately outside the promise (an interactive bash runs
  // until the user leaves it), so that case still yields a macrotask.
  const started = shell.start();
  assert.equal(typeof started.then, 'function', 'start() returns the startup promise');
  await started;
  if (defaultShell === 'bash') await new Promise((resolve) => setTimeout(resolve, 0));
  return { invocations, terminalOutput };
}

{
  const lifo = await startShell(null);
  assert.deepEqual(lifo.invocations, []);
  assert.match(lifo.terminalOutput, /user@nimbus/);

  const bash = await startShell('bash');
  assert.deepEqual(bash.invocations, [['-i']]);
  assert.match(bash.terminalOutput, /user@nimbus/);
}

console.log('default-shell: ok');
