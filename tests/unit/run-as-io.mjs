#!/usr/bin/env bun
// A child started through runAs (find -exec, sudo) inherits the descriptors,
// environment and directory of the command that started it, however that
// command came to run: typed at the workspace's shell, or on a line of an
// `sh -c` or `bash -c` script whose redirections and pipes it runs under.
//
// The nested script's own command line is what decides where its commands
// write. A child that wrote to the outer shell's stdout instead would escape
// `> out.txt` and skip the `| cat -n` it was piped into.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
registerShellEntrypointCommands(ws.registry, { execute: (command, options) => ws.shell.execute(command, options) });

const run = async (line) => {
  const result = await ws.exec(line, { cwd: '/tmp/io' });
  return [result.stdout, result.stderr, result.exitCode];
};
/** What `line` writes to the workspace's own streams, then what it left in `file`. */
const redirected = async (line, file) => [...await run(line), (await ws.exec(`cat /tmp/io/${file}`)).stdout];
assert.equal((await ws.exec('mkdir -p /tmp/io/d && touch /tmp/io/d/f1 /tmp/io/d/f2')).exitCode, 0);

for (const shell of ['sh', 'bash']) {
  const nested = (script) => `${shell} -c '${script}'`;

  assert.deepEqual(await redirected(nested('find d -name f1 -exec echo hit {} \\; > out.txt'), 'out.txt'), ['', '', 0, 'hit d/f1\n'],
    `${shell}: find -exec writes where the script redirects find`);
  assert.deepEqual(await run(nested('find d -name f1 -exec echo hit {} \\; | cat -n')), ['     1\thit d/f1\n', '', 0],
    `${shell}: and into the pipe find writes to`);
  assert.deepEqual(await redirected(nested('find d -name f1 -exec sh -c "echo err >&2" \\; 2> err.txt'), 'err.txt'), ['', '', 0, 'err\n'],
    `${shell}: and its stderr where find's goes`);
  assert.deepEqual(await run(nested('cd d && find . -name f2 -execdir pwd \\;')), ['/tmp/io/d\n', '', 0],
    `${shell}: from the directory the script has moved to`);

  assert.deepEqual(await redirected(nested('sudo -u user echo x > s.txt'), 's.txt'), ['', '', 0, 'x\n'], `${shell}: sudo writes where the script redirects it`);
  assert.deepEqual(await run(nested('sudo -u user echo x | cat -n')), ['     1\tx\n', '', 0], `${shell}: and into its pipe`);
  assert.deepEqual(await run(nested('echo in | sudo -u user cat')), ['in\n', '', 0], `${shell}: and reads the pipe into it`);
  assert.deepEqual(await run(nested('export FOO=bar; sudo -u user env | grep ^FOO=')), ['FOO=bar\n', '', 0], `${shell}: with the script's environment`);
}

// Typed at the workspace's shell, the same holds.
assert.deepEqual(await redirected('find d -name f1 -exec echo hit {} \\; > out2.txt', 'out2.txt'), ['', '', 0, 'hit d/f1\n']);
assert.deepEqual(await run('sudo -u user echo x | cat -n'), ['     1\tx\n', '', 0]);

await ws.close();
console.log('run-as-io: a runAs child inherits its starter\'s descriptors, environment and directory');
