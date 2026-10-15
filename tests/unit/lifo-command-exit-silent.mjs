#!/usr/bin/env bun
// A lifo CommonJS command that calls process.exit(n) ends with status n and
// writes nothing for it, as a node program does: real Node is the oracle.
//
// Red before: a non-zero exit wrote `[process.exit] code=n` on the
// command's stderr.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const PROGRAM = "process.stdout.write('before\\n'); process.exit(3);";
const node = spawnSync('node', ['-e', PROGRAM], { encoding: 'utf8' });
assert.equal(node.error, undefined, 'real node runs');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  await ws.fs.mkdir('/home/user/pkg', { recursive: true });
  await ws.fs.writeFile('/home/user/pkg/quit.js', `module.exports = () => { ${PROGRAM} };\n`);
  ws.registry.register('quit', createLifoCommand('/home/user/pkg/quit.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
  const r = await ws.exec('quit', { cwd: '/home/user' });
  assert.deepEqual([r.exitCode, r.stdout, r.stderr], [node.status, node.stdout, node.stderr], 'what node prints, and its status');
} finally {
  await ws.close();
}
console.log('lifo-command-exit-silent: ok');
