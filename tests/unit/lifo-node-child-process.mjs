#!/usr/bin/env bun
// lifo's node runs the shared child_process (node-compat/child_process.ts)
// with no start face until its realm can wait for a child (Kinu ask 67,
// Phase A): every start is refused as Node reports a spawn the system cannot
// make, the 'error' event with ENOSYS and 'close' with its negative errno,
// and exec's callback has that error. Before, its stub said "requires shell
// interpreter" and threw from spawn. The synchronous forms refuse as the
// hosted node's do.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
const program = `
const cp = require('child_process');
const out = {};
cp.exec('echo hi', (error, stdout, stderr) => {
  out.exec = { code: error && error.code, syscall: error && error.syscall, cmd: error && error.cmd, stdout, stderr };
  const child = cp.spawn('ls', ['-l']);
  child.on('error', (e) => { out.spawnError = { code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, spawnargs: e.spawnargs }; });
  child.on('close', (code, signal) => {
    out.close = [code, signal];
    try { cp.execSync('true'); } catch (e) { out.execSync = e.code; }
    console.log(JSON.stringify(out));
  });
});
`;
try {
  await ws.fs.writeFile('/home/user/children.js', program);
  const ran = await ws.exec('cd /home/user && node children.js');
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), {
    exec: { code: 'ENOSYS', syscall: 'spawn /bin/sh', cmd: 'echo hi', stdout: '', stderr: '' },
    spawnError: { code: 'ENOSYS', errno: -38, syscall: 'spawn ls', path: 'ls', spawnargs: ['-l'] },
    close: [-38, null],
    execSync: 'ERR_NIMBUS_SYNC_CHILD_PROCESS',
  });
} finally {
  await ws.close();
}
console.log('lifo-node-child-process: lifo\'s node refuses a child ENOSYS, as Node reports a spawn it cannot make');
