#!/usr/bin/env bun
// A lifo CommonJS command's process.stdout is a Writable over its output,
// as a node program's is, and a pipe into it leaves it open, as Node's pipe
// leaves process.stdout: the command writes on after. The command runs in
// the shell's realm, whose engine's pipe knows only the host's own stdout.
// And createProcess's stdout and stderr are in its emitted type, for a
// TypeScript consumer of the public module.
//
// Red before: the pipe ended the command's stdout, and its next write failed
// (ERR_STREAM_WRITE_AFTER_END); stdout and stderr were not in the type.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  await ws.fs.mkdir('/home/user/pkg', { recursive: true });
  await ws.fs.writeFile('/home/user/pkg/pipe.js', `
const { Readable } = require('stream');
module.exports = async () => {
  await new Promise((resolve) => Readable.from(['piped\\n']).pipe(process.stdout).on('unpipe', resolve));
  await new Promise((resolve, reject) => process.stdout.write('after\\n', (error) => (error ? reject(error) : resolve())));
  return 0;
};
`);
  ws.registry.register('pipe', createLifoCommand('/home/user/pkg/pipe.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
  const r = await ws.exec('pipe', { cwd: '/home/user' });
  assert.deepEqual([r.exitCode, r.stdout, r.stderr], [0, 'piped\nafter\n', '']);
} finally {
  await ws.close();
}

const declared = readFileSync(new URL('../../packages/core/dist/substrate/lifo/node-compat/process.d.ts', import.meta.url), 'utf8');
assert.match(declared, /get stdout\(\): Writable;/, 'createProcess(...).stdout is typed');
assert.match(declared, /get stderr\(\): Writable;/, 'createProcess(...).stderr is typed');
console.log('lifo-command-stdout: ok');
